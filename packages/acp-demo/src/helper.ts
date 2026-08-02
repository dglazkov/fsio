#!/usr/bin/env node
// acp-demo helper (#18): the native side of the /acp demo.
//
// Run it in your working folder, pick that folder in the demo page, and the
// page becomes an ACP client driving a real coding agent — the agent's
// stdio riding DATA frames over the filesystem, no server, no websocket, no
// extension. The agent's permission prompts arrive as page UI.
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
import { AGENTS, installLine, roster, type AgentEntry, type RosterEntry } from "./agents.js";
import { agentDir, confirm, installAgent } from "./install.js";
import { DEFAULT_PAGE, launchUrl } from "./launch.js";
import { hasClientDirs, openInChromium, pageIsWatching } from "./open.js";
import { agentProfile } from "./profile.js";

const fail = (msg: string): never => {
  console.error(`fsio acp-demo: ${msg}`);
  process.exit(1);
};

// ---- args

const USAGE = "usage: fsio-acp-demo [dir] [--no-sandbox] [--fixture] [--agent <name>] [--no-open] [--url <base>]";

let rootArg: string | null = null;
let wantSandbox = true;
let wantFixture = false;
/** The helper opens the page (#124). `--no-open` prints the URL and stops
 *  there — for anyone driving this from a script, over ssh, or who simply
 *  does not want a tab. The URL is printed either way. */
let wantOpen = true;
/** Where the page lives. Overridable so `npm run dev`'s vite server is one
 *  flag away rather than a code edit. */
let urlArg: string | null = null;
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
  else if (a === "--no-open") wantOpen = false;
  else if (a === "--url") {
    urlArg = argv[++i] ?? null;
    if (!urlArg) fail(`--url needs a base URL — ${USAGE}`);
  } else if (a.startsWith("--url=")) urlArg = a.slice("--url=".length);
  else if (a === "--agent") {
    agentArg = argv[++i] ?? null;
    if (!agentArg) fail(`--agent needs a name — ${USAGE}`);
  } else if (a.startsWith("--agent=")) agentArg = a.slice("--agent=".length);
  else if (a.startsWith("-")) fail(`unknown flag ${a} — ${USAGE}`);
  else rootArg = a;
}
if (wantFixture && agentArg) fail(`--fixture and --agent are two ways to say the same thing; pick one — ${USAGE}`);

// Checked here rather than at the moment of opening: a typo in `--url`
// should not be discovered after a successful start, by a browser that
// silently did not appear.
const pageBase = urlArg ?? process.env["FSIO_ACP_URL"] ?? DEFAULT_PAGE;
try {
  new URL(pageBase);
} catch {
  fail(`--url ${JSON.stringify(pageBase)} is not a URL — ${USAGE}`);
}

