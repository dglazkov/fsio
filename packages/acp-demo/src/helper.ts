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
// Usage:  fsio-acp-demo [dir] [--no-sandbox]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { sandboxArgv } from "@fsio/confine";
import { HostServer } from "@fsio/host";
import { acpKind } from "./acp-kind.js";
import { AGENTS, roster, type AgentEntry, type RosterEntry } from "./agents.js";
import { agentProfile } from "./profile.js";

const fail = (msg: string): never => {
  console.error(`fsio acp-demo: ${msg}`);
  process.exit(1);
};

// ---- args

const USAGE = "usage: fsio-acp-demo [dir] [--no-sandbox] [--fixture] [--agent <name>]";

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
  install: "(built with this repo; re-run the helper with --fixture)",
  // Asking is the entire reason it exists (F29: 5 asks, 10 `fs/*`).
  asks: true,
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

/** The catalogue line for one agent: what it is, and how to get it. */
const offer = (a: RosterEntry): string => `    ${a.name.padEnd(17)} ${a.title}\n      ${a.install}`;

// An empty roster is NOT a startup failure any more (#102).
//
// It used to be: no agent on PATH, print the catalogue, exit 1. That put
// the one message a newcomer most needs to read in the one place they are
// least likely to be looking — a terminal that has already quit, before the
// page they were sent to has loaded anything. The text was always written
// for a human; it was going to the wrong surface.
//
// So the helper serves an empty roster and the page renders it. The install
// wall does not disappear — nothing here can install an agent for anyone
// (P3/P5: a distinct rung wants a distinct gesture, and we are not the
// party that gets to make it) — it just stops being a process that quit.
const rosterNow = (): RosterEntry[] => roster(catalogue);

// ---- host

const line = (tag: string, a: unknown[]) => console.log(new Date().toISOString(), ...(tag ? [tag] : []), ...a);
const log = {
  info: (...a: unknown[]) => line("", a),
  warn: (...a: unknown[]) => line("[warn]", a),
  error: (...a: unknown[]) => line("[error]", a),
};

const fsioDir = path.join(rootReal, ".fsio");

/** How many ended conversations `.fsio/transcripts/` holds (#119, D26 rule
 *  4). Ten is a demo's worth of history against a directory the human owns
 *  and did not ask to become an archive; the host's byte cap can cut it
 *  shorter, never longer. */
const TRANSCRIPT_KEEP = 10;
const server = new HostServer({
  root: rootReal,
  // The sandbox and the allow-list are the gates; the policy narrates.
  // `origin` is advisory (D15): display is exactly its job.
  onSpawnRequest: (spec, info) => {
    log.info(`● page connected — origin: ${info.origin ?? "(none reported)"} · ${info.kind}${spec["agent"] ? ` (${String(spec["agent"])})` : ""}`);
    return true;
  },
  fresh: true, // demo restarts should never inherit stale sessions
  // …but a restart must not eat the conversations either (#119). `fresh`
  // is right that a session pointing at a dead pid is not attachable and
  // right to sweep the plumbing; it was wrong that the out log is plumbing.
  // For this demo that file IS the conversation — the agent's half of it,
  // which D32 rule 2 deliberately does not persist browser-side because
  // "it rode the folder, so the folder is where it is read back from"
  // (P2). The folder now keeps its side of that bargain.
  //
  // The count is stated here rather than inherited because the banner
  // promises it out loud, and a promise about the user's own project
  // directory is not a thing to leave to a default two packages away.
  transcripts: { keep: TRANSCRIPT_KEEP },
  // This demo serves exactly one kind and it is not `shell`; a pty would
  // never be reached. Saying so keeps the npx artifact (which bundles no
  // node_modules) from opening with advice about a package nobody here needs.
  pty: false,
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

// ---- the roster (#102): what this machine can serve, where the page can
// see it.
//
// It rides the service directory as the `acp` kind's embedder `detail`
// (D31), which means the page learns it on the same `services.json` read it
// already does to check the kind exists — no second file, no second poll,
// no second doorbell. Before this, the ONLY channel by which roster
// knowledge reached the browser was a spawn failure: naming an agent that
// is not there got you a refusal that listed the alternatives. That is a
// chooser you have to break something to open.
const publishRoster = (): void => void server.setServices({ kindDetail: { acp: { agents: rosterNow() } } });
publishRoster();

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
    server.cleanServiceDir();
    fail(e.message);
  });
  fs.rmSync(probePath, { force: true });
}

