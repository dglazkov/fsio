#!/usr/bin/env node
// Read-wall lab (#90, the leg the service and agent labs left open — #86's
// open question 4).
//
// The confinement lab priced what the shipped wall does NOT hold: it is a
// WRITE wall, and a
// confined child reads every file the user can read. #86 lists "does the read
// wall exist, and what does it cost" as the open question where the acts
// collide — act 1/2 want read-the-world (that is what makes a shell and an
// installed agent work), act 3 makes reads the exfiltration path (the brain is
// remote by design), season two makes reads the whole risk. Nobody has
// measured the cost, so the argument has been conducted entirely on adjectives.
//
// This lab isolates exactly one variable. Every width below is the SHIPPED
// profile (read from packages/terminal-demo/src/profile.ts, so the lab tracks
// the real posture) plus a read wall of increasing width. W0 is the shipped
// posture unchanged; W1..W3 differ from it only in what they may READ.
//
// Method, same as the service lab: start from nothing and add only rules a
// MEASURED denial
// demanded, reading denials from the unified log (SBPL `(trace)` no longer
// produces a file on current macOS). Every rule below the divider in W2/W3 got
// there because a battery cell failed without it — the count is the honest
// price of the wall, and the placement of each rule is the honest answer to
// "what does the toolchain make you hand over."
//
// Subject: the workload act 3 is actually about — a page-hosted agent loop
// calling `npm test` / `git` / a compiler in a workspace. No model quota, no
// browser, no grant, no human.
//
// Usage:
//   node scripts/read-wall-lab.mjs [--widths W0,W1,W2,W3] [--keep]
//        (~2 min; network during setup only, to populate the workspace)
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shippedShellProfile } from "./shipped-profile.mjs";

if (process.platform !== "darwin") {
  console.log("read-wall-lab: Seatbelt is macOS-only; nothing to measure here.");
  process.exit(0);
}

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const WIDTHS = arg("widths", "W0,W1,W2,W3").split(",");
const KEEP = argv.includes("--keep");

const home = os.homedir();
const tilde = (p) => String(p).replace(home, "~");
const NODE = process.execPath;
const NODEDIR = path.dirname(path.dirname(NODE)); // e.g. ~/.nvm/versions/node/vX

const lab = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fsio-readwall-lab-")));
const ws = path.join(lab, "ws");
const fsioDir = path.join(ws, ".fsio");
const realTmp = fs.realpathSync(os.tmpdir());
fs.mkdirSync(fsioDir, { recursive: true });

// The shipped demo posture, imported so this lab measures exactly what
// ships (see scripts/shipped-profile.mjs; needs `npm run build`).
const SHIPPED = await shippedShellProfile();

// ------------------------------------------------------------------ workspace
// A workspace shaped like the thing an agent loop is asked to work in: a git
// repo with a dependency, a compiler, and a test.
console.log("setting up the workspace (network, setup only — not part of the measurement)…");
fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({
  name: "readwall-subject", private: true, version: "0.0.0", type: "module",
  scripts: { build: "tsc --noEmit", test: "node --test" },
}, null, 2) + "\n");
fs.writeFileSync(path.join(ws, "index.ts"), "export const add = (a: number, b: number): number => a + b;\n");
fs.writeFileSync(path.join(ws, "index.test.mjs"), `import { test } from "node:test";
import assert from "node:assert";
test("arithmetic still works", () => assert.equal(1 + 1, 2));
`);
try {
  execFileSync("npm", ["i", "--silent", "--no-audit", "--no-fund", "typescript"], { cwd: ws, stdio: "pipe" });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws, stdio: "pipe" });
  execFileSync("git", ["add", "-A"], { cwd: ws, stdio: "pipe" });
} catch (e) {
  console.error("workspace setup failed:", e.message);
  process.exit(1);
}
// npm ci wants a lockfile and a clean tree; keep a pristine copy to restore.
const modulesBackup = path.join(lab, "node_modules.bak");
fs.cpSync(path.join(ws, "node_modules"), modulesBackup, { recursive: true });

