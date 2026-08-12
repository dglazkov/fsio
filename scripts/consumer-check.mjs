// Install the three library artifacts the way a project outside this
// repository installs them, then compile and run against them (#224).
//
// This exists because the artifact branches do not exist until a change is on
// `main`: the `artifact` job in ci.yml is gated on a push to main, so a PR that
// breaks packaging is green right up to the moment it merges and someone
// installs the result. Staging the same directories CI would commit and
// installing *those* is the only gate available before then.
//
// What it is actually testing, in the order the failures would bite:
//
//   1. The `exports` map resolves, and the files a consumer needs are in the
//      package. A typo is invisible in this repository, where every consumer
//      is a workspace sibling resolving through node_modules symlinks.
//   2. **One @fsio/common, not two.** Both halves declare the same branch for
//      it precisely so npm dedupes to a single copy. If that ever becomes two,
//      `RpcError` is two classes and `FrameType` two enums, `instanceof`
//      quietly returns false, and nothing else looks wrong.
//   3. The types compile in a consumer's project rather than in ours — with
//      this repository's tsconfig.base.json nowhere in scope, so a surface that
//      only typechecks under our own compiler options fails here. It compiles
//      with `types: []`, which is what caught @fsio/host's public .d.ts
//      referencing `NodeJS.ProcessEnv`.
//
// **The packages are packed into tarballs and installed from those**, which is
// what a `github:` dependency effectively is. The first version installed the
// staged directories with `file:` specifiers instead, and that quietly tested
// nothing: npm links a `file:` dependency without installing *its*
// dependencies, so `@fsio/common` sat UNMET under both halves while `npm
// install` reported success and exited 0. Point 2 above — the reason this
// script is worth its runtime — was passing because the test project happened
// to declare @fsio/common itself. Tarballs resolve transitively and dedupe, the
// way the real install does.
//
// The one substitution: each half's `@fsio/common` specifier is rewritten from
// `github:dglazkov/fsio#common` to the packed local tarball before packing,
// because the branch is either absent (before this lands) or a previous build.
//
// Not checked: that the artifact branches install *from GitHub*. That needs
// them to exist, so it is only observable after a merge.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["common", "client", "host"];
const staged = (p) => join(repo, "packages", p, "artifact-dist");

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf8" });

// Stage each artifact exactly as CI would.
for (const p of PACKAGES) run("npm", ["run", "-w", `packages/${p}`, "bundle"], repo);