// Re-scan on a slow timer so an agent installed *while the page is sitting
// on the install card* shows up there without restarting anything. The scan
// is a few `access()` calls, and `setServices` is content-diffed: a scan
// that finds nothing new writes nothing and moves no revision (D24), so the
// page's cached copy stands until there is genuinely news.
const rosterTimer = setInterval(publishRoster, 3000);

// ---- banner: the second UI surface — what to do next, and the honest
// safety sentence (F24: it is a *write* wall; reads and network are not
// bounded, and saying otherwise would be the dishonest version).

const folderName = path.basename(rootReal);
const startupRoster = rosterNow();
const installed = startupRoster.filter((a) => a.installed);
const missing = startupRoster.filter((a) => !a.installed);
console.log(`
fsio ACP demo · serving ${rootReal}${
  wantFixture
    ? `
  !! --fixture: this is a PUPPET, not an agent. It calls no model and thinks
  nothing. It asks permission and has no hands: every file it reads or writes
  goes through the page. It exists to make the permission card and the fs/*
  handlers actually run (#100).
    try:  "go"        propose an edit, ask, write when you allow it
          "refuse"    reach outside the folder and read the refusals back
          "many"      three separate asks in one turn
          "read"      a read, which needs no card — you granted the folder
          "markdown"  what the page renders, and the four things it won't`
    : ""
}
  ${
    installed.length
      ? `agents available here: ${installed.map((a) => a.name).join(", ")}${
          missing.length ? `\n  also known, not installed:\n` + missing.map(offer).join("\n") : ""
        }`
      : `!! no ACP agent on your PATH. The helper is running anyway — the page will
  show you this same list and update itself when one appears, so you can
  install without restarting anything:\n\n` +
        missing.map(offer).join("\n") +
        `\n\n  fsio ships none of them on purpose (#100): vendoring an adapter costs
  ~118 MB of transitive dependencies, and an agent you installed is one you
  can also inspect, update, and revoke.`
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

waiting for a browser… (Ctrl-C ends the agents and sweeps .fsio; what each
  conversation said is kept in .fsio/transcripts/, newest ${TRANSCRIPT_KEEP},
  and a page that self-reported leaves its report in .fsio/client/)
`);

// ---- teardown: close sessions (which kills agents), then sweep the
// plumbing (D6: the host owns .fsio cleanup) and keep the two things that
// are not the host's to throw away — the conversations (#119, D26 rule 4)
// and the pages' own reports (#109). Ctrl-C ends the agents either way —
// they are our children and no amount of retention makes a live one
// survive it. What it no longer ends is the record of what they said, or
// the verdicts of the run that was watching them.

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  clearInterval(rosterTimer);
  console.log(`\n${signal} — closing sessions…`);
  await server.close();
  // `keepClient`: this demo's verification is manual by construction (its
  // page needs a real picker and a real agent, so no rig drives it), which
  // makes Ctrl-C both the end of the run and — until #109 — the deletion of
  // its evidence. The page's report is the page's.
  server.cleanServiceDir(true);
  const kept = fs.existsSync(server.transcriptsDir) ? fs.readdirSync(server.transcriptsDir).length : 0;
  const clientDir = path.join(fsioDir, "client");
  const reports = fs.existsSync(clientDir) ? fs.readdirSync(clientDir).length : 0;
  const left = [
    kept ? `${kept} conversation${kept === 1 ? "" : "s"} in .fsio/transcripts/` : "",
    reports ? `${reports} page report${reports === 1 ? "" : "s"} in .fsio/client/` : "",
  ].filter(Boolean);
  console.log(left.length ? `done; .fsio swept, ${left.join(" and ")} kept.` : "done; .fsio removed.");
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