// -------------------------------------------------------------------- widths
// Each width is SHIPPED + a read wall. `(deny file-read*)` lands after the
// shipped body, so last-match-wins puts the re-allows below it (the same
// ordering discipline profile.ts documents).
//
// Rule provenance: every line in W2/W3 arrived from a battery failure under the
// width above it. The comments name which cell demanded it.
const READ_WALL_HEAD = `
;; ---------------------------------------------------------------- read wall
;; Everything above is the shipped posture (a write wall). Below is the
;; only variable this lab changes.
(deny file-read*)

;; The workspace and scratch — the reach the act itself needs.
(allow file-read* (subpath (param "ROOT")))
(allow file-read* (subpath (param "TMP")))
(allow file-read* (subpath "/private/tmp"))
`;

const W2_TOOLCHAIN = `
;; --- toolchain reach (each rule from a measured denial) ---
;; node itself: the interpreter and its bundled libs. NOTE where this lives —
;; a version manager puts the runtime UNDER $HOME, so "deny $HOME" and "run
;; node" are not independent knobs.
(allow file-read* (subpath "${NODEDIR}"))
;; the system: dyld cache, shared libs, ICU/tz data, the /usr/bin shims.
(allow file-read* (subpath "/usr/lib") (subpath "/usr/share") (subpath "/usr/bin"))
(allow file-read* (subpath "/bin") (subpath "/sbin") (subpath "/usr/sbin"))
(allow file-read* (subpath "/System"))
(allow file-read* (subpath "/Library"))
;; git: /usr/bin/git is a shim that execs into the developer-tools bundle.
(allow file-read* (subpath "/Applications/Xcode.app"))
;; the timezone database (node's ICU reads it at startup) and the tty a tool
;; checks to decide whether it is interactive.
(allow file-read* (subpath "/private/var/db/timezone"))
(allow file-read-data (regex #"^/dev/tty"))
;; metadata (stat/access) is not readable content and is assumed by every
;; path-walk in every tool; denying it breaks resolution, not confidentiality.
(allow file-read-metadata)
;; the root directory itself: every absolute path walk reads it, and denying
;; it aborts the process before main() with no error text at all (SIGABRT).
(allow file-read-data (literal "/"))
(allow file-read-data (literal "/dev/urandom") (literal "/dev/random")
                      (literal "/dev/null") (literal "/dev/dtracehelper"))
(allow sysctl-read)
(allow user-preference-read)
`;

const W3_USER_STATE = `
;; --- the user's own state that the toolchain demands BY NAME (measured) ---
;; This block is the interesting one: it is the part of $HOME a read wall
;; cannot hold if "run my tests" is to mean anything.
;; git's identity — without it, git status and git commit both die with
;; "unable to access '~/.gitconfig': Operation not permitted".
(allow file-read* (literal "${path.join(home, ".gitconfig")}"))
(allow file-read* (subpath "${path.join(home, ".config/git")}"))
;; npm's cache — an offline install reads package bodies out of _cacache, so
;; this is not an optimization the wall can decline.
(allow file-read* (subpath "${path.join(home, ".npm")}"))
(allow file-read* (literal "${path.join(home, ".npmrc")}"))
`;

const WIDTH_DEFS = {
  W0: { title: "shipped posture — no read wall (control)", body: SHIPPED },
  W1: { title: "read wall: the workspace and scratch, nothing else", body: SHIPPED + READ_WALL_HEAD },
  W2: { title: "W1 + the toolchain (node, system, developer tools)", body: SHIPPED + READ_WALL_HEAD + W2_TOOLCHAIN },
  W3: { title: "W2 + the user state the toolchain names", body: SHIPPED + READ_WALL_HEAD + W2_TOOLCHAIN + W3_USER_STATE },
};
const ruleCount = (s) =>
  s.split("\n").filter((l) => l.trim().startsWith("(allow") || l.trim().startsWith("(deny")).length;