const proj = mkdtempSync(join(tmpdir(), "fsio-consumer-"));
let failed = false;
try {
  // Copy aside before touching anything: artifact-dist/ is what CI commits,
  // and this check must not be able to change it.
  const src = join(proj, "src");
  const tgzDir = join(proj, "tgz");
  mkdirSync(tgzDir, { recursive: true });
  for (const p of PACKAGES) cpSync(staged(p), join(src, p), { recursive: true });

  const pack = (dir) => {
    const before = new Set(readdirSync(tgzDir));
    run("npm", ["pack", dir, "--pack-destination", tgzDir], proj);
    const made = readdirSync(tgzDir).find((f) => !before.has(f));
    if (!made) throw new Error(`npm pack produced nothing for ${dir}`);
    return join(tgzDir, made);
  };

  const commonTgz = pack(join(src, "common"));
  for (const p of ["client", "host"]) {
    const manifest = join(src, p, "package.json");
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (!pkg.dependencies?.["@fsio/common"]) {
      throw new Error(`packages/${p}'s artifact manifest does not declare @fsio/common — both halves must, so npm resolves one copy`);
    }
    pkg.dependencies["@fsio/common"] = `file:${commonTgz}`;
    writeFileSync(manifest, JSON.stringify(pkg, null, 2) + "\n");
  }

  // Only the two halves. @fsio/common is deliberately NOT declared here: it has
  // to arrive as their shared transitive dependency, which is the arrangement
  // under test.
  writeFileSync(
    join(proj, "package.json"),
    JSON.stringify(
      {
        name: "fsio-consumer-check",
        private: true,
        type: "module",
        dependencies: { "@fsio/client": `file:${pack(join(src, "client"))}`, "@fsio/host": `file:${pack(join(src, "host"))}` },
      },
      null,
      2
    )
  );

  run("npm", ["install", "--no-package-lock", "--no-audit", "--no-fund"], proj);

  // `npm ls` exits non-zero on an unmet dependency, which is how the file:
  // version of this script was silently passing. Run it for the exit code.
  run("npm", ["ls", "--all"], proj);

  const installed = readdirSync(join(proj, "node_modules", "@fsio"));
  for (const p of PACKAGES) {
    if (!installed.includes(p)) throw new Error(`@fsio/${p} is not in the consumer's node_modules (got: ${installed.join(", ")})`);
  }
  // Hoisted to the root, not nested under one half: nested means two copies.
  for (const half of ["client", "host"]) {
    const nested = join(proj, "node_modules", "@fsio", half, "node_modules");
    let has = [];
    try {
      has = readdirSync(nested);
    } catch {
      /* no nested node_modules is the expected case */
    }
    if (has.length) throw new Error(`@fsio/${half} has its own nested node_modules (${has.join(", ")}) — @fsio/common did not dedupe`);
  }

  // A consumer's own tsconfig, sharing nothing with ours. DOM is present
  // because a real consumer's browser half has it; `types: []` keeps @types/node
  // out, so anything of ours that leaks a Node global into the public surface
  // fails here rather than in their editor.
  writeFileSync(
    join(proj, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          types: [],
          noEmit: true,
          skipLibCheck: false,
        },
        include: ["use.ts"],
      },
      null,
      2
    )
  );

  // Both halves in one file, with values crossing between them: a SessionStatus
  // the client receives is the shape the host publishes, and both sides name
  // the type from the same @fsio/common. Two copies make this a type error even
  // where the runtime assertions below would still pass.
  writeFileSync(
    join(proj, "use.ts"),
    `import { FsioClient, type FsioSession } from "@fsio/client";
import { HostServer, type SessionInfo } from "@fsio/host";
import { RpcError, RpcErrors, type SessionStatus, type SpawnSpec } from "@fsio/common";

export function describe(status: SessionStatus, info: SessionInfo): string {
  return status.state + " " + info.phase;
}

export function open(client: FsioClient, spec: SpawnSpec): FsioSession {
  return client.createSession(spec, { pollMs: 15 });
}

export function denied(err: unknown): boolean {
  return err instanceof RpcError && err.code === RpcErrors.SPAWN_DENIED;
}

export type Embedder = ConstructorParameters<typeof HostServer>[0];
`
  );

  run(join(repo, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], proj);

  mkdirSync(join(proj, "run"), { recursive: true });
  writeFileSync(
    join(proj, "run.mjs"),
    `import assert from "node:assert/strict";
import { RpcError as ViaClient, FrameType as FrameViaClient, FsioClient } from "@fsio/client";
import { RpcError as Direct, FrameType as FrameDirect } from "@fsio/common";
import { HostServer } from "@fsio/host";

assert.equal(ViaClient, Direct, "two copies of @fsio/common: RpcError identity differs");
assert.equal(FrameViaClient, FrameDirect, "two copies of @fsio/common: FrameType identity differs");
assert.equal(typeof FsioClient, "function");
assert.equal(typeof HostServer, "function");

// The host has to actually run, not merely import: a start/close round trip is
// what proves the artifact is a working library and not just a parseable one.
const host = new HostServer({ root: process.argv[2] });
await host.start();
assert.equal(host.listSessions().length, 0);
await host.close();

console.log("ok");
`
  );

  const out = run(process.execPath, [join(proj, "run.mjs"), join(proj, "run")], proj);
  if (out.trim() !== "ok") throw new Error(`unexpected runtime output: ${out}`);

  console.log("consumer check: @fsio/common + @fsio/client + @fsio/host install as one project, compile, and run");
} catch (err) {
  failed = true;
  const detail = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message;
  console.error("consumer check FAILED\n");
  console.error(detail);
} finally {
  rmSync(proj, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