// The sandbox is the demo's safety sentence, so running without it is a
// thing you have to say out loud — and the page is told (`sandboxed: false`
// in the spawn result, D13 extra fields). Never silently unconfined.
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
// Interim, deliberately, exactly as terminal-demo's placement is: the
// destination is a host-owned slot `~/.fsio/state/<workspace>/<service>/`,
// which needs #71 and a profile carve exactly that wide. What matters
// already is that state is *placed* and not carved out of $HOME, and
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
  // Asking is the entire reason it exists: 5 permission asks and 10 `fs/*`
  // calls across the scripted run, measured in test-fixture-agent.ts.
  asks: true,
  state: {
    mode: "place",
    env: "FSIO_FIXTURE_STATE",
    why: "the puppet keeps no state; a placed dir it never writes to leaves the profile with no carve at all.",
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

/** Paths in human output are $HOME-relative: `~/.fsio/agents/x` is a thing
 *  someone can read at a glance and retype, and it is the same string on
 *  every machine, which matters for a line whose whole job is to be copied
 *  back out as an undo. */
const tilde = (p: string): string => (p.startsWith(os.homedir() + path.sep) ? `~${p.slice(os.homedir().length)}` : p);

// An empty roster is NOT a startup failure any more (#102).
//
// It used to be: no agent on PATH, print the catalogue, exit 1. That put
// the one message a newcomer most needs to read in the one place they are
// least likely to be looking — a terminal that has already quit, before the
// page they were sent to has loaded anything. The text was always written
// for a human; it was going to the wrong surface.
//
// So the helper serves an empty roster and the page renders it. The install
// wall has since become a question rather than a wall (#124, install.ts) —
// but only one asked in the terminal, only when the scan came back empty,
// and `N` is still a supported answer, so this path is exactly as live as it
// was.
const rosterNow = (): RosterEntry[] => roster(catalogue);

// ---- host

const line = (tag: string, a: unknown[]) => console.log(new Date().toISOString(), ...(tag ? [tag] : []), ...a);
const log = {
  info: (...a: unknown[]) => line("", a),
  warn: (...a: unknown[]) => line("[warn]", a),
  error: (...a: unknown[]) => line("[error]", a),
};

const fsioDir = path.join(rootReal, ".fsio");

// Read before the host's `fresh` sweep empties it, because the sweep is what
// makes the reading afterwards mean something (#124, open.ts): a client dir
// that comes *back* is a live page saying so. No client dirs here now means
// no page has ever reported into this folder, so there is nobody to wait for
// and a first run opens its tab immediately.
const folderHasSeenAPage = hasClientDirs(fsioDir);

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
  // which the page deliberately does not persist browser-side because
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

// ---- the install question (#124)
//
// Asked here and nowhere else: after everything that can fail fast has
// failed, before the banner, and only when the scan came back empty. The
// human is in this terminal — they typed the command a moment ago — which is
// the one moment the question can be both timely and seen. Every other
// surface is worse: a prompt raised later would fire behind a browser window
// nobody is looking at, and the page must never trigger an install at all
// (install.ts says why at length).
//
// `N` is the default and a first-class answer. The helper serves an empty
// roster perfectly well (#102), the page renders the install card, and the
// roster rescan above picks up a manual install with no restart.
const offerable = catalogue.find((a) => a.recommended && a.pkg) ?? catalogue.find((a) => a.pkg);
if (!wantFixture && offerable && !rosterNow().some((a) => a.installed)) {
  const dest = agentDir(offerable.name);
  const yes = await confirm(`
!! no ACP agent on this machine.

   install ${offerable.title}?
     ${offerable.pkg!.name}@${offerable.pkg!.version}  →  ${tilde(dest)}
     ~293 MB; no install scripts are run; nothing is put on your PATH
     ${offerable.asks ? "it asks before it edits, which is the part of this demo worth watching" : "it edits with its own hands — no permission card"}
     undo:  rm -rf ${tilde(dest)}
     pinned on purpose: this helper's sandbox profile was measured against
     that exact version (F30), so "latest" is the wrong thing to install —
     and it does mean the copy ages until somebody bumps it here.

   Or answer n and install it yourself, any way you like:  ${installLine(offerable)}

   install it? [y/N] `);
  if (yes) {
    console.log(`   installing ${offerable.pkg!.name}@${offerable.pkg!.version}…`);
    const res = await installAgent(offerable);
    // A failed install is not a failed helper. The roster stays empty, the
    // page still shows the card, and npm's own words are printed rather than
    // paraphrased — a registry outage, a proxy and a full disk all read the
    // same once somebody summarizes them.
    if (res.ok) {
      console.log(`   installed → ${tilde(res.dir)}`);
      publishRoster();
    } else {
      console.log(`   install failed; carrying on without it:\n${res.error}`);
    }
  }
}

// ---- banner: the second UI surface — what to do next, and the honest
// safety sentence (it is a *write* wall; reads and network are not
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
      ? // Which copy, every time (#124). Two can exist — a PATH install and
        // one under ~/.fsio/agents — and a demo that silently drove the
        // other one is a debugging trap that looks like a version bug.
        `agents available here: ${installed.map((a) => `${a.name}${a.via === "fsio" ? " (~/.fsio/agents)" : ""}`).join(", ")}${
          missing.length ? `\n  also known, not installed:\n` + missing.map(offer).join("\n") : ""
        }`
      : `!! no ACP agent here. The helper is running anyway — the page shows this
  same list and updates itself when one appears, so you can install without
  restarting anything:\n\n` +
        missing.map(offer).join("\n") +
        // 293 MB / 111 packages measured 2026-08-02 against
        // claude-agent-acp@0.64.2 (install.ts). The old ~118 MB figure was
        // the deprecated Zed adapter's, and it had outlived the package it
        // described.
        `\n\n  fsio ships none of them on purpose (#100): vendoring one costs ~293 MB of
  transitive dependencies, and an agent you installed is one you can also
  inspect, update, and revoke.`
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

  in the page: pick this folder — ${folderName} — and allow it twice. Those
  clicks are Chrome's and cannot be automated (F15); they are also the whole
  security model, so they are the three gestures worth keeping.

(Ctrl-C ends the agents and sweeps .fsio; the newest ${TRANSCRIPT_KEEP} conversations
  are kept in .fsio/transcripts/, and a page that self-reported leaves its
  report in .fsio/client/)
`);

// ---- open the page (#124)
//
// Printed before it is opened, always: the human ran `npx`, they did not ask
// to be sent to a remote address, and a URL that appears without warning is
// a surprise even when it is the one they wanted.
//
// The hints are what this helper already knows and the page would otherwise
// interview someone for (launch.ts) — the folder to pick, and the agent it
// would drive when there is exactly one. Both are advisory. Neither is read
// for anything: the handle still comes from the picker and the roster still
// rides the folder.
const soleAgent = rosterNow().filter((a) => a.installed);
const pageUrl = launchUrl(pageBase, {
  dir: folderName,
  agent: soleAgent.length === 1 ? soleAgent[0]!.name : null,
});
console.log(`  ${pageUrl}\n`);

if (!wantOpen) {
  console.log("--no-open: opening nothing. Paste that into a Chromium browser.\n");
} else if (folderHasSeenAPage && (await pageIsWatching(fsioDir))) {
  // A restarted helper whose page never went away. Opening here is how you
  // end up with five tabs after five Ctrl-Cs, and the page has already
  // reconnected by itself — there is nothing for a new tab to do.
  console.log("a page is already open on this folder — not opening another tab.\n");
} else {
  const res = await openInChromium(pageUrl);
  console.log(res.opened ? `opened in ${res.browser}.\n` : `${res.why} — open that URL yourself, in Chrome or another Chromium.\n`);
}

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
