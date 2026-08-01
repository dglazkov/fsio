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
import { AGENTS, resolveBin, type AgentEntry } from "./agents.js";
import { agentProfile } from "./profile.js";
import { sandboxArgv } from "./sandbox.js";

const fail = (msg: string): never => {
  console.error(`fsio acp-demo: ${msg}`);
  process.exit(1);
};

// ---- args

const USAGE = "usage: fsio-acp-helper [dir] [--no-sandbox] [--fixture] [--agent <name>]";

let rootArg: string | null = null;
let wantSandbox = true;
let wantFixture = false;
/** Narrow the allow-list to one entry. The page names no agent (it cannot
 *  know what is installed), so the kind takes the first one it can resolve —
 *  which makes "measure *this* agent" impossible once two are installed.
 *  This is the operator's say, and it stays an allow-list lookup: a name,
 *  never a path, same rule the wire follows. */
let agentArg: string | null = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--no-sandbox") wantSandbox = false;
  else if (a === "--fixture") wantFixture = true;
  else if (a === "--agent") {
    agentArg = argv[++i] ?? null;
    if (!agentArg) fail(`--agent needs a name — ${USAGE}`);
  } else if (a.startsWith("--agent=")) agentArg = a.slice("--agent=".length);
  else if (a.startsWith("-")) fail(`unknown flag ${a} — ${USAGE}`);
  else rootArg = a;
}
if (wantFixture && agentArg) fail(`--fixture and --agent are two ways to say the same thing; pick one — ${USAGE}`);

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

// `--fixture` swaps the whole allow-list for one scripted puppet (#100). It
// asks permission and has no hands: every file it touches travels as an
// `fs/*` request to the page. That makes the page's two never-fired paths
// exercisable with no agent installed, no credential, and no model quota —
// and identically on every run, which is what a browser loop needs to assert
// on. It is a test asset, so it says so in its own title.
const FIXTURE: AgentEntry = {
  name: "fixture",
  bin: process.execPath,
  args: [path.join(import.meta.dirname, "fixture-agent.js")],
  title: "PUPPET — a scripted test agent, not a real one",
  install: "(built with this repo)",
  state: {
    mode: "place",
    env: "FSIO_FIXTURE_STATE",
    why: "the puppet keeps no state; a placed dir it never writes to leaves the profile with no carve at all (R4/R17).",
  },
};

// `resolveBin` would happily resolve `process.execPath` and report the puppet
// "installed" even when its script is missing, so check the script itself.
if (wantFixture && !fs.existsSync(FIXTURE.args[0]!)) {
  fail(`--fixture: the puppet is not built (expected ${FIXTURE.args[0]}). Run \`npm run build\`.`);
}

if (agentArg && !AGENTS.some((a) => a.name === agentArg)) {
  fail(`--agent ${JSON.stringify(agentArg)}: this helper serves ${AGENTS.map((a) => a.name).join(", ")}`);
}

const catalogue: AgentEntry[] = wantFixture ? [FIXTURE] : agentArg ? AGENTS.filter((a) => a.name === agentArg) : AGENTS;
const installed = catalogue.filter((a) => resolveBin(a) !== null);
const missing = catalogue.filter((a) => resolveBin(a) === null);

/** The catalogue line for one agent: what it is, and how to get it. Shared
 *  by the startup failure and the banner so the two never drift. */
const offer = (a: AgentEntry): string => `    ${a.name.padEnd(17)} ${a.title}\n      ${a.install}`;

if (installed.length === 0) {
  fail(
    `no ACP agent found on PATH. This helper knows:\n\n` +
      AGENTS.map(offer).join("\n") +
      `\n\n  Install one and re-run. fsio ships none of them on purpose (#100):\n` +
      `  vendoring an adapter costs ~118 MB of transitive dependencies, and an\n` +
      `  agent you installed is one you can also inspect, update, and revoke.`
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
    // The page names an agent from this list or names none; either way the
    // wire never contributes a path (agents.ts). `--fixture` narrows the
    // list to one, so a page asking for "pi-acp" here is refused by the same
    // allow-list that refuses anything else it does not serve.
    agents: catalogue,
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
fsio ACP demo · serving ${rootReal}${
  wantFixture
    ? `
  !! --fixture: this is a PUPPET, not an agent. It calls no model and thinks
  nothing. It asks permission and has no hands: every file it reads or writes
  goes through the page. It exists to make the permission card and the fs/*
  handlers actually run (#100).
    try:  "go"      propose an edit, ask, write when you allow it
          "refuse"  reach outside the folder and read the refusals back
          "many"    three separate asks in one turn
          "read"    a read, which needs no card — you granted the folder`
    : ""
}
  agents available here: ${installed.map((a) => a.name).join(", ")}${
    missing.length ? `\n  also known, not installed:\n` + missing.map(offer).join("\n") : ""
  }
  ${
    wantSandbox
      ? `the agent is confined to this folder: it writes ${folderName}/ (never .fsio),
  one scratch dir, and its own state. It READS everything you can read and
  the network is open — ${wantFixture ? "though the puppet uses neither" : "its brain is remote"}. The exact policy is written to
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
