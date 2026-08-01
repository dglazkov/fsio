#!/usr/bin/env node
// acp-demo helper (#18): the native side of the /acp demo.
//
// Run it in your working folder, pick that folder in the demo page, and the
// page becomes an ACP client driving a real coding agent — the agent's
// stdio riding DATA frames over the filesystem, no server, no websocket, no
// extension. The agent's permission prompts arrive as page UI (R6).
//
// This is demo-specific code consuming @fsio/host as a library; the generic
// CLI lives in packages/host/src/fsio-host.ts, and the terminal demo (whose
// shape this follows) in packages/terminal-demo.
//
// Usage:  fsio-acp-helper [dir] [--no-sandbox]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { HostServer } from "@fsio/host";
import { acpKind } from "./acp-kind.js";
import { AGENTS, resolveBin } from "./agents.js";
import { agentProfile } from "./profile.js";
import { sandboxArgv } from "./sandbox.js";

const fail = (msg: string): never => {
  console.error(`fsio acp-demo: ${msg}`);
  process.exit(1);
};

// ---- args

let rootArg: string | null = null;
let wantSandbox = true;
for (const a of process.argv.slice(2)) {
  if (a === "--no-sandbox") wantSandbox = false;
  else if (a.startsWith("-")) fail(`unknown flag ${a} — usage: fsio-acp-helper [dir] [--no-sandbox]`);
  else rootArg = a;
}

// The sandbox is the demo's safety sentence, so running without it is a
// thing you have to say out loud — and the page is told (`sandboxed: false`
// in the spawn result, D13 extra fields). R3: never silently unconfined.
if (wantSandbox && process.platform !== "darwin") {
  fail(`confinement here is sandbox-exec (macOS); got ${process.platform}. Re-run with --no-sandbox to drive an UNCONFINED agent anyway.`);
}

// ---- the shared folder

const root = path.resolve(rootArg ?? process.cwd());
if (rootArg) fs.mkdirSync(root, { recursive: true });
const rootReal = fs.realpathSync(root);

// F9: FileSystemObserver dies with InvalidModificationError under /tmp — a
// demo run from there looks broken in ways nobody would connect to the
// folder choice. Refuse rather than warn.
const tmpReal = fs.realpathSync(os.tmpdir());
if (rootReal.startsWith("/private/tmp") || rootReal.startsWith(tmpReal)) {
  fail(`refusing to run under a temp dir (${rootReal}) — Chrome's file observers break there (F9). Use a real working folder.`);
}

// ---- the agent's two dirs outside the folder: scratch and placed state.
//
// Interim, deliberately, exactly as terminal-demo's placement is: R17's
// destination is the host-owned slot `~/.fsio/state/<workspace>/<service>/`,
// which needs #71 and a profile carve exactly that wide. What matters
// already is that state is *placed* and not carved out of $HOME (R4), and
// that the scratch dir the child gets as TMPDIR is ours, not the user's.
const demoDir = path.join(tmpReal, "fsio-acp-demo");
const scratch = path.join(demoDir, "scratch");
const stateRoot = path.join(demoDir, "state");
fs.mkdirSync(scratch, { recursive: true });
fs.mkdirSync(stateRoot, { recursive: true });
const scratchReal = fs.realpathSync(scratch);

// ---- which agents this machine can actually serve

const installed = AGENTS.filter((a) => resolveBin(a) !== null);
if (installed.length === 0) {
  fail(
    `no ACP agent found on PATH. This helper knows:\n` +
      AGENTS.map((a) => `    ${a.name.padEnd(18)} ${a.bin} — ${a.title}`).join("\n") +
      `\n  Install one (e.g. \`npm i -g pi-acp\`) and re-run.`
  );
}

// ---- host

const line = (tag: string, a: unknown[]) => console.log(new Date().toISOString(), ...(tag ? [tag] : []), ...a);
const log = {
  info: (...a: unknown[]) => line("", a),
  warn: (...a: unknown[]) => line("[warn]", a),
  error: (...a: unknown[]) => line("[error]", a),
};

const fsioDir = path.join(rootReal, ".fsio");
const server = new HostServer({
  root: rootReal,
  // The sandbox and the allow-list are the gates; the policy narrates.
  // `origin` is advisory (D15): display is exactly its job.
  onSpawnRequest: (spec, info) => {
    log.info(`● page connected — origin: ${info.origin ?? "(none reported)"} · ${info.kind}${spec["agent"] ? ` (${String(spec["agent"])})` : ""}`);
    return true;
  },
  fresh: true, // demo restarts should never inherit stale sessions
  logger: log,
});

server.registerKind(
  "acp",
  acpKind({
    root: rootReal,
    fsioDir,
    tmp: scratchReal,
    stateRoot,
    sandbox: wantSandbox,
  })
);

// The live-host refusal (#40 — e.g. a second helper on the same folder) is
// an operator message, not a crash: no stack, just the reason.
await server.start().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));

// ---- preflight: prove the chain (sandbox-exec present + the generated
// profile compiles) before telling the user anything is ready. A profile
// syntax error should fail HERE, not inside the first agent session.
if (wantSandbox) {
  const dir = path.join(fsioDir, "profiles");
  fs.mkdirSync(dir, { recursive: true });
  const probePath = path.join(dir, "preflight.sb");
  fs.writeFileSync(probePath, agentProfile({ stateDirs: [], agent: "preflight" }));
  const cfg = { profilePath: probePath, root: rootReal, fsio: fsioDir, tmp: scratchReal };
  const { file, args } = sandboxArgv(cfg, "/bin/sh", ["-c", "echo __FSIO_ACP_OK__"]);
  await new Promise<void>((resolve, reject) => {
    execFile(file, args, { cwd: rootReal, timeout: 5000 }, (err, stdout, stderr) => {
      if (!err && stdout.includes("__FSIO_ACP_OK__")) resolve();
      else reject(new Error(`sandbox preflight failed: ${(stderr || stdout || String(err)).trim()}`));
    });
  }).catch(async (e: Error) => {
    await server.close();
    fs.rmSync(fsioDir, { recursive: true, force: true });
    fail(e.message);
  });
  fs.rmSync(probePath, { force: true });
}

// ---- banner: the second UI surface — what to do next, and the honest
// safety sentence (F24: it is a *write* wall; reads and network are not
// bounded, and saying otherwise would be the dishonest version).

const folderName = path.basename(rootReal);
console.log(`
fsio ACP demo · serving ${rootReal}
  agents available here: ${installed.map((a) => a.name).join(", ")}
  ${
    wantSandbox
      ? `the agent is confined to this folder: it writes ${folderName}/ (never .fsio),
  one scratch dir, and its own state. It READS everything you can read and
  the network is open — its brain is remote. The exact policy is written to
  .fsio/profiles/<session>.sb while a session runs.`
      : `!! --no-sandbox: the agent runs UNCONFINED — it can write anything you can.
  The page is told (the session header says so). Use this only for debugging.`
  }

  → back in the demo page, pick the folder:  ${folderName}

waiting for a browser… (Ctrl-C stops the helper and cleans up .fsio)
`);

// ---- teardown: close sessions (which kills agents), then leave the folder
// pristine (D6: the host owns .fsio cleanup).

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  console.log(`\n${signal} — closing sessions…`);
  await server.close();
  fs.rmSync(fsioDir, { recursive: true, force: true });
  console.log("done; .fsio removed.");
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
