#!/usr/bin/env node
// terminal-demo helper (#16): the native side of the /terminal demo.
//
// Run it in your working folder, pick that folder in the demo page, get a
// shell — sandboxed to that folder (profile.ts). This is demo-specific
// code consuming @fsio/host as a library; the generic CLI lives in
// packages/host/src/fsio-host.ts.
//
// Usage:  fsio-terminal-helper [dir]     (default: current directory)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { profileSummary, type SandboxConfig } from "@fsio/confine";
import { HostServer, type PtyModule } from "@fsio/host";
import { SHELL_PROFILE } from "./profile.js";
import { sandboxedPty } from "./sandbox.js";

const fail = (msg: string): never => {
  console.error(`fsio terminal-demo: ${msg}`);
  process.exit(1);
};

// ---- preconditions (#16 ledger: Mac-only, real pty or refuse)

if (process.platform !== "darwin") {
  fail(`this demo is macOS-only (sandbox-exec confinement); got ${process.platform}`);
}

// node-pty is a HARD dependency here (unlike @fsio/host, where it is
// optional): a terminal demo on the pipe fallback demos badly — no
// readline, no colors, no vim. Refuse loudly instead.
const realPty = (await import("node-pty").catch((e: unknown) =>
  fail(`node-pty failed to load (${e instanceof Error ? e.message : e}) — the demo needs a real pty. Try reinstalling.`)
)) as PtyModule;

// ---- the shared folder

const rootArg = process.argv[2];
if (rootArg?.startsWith("-")) fail(`unknown flag ${rootArg} — usage: fsio-terminal-helper [dir]`);
const root = path.resolve(rootArg ?? process.cwd());
if (rootArg) fs.mkdirSync(root, { recursive: true });
const rootReal = fs.realpathSync(root);

// F9: FileSystemObserver dies with InvalidModificationError under /tmp —
// a demo run from there looks broken in ways nobody would connect to the
// folder choice. Refuse rather than warn; the whole point is a working folder.
const tmpReal = fs.realpathSync(os.tmpdir());
if (rootReal.startsWith("/private/tmp") || rootReal.startsWith(tmpReal)) {
  fail(`refusing to run under a temp dir (${rootReal}) — Chrome's file observers break there (F9). Use a real working folder.`);
}

// ---- host, with the sandboxed pty injected (D14)

const line = (tag: string, a: unknown[]) => console.log(new Date().toISOString(), ...(tag ? [tag] : []), ...a);
const log = {
  info: (...a: unknown[]) => line("", a),
  warn: (...a: unknown[]) => line("[warn]", a),
  error: (...a: unknown[]) => line("[error]", a),
};

const fsioDir = path.join(rootReal, ".fsio");
const profilePath = path.join(fsioDir, "sandbox.sb");
const cfg: SandboxConfig = { profilePath, root: rootReal, fsio: fsioDir, tmp: tmpReal };
const pty = sandboxedPty(realPty, cfg);

// Shell hygiene inside the sandbox (found by the S4 cooperative loop,
// first real spawn): Apple's /etc/zshrc_Apple_Terminal writes session-
// restore files into ~/.zsh_sessions at startup — denied by the profile,
// which zsh escalates into a confusing "override rw-------?" prompt. And
// history files in $HOME would die the same way at exit. Point both
// somewhere harmless instead of widening the write wall: demo shells are
// ephemeral by design (arguably a feature — they leave no trace).
process.env["SHELL_SESSIONS_DISABLE"] = "1";
process.env["HISTFILE"] = path.join(tmpReal, "fsio-terminal-demo-history");

// Same treatment for the agent CLI (#18's act), and here the stakes are
// higher than a history file. Measured under this exact profile: with the
// default `~/.claude`, the run **exits 0 with a correct answer** while its
// transcript writes are denied. Nothing surfaces — the loss is
// discovered later, when resume finds no session. "A broken confinement
// must look broken" applies to state placement too, so this is a fix and
// not a nicety.
//
// Placement, not a carve-out: fix the friction in the child's environment,
// never by widening the wall. TMP over
// the field test's in-folder `$PWD/.claude-demo`, which would litter the
// user's working folder, land in their repo, and be co-tenant-readable
// (D20) — and this demo promises the folder back pristine on exit.
// One flat dir is enough: the CLI partitions transcripts by workspace
// itself (`projects/<ws>/`).
//
// Interim, deliberately. The destination (#86) is a host-owned slot
// `~/.fsio/state/<workspace>/<service>/`, which needs #71 and a profile
// carve exactly that wide. Note also what placement does NOT move: the
// credential lives in the login Keychain, reached by mach-lookup —
// allowed here only because this profile is `allow default`. A deny-default
// profile would log the child out no matter where its state sits.
process.env["CLAUDE_CONFIG_DIR"] = path.join(tmpReal, "fsio-terminal-demo-agent-state");