// ------------------------------------------------------------------ battery
// What an agent loop is asked to do in a workspace. Each is a separate spawn,
// because that is how a tool call arrives (R7: per spawn, machine frequency).
const BATTERY = [
  { name: "node runs", cmd: `"${NODE}" --version` },
  { name: "read the workspace", cmd: `"${NODE}" -e 'require("fs").readFileSync("index.ts")'` },
  { name: "compile (tsc)", cmd: `"${NODE}" node_modules/typescript/bin/tsc --noEmit index.ts` },
  { name: "run tests", cmd: `"${NODE}" --test index.test.mjs` },
  { name: "git status", cmd: "git status --porcelain" },
  { name: "git commit (identity)", cmd: 'git commit -q -m probe --allow-empty && git log -1 --format=%an' },
  { name: "npm ci --offline", cmd: "npm ci --offline --no-audit --no-fund --silent" },
];

// The crown jewels: what the wall is FOR. Probed from inside each width by
// the child itself, so the answer is the child's, not the harness's.
const JEWELS = [
  ["~/.ssh (private keys)", `require("fs").readdirSync(process.env.HOME+"/.ssh")`],
  ["~/.aws, ~/.config (secrets dirs)", `require("fs").readdirSync(process.env.HOME+"/.config")`],
  ["~/Documents (sibling projects)", `require("fs").readdirSync(process.env.HOME+"/Documents")`],
  ["/etc/passwd", `require("fs").readFileSync("/etc/passwd")`],
  ["~/.gitconfig (identity)", `require("fs").readFileSync(process.env.HOME+"/.gitconfig")`],
  ["~/.npmrc + ~/.npm (registry auth, cache)", `require("fs").readdirSync(process.env.HOME+"/.npm")`],
  ["the workspace itself", `require("fs").readFileSync(${JSON.stringify(path.join(ws, "index.ts"))})`],
];

/** `log show --start` parses LOCAL time — an ISO/UTC stamp silently returns
 *  nothing, which reads exactly like "no denials" (the agent lab's method
 *  trap). */
const logStamp = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** Bounded on BOTH ends, with a quiet gap between widths — and that is not
 *  fussiness. A whole width runs in ~3 s, so the first version's unbounded
 *  `--start` (and then its ±2 s padding) let one width's denials be reported
 *  under the next: ~/.gitconfig showed as denied in W3, where git demonstrably
 *  worked, and `/dev/dtracehelper` carried the running total (×47, then ×97).
 *  `log show` stamps have one-second resolution, so the gap must exceed it.
 *  Same class as the agent lab's local-time trap and F16's focus emulation:
 *  an instrument
 *  that fails toward a plausible answer. Each window is printed with its width
 *  so the artifact can be audited rather than trusted. */
const denialsBetween = (t0, t1) =>
  new Promise((res) => {
    execFile("/usr/bin/log",
      ["show", "--start", t0, "--end", t1, "--style", "compact", "--predicate",
       'eventMessage CONTAINS "Sandbox: " AND eventMessage CONTAINS "deny("'],
      { maxBuffer: 256 * 1024 * 1024 },
      (e, out) => {
        const seen = new Map();
        for (const l of (out ?? "").split("\n")) {
          const m = l.match(/Sandbox: (\S+)\(\d+\) deny\((\d)\) (\S+)\s*(.*)$/);
          if (!m) continue;
          const key = `${m[3]} ${m[4].trim()}`;
          if (!seen.has(key)) seen.set(key, { proc: m[1], op: m[3], target: m[4].trim(), n: 0 });
          seen.get(key).n++;
        }
        res([...seen.values()]);
      });
  });

const run = (profilePath, shellCmd, timeout = 120000) =>
  new Promise((res) => {
    execFile("/usr/bin/sandbox-exec",
      ["-f", profilePath, "-D", `ROOT=${ws}`, "-D", `FSIO=${fsioDir}`, "-D", `TMP=${realTmp}`,
       "/bin/sh", "-c", shellCmd],
      { cwd: ws, timeout, maxBuffer: 32 * 1024 * 1024 },
      (e, out, err) => res({ code: e ? (e.code ?? "ERR") : 0, out: String(out), err: String(err) }));
  });

/** Restore the workspace between cells: npm ci deletes node_modules, and a
 *  failed cell must not hand the next one a broken tree. */
function resetWorkspace() {
  fs.rmSync(path.join(ws, "node_modules"), { recursive: true, force: true });
  fs.cpSync(modulesBackup, path.join(ws, "node_modules"), { recursive: true });
}

