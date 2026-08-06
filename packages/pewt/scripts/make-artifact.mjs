// Assemble the installable `pewt` artifact (#181), on terminal-demo's
// #16 S5 template: esbuild-bundle the built CLI into one file, pair it with
// artifact/{package.json,postinstall.mjs}, and stage everything in
// artifact-dist/ for CI to commit to the `pewt` branch.
//
// Unlike the two demo artifacts, this one is not an `npx` one-shot. It is a
// **dependency**: a pewter declares `"pewt": "github:dglazkov/fsio#pewt"`,
// which is what stops `npm install` from deleting it (#181 — npm prunes
// anything in node_modules that no dependency declares, and the two packages
// used to be bare symlinks). That is also why the `artifact` job keeps
// history now: the pewter's lockfile pins one of these commits by sha.
//
// What stays external, and why each one:
//
//   node-pty   a native addon — pty.node and spawn-helper must exist on
//              disk. Optional, so a machine without a build still gets the
//              pipe fallback, and host-server.ts's `import(specifier)`
//              indirection already keeps esbuild from trying to trace it.
//   esbuild    also ships a platform binary, and `pewt` shells out to it to
//              bundle a pewter's extensions. Bundling the JS API in would
//              leave the binary behind and break every extension.
//   pewter     the API package, distributed on its own branch. Keeping it
//              external is a deliberate departure from "everything of ours
//              bundles in", and the reason is type identity: `pewt check`
//              compiles a pewter's extensions against node_modules/pewter's
//              .d.ts, while `pewt` itself handles the values at runtime. One
//              copy that npm is responsible for cannot drift; two copies can
//              drift silently, and `pewt check` passing while the host
//              rejects the same call is exactly the first-hour failure this
//              issue is about.
//
// @fsio/{common,client,host} bundle in. They are this repository's own
// libraries, they have no native half, and nothing outside pewt resolves
// them from a pewter.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(pkgRoot, "artifact-dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(pkgRoot, "dist/cli.js")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["node-pty", "esbuild", "pewter"],
  outfile: join(out, "cli.js"),
  // No shebang here: dist/cli.js already carries one and esbuild hoists it
  // above the banner, so writing a second produces a file node refuses to
  // parse.
  banner: {
    js: "// pewt — generated bundle; source: packages/pewt (github.com/dglazkov/fsio)",
  },
  logLevel: "warning",
});

// Version: base from the template, prerelease tag from the commit — so a
// colleague's `npm ls` names the exact build they're running.
const pkg = JSON.parse(readFileSync(join(pkgRoot, "artifact/package.json"), "utf8"));
const sha = (process.env.GITHUB_SHA ?? execSync("git rev-parse HEAD", { cwd: pkgRoot }).toString().trim()).slice(0, 12);
pkg.version = `0.0.0-${sha}`;
writeFileSync(join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
cpSync(join(pkgRoot, "artifact/postinstall.mjs"), join(out, "postinstall.mjs"));

console.log(`artifact-dist/ ready (version ${pkg.version})`);