const server = new HostServer({
  root: rootReal,
  // The sandbox is the gate; the policy only narrates (#16 ledger: no y/N
  // prompt — it allows everything a default --allow-shell host would).
  // `origin` is advisory (D15): display is exactly its job.
  onSpawnRequest: (_spec, info) => {
    log.info(`● page connected — origin: ${info.origin ?? "(none reported)"} · ${info.kind}${info.cmd ? ` (${info.cmd})` : ""}`);
    return true;
  },
  fresh: true, // demo restarts should never inherit stale sessions
  pty,
  logger: log,
});

// The live-host refusal (#40 — e.g. a second helper on the same folder)
// is an operator message, not a crash: no stack, just the reason.
await server.start().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));

// The profile lands inside .fsio AFTER start() (fresh wipes it) and BEFORE
// any session can spawn (scan hasn't run a shell yet — spawns need a
// browser). Written by the helper, unwritable by the shells it confines.
fs.writeFileSync(profilePath, SHELL_PROFILE);

// ---- preflight: prove the whole chain (sandbox-exec + profile compiles +
// pty + spawn-helper exec bit) before telling the user anything is ready.
// A profile syntax error should fail HERE, not in the first session.
await new Promise<void>((resolve, reject) => {
  let out = "";
  const p = pty.spawn("/bin/sh", ["-c", "echo __FSIO_SANDBOX_OK__"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: rootReal,
    env: process.env,
  });
  p.onData((d) => (out += d));
  p.onExit(({ exitCode }) => {
    if (exitCode === 0 && out.includes("__FSIO_SANDBOX_OK__")) resolve();
    else reject(new Error(`preflight shell failed (exit ${exitCode}): ${out.trim()}`));
  });
  setTimeout(() => reject(new Error("preflight timed out (5s)")), 5000).unref();
}).catch(async (e: Error) => {
  await server.close();
  fs.rmSync(fsioDir, { recursive: true, force: true });
  fail(e.message);
});

// ---- banner: the second UI surface — it carries the "what next" and the
// safety framing (#16 storyboard, Frame 2).

// The safety sentence comes from @fsio/confine rather than being written
// here, and it is longer than the line it replaced on purpose: the old one
// said "sandboxed… network on; writes outside denied" and never mentioned
// that reads are unbounded, which is the half the threat model makes a
// MUST. `/private/tmp` is named because it is a real hole outside the
// folder; the profile's other carve, `/dev/tty`, is the terminal the user is
// already looking at, so naming it would be noise rather than disclosure.
const folderName = path.basename(rootReal);
console.log(`
fsio terminal demo · serving ${rootReal}
  shells are confined to this folder:
    ${profileSummary(folderName, ["/private/tmp"])}
  The whole policy is .fsio/sandbox.sb — read it from the folder itself.

  → back in the demo page, pick the folder:  ${folderName}

waiting for a browser… (Ctrl-C stops the helper and cleans up .fsio; a page
  that self-reported leaves its report in .fsio/client/)
`);

// ---- teardown: close sessions, then leave the folder pristine (D6: the
// host owns .fsio cleanup; #16 ledger: exit = working folder back to
// normal) — with one exception the host does not own. A page's self-report
// under .fsio/client/ is the page's, and this demo's page is verified by
// the manual loop, where Ctrl-C is both the end of the run and the reading
// of its verdicts (#109). Sweeping them here would make the folder pristine
// by destroying the only record of what the run proved.

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  console.log(`\n${signal} — closing sessions…`);
  await server.close();
  server.cleanServiceDir(true);
  const clientDir = path.join(fsioDir, "client");
  const reports = fs.existsSync(clientDir) ? fs.readdirSync(clientDir).length : 0;
  console.log(reports ? `done; .fsio swept, ${reports} page report${reports === 1 ? "" : "s"} kept in .fsio/client/.` : "done; .fsio removed.");
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