// --------------------------------------------------------------------- cells
const results = [];
for (const w of WIDTHS) {
  const def = WIDTH_DEFS[w];
  if (!def) { console.error(`unknown width ${w}`); continue; }
  const profilePath = path.join(lab, `${w}.sb`);
  fs.writeFileSync(profilePath, def.body);

  console.log(`\n${"=".repeat(74)}`);
  console.log(`=== ${w} — ${def.title}   (${ruleCount(def.body)} rules)`);
  await new Promise((r) => setTimeout(r, 10000)); // quiet gap; see denialsBetween
  const t0 = logStamp(new Date());

  const cells = [];
  for (const b of BATTERY) {
    resetWorkspace();
    const r = await run(profilePath, b.cmd);
    const ok = r.code === 0;
    const why = ok ? "" : (r.err || r.out).trim().replace(/\s+/g, " ").slice(0, 96);
    console.log(`  ${(ok ? "ok  " : "FAIL")}  ${b.name.padEnd(22)} ${why}`);
    cells.push({ name: b.name, ok, why });
  }

  console.log(`  --- what this width can still reach ---`);
  const jewels = [];
  for (const [label, expr] of JEWELS) {
    const r = await run(profilePath, `"${NODE}" -e '${expr}' 2>&1`, 20000);
    // A width that cannot run node at all cannot be probed from inside it;
    // say so rather than reporting a false "denied".
    const reachable = r.code === 0;
    const unprobeable = !reachable && !/EPERM|ENOENT|Operation not permitted/.test(r.out + r.err);
    console.log(`    ${unprobeable ? "??       " : reachable ? "reachable" : "DENIED   "}  ${label}`);
    jewels.push({ label, reachable, unprobeable });
  }

  // Kernel Sandbox entries are stamped when they FLUSH, not when the denial
  // happened, and the lag runs to several seconds. So the window has to be
  // held open past the width and the next width has to start well after it —
  // a width takes ~2 s, and without this the lag alone decides which width a
  // denial is filed under. Measured: 8 s of settle is enough to catch a
  // denial the child reported synchronously (git's EPERM on ~/.gitconfig).
  await new Promise((r) => setTimeout(r, 8000));
  const t1 = logStamp(new Date());
  const den = await denialsBetween(t0, t1);
  console.log(`  --- denials logged (${den.length} distinct)  [${t0} .. ${t1}] ---`);
  for (const d of den.slice(0, 20)) {
    console.log(`    ${d.op.padEnd(18)} ${tilde(d.target).slice(0, 82)}${d.n > 1 ? `  ×${d.n}` : ""}`);
  }
  if (den.length > 20) console.log(`    … and ${den.length - 20} more`);
  if (!den.length) console.log("    (none)");

  results.push({ w, title: def.title, rules: ruleCount(def.body), cells, jewels, denials: den.length });
}

// ------------------------------------------------------------------- summary
console.log(`\n${"=".repeat(74)}\n=== summary — what a read wall costs\n`);
const pad = (s, n) => String(s).padEnd(n);
console.log(`  ${pad("", 42)}${results.map((r) => pad(r.w, 10)).join("")}`);
for (const b of BATTERY) {
  const row = results.map((r) => pad(r.cells.find((c) => c.name === b.name)?.ok ? "ok" : "FAIL", 10)).join("");
  console.log(`  ${pad(b.name, 42)}${row}`);
}
console.log("");
for (const [label] of JEWELS) {
  const row = results.map((r) => {
    const j = r.jewels.find((x) => x.label === label);
    return pad(j?.unprobeable ? "??" : j?.reachable ? "reachable" : "denied", 10);
  }).join("");
  console.log(`  ${pad(label, 42)}${row}`);
}
console.log("");
console.log(`  ${pad("profile size (rules)", 42)}${results.map((r) => pad(r.rules, 10)).join("")}`);
console.log(`  ${pad("distinct denials", 42)}${results.map((r) => pad(r.denials, 10)).join("")}`);

if (KEEP) console.log(`\n  profiles + workspace kept at ${lab}`);
else fs.rmSync(lab, { recursive: true, force: true });
