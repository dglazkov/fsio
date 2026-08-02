#!/usr/bin/env node
// Agent-reach lab (#90, act 2 / #18) — what a real agent CLI touches under
// confinement, and whether R17's host-owned slot actually works.
//
// This is the deliberate re-run of the organic field test in
// https://github.com/dglazkov/fsio/issues/18#issuecomment-5119402080, where
// the claude CLI's ~/.claude writes were denied by Seatbelt, surfaced in the
// agent's own UI, and were fixed by REDIRECTING state (CLAUDE_CONFIG_DIR)
// rather than by carving the wall. That accident produced "placement over
// denial" (R4/R17); this lab measures it on purpose.
//
// Instrument: the unified log (SBPL `(trace)` no longer produces a file on
// current macOS), same as the confinement and service labs. Nothing reads
// any credential's contents:
// the lab reports which PATHS appeared and their sizes, never bytes.
//
// Method note for the finding: the subject and the harness are the same
// program (a Claude Code session driving a nested claude CLI). The wall is
// Seatbelt, not the parent, so this does not affect the measurement — but it
// is recorded here the way F16's focus-emulation trap is.
//
// Usage:
//   node scripts/agent-reach-lab.mjs --workspace <dir> [--config <dir>]
//        [--slot <dir>] [--cells 0,A,Ap,At,B,C] [--model haiku]
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shippedShellProfile } from "./shipped-profile.mjs";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

if (process.platform !== "darwin") {
  console.log("agent-reach-lab: Seatbelt is macOS-only.");
  process.exit(0);
}

const WS = fs.realpathSync(arg("workspace", path.join(os.homedir(), "Documents/code/fun/fsio-test")));
const CONFIG = path.resolve(WS, arg("config", ".claude-demo"));
const SLOT = arg("slot", path.join(os.homedir(), ".fsio/state", path.basename(WS), "claude"));
const MODEL = arg("model", "haiku");
const CELLS = arg("cells", "0,A,Ap,At,B,C").split(",");
const CLAUDE = arg("claude", path.join(os.homedir(), ".local/bin/claude"));
const home = os.homedir();
const tilde = (p) => String(p).replace(home, "~");

// The shipped demo posture, imported so this lab measures exactly what
// ships (see scripts/shipped-profile.mjs; needs `npm run build`).
const SHIPPED = await shippedShellProfile();

const labTmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fsio-agent-lab-")));
const fsioDir = path.join(WS, ".fsio");
fs.mkdirSync(fsioDir, { recursive: true });
const realTmp = fs.realpathSync(os.tmpdir());

/** Profile variants. `slotCarve` is R17: open exactly the host-owned slot. */
function writeProfile(name, { slotCarve = false, noKeystore = false } = {}) {
  let body = SHIPPED;
  if (noKeystore) {
    // Does the child's identity come from the OS keystore rather than from
    // any directory a profile can place? The service lab's posture is
    // deny-default, so it denies every mach-lookup by construction; this
    // clause isolates that one variable against the working cell A.
    body += `
(deny mach-lookup)
`;
  }
  if (slotCarve) {
    body += `
;; R17: the child's state lives in a host-owned slot, and the profile's job
;; is to open exactly that slot — not $HOME, not the user's dotfiles.
(allow file-read* (subpath (param "SLOT")))
(allow file-write* (subpath (param "SLOT")))
`;
  }
  const p = path.join(labTmp, `${name}.sb`);
  fs.writeFileSync(p, body);
  return p;
}

/** Recursive path+size snapshot; never reads file contents. */
function snapshot(root) {
  const out = new Map();
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out.set(p + "/", -1); walk(p); }
      else { try { out.set(p, fs.statSync(p).size); } catch { out.set(p, -2); } }
    }
  };
  walk(root);
  return out;
}
const diffSnap = (before, after) => {
  const added = [], changed = [];
  for (const [p, size] of after) {
    if (!before.has(p)) added.push([p, size]);
    else if (before.get(p) !== size) changed.push([p, before.get(p), size]);
  }
  return { added, changed };
};

/** `log show --start` parses LOCAL time. Passing an ISO/UTC stamp puts the
 *  window hours in the future and returns nothing — which reads exactly like
 *  "no denials". Cost: one round of cells that all reported 0. */
const logStamp = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const denialsSince = (t0) =>
  new Promise((res) => {
    execFile("/usr/bin/log",
      ["show", "--start", t0, "--style", "compact", "--predicate", 'eventMessage CONTAINS "Sandbox: " AND eventMessage CONTAINS "deny("'],
      { maxBuffer: 128 * 1024 * 1024 },
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

const MINIMAL_ENV_KEYS = ["PATH", "HOME", "TERM", "LANG", "USER", "LOGNAME", "SHELL", "TMPDIR"];

async function cell({ name, title, profile, configDir, env, prompt, tools }) {
  console.log(`\n${"=".repeat(72)}\n=== cell ${name} — ${title}`);
  const watched = [...new Set([configDir, SLOT].filter(Boolean))];
  const before = watched.map((w) => [w, snapshot(w)]);
  const t0 = logStamp(new Date(Date.now() - 2000));

  const args = ["-p", prompt, "--model", MODEL];
  if (tools) args.push("--allowedTools", tools);
  const file = profile ? "/usr/bin/sandbox-exec" : CLAUDE;
  const argsFull = profile
    ? ["-f", profile, "-D", `ROOT=${WS}`, "-D", `FSIO=${fsioDir}`, "-D", `TMP=${realTmp}`,
       ...(profile.includes("slot") ? ["-D", `SLOT=${SLOT}`] : []), CLAUDE, ...args]
    : args;

  const t = Date.now();
  const child = spawn(file, argsFull, { cwd: WS, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const code = await new Promise((res) => {
    const to = setTimeout(() => { child.kill("SIGKILL"); res("TIMEOUT"); }, 120000);
    child.on("exit", (c) => { clearTimeout(to); res(c); });
    child.on("error", (e) => { clearTimeout(to); err += String(e); res("SPAWN-ERROR"); });
  });
  const secs = ((Date.now() - t) / 1000).toFixed(1);

  console.log(`  exit ${code} in ${secs}s`);
  console.log(`  stdout: ${out.trim().replace(/\s+/g, " ").slice(0, 160) || "(empty)"}`);
  if (err.trim()) console.log(`  stderr: ${err.trim().replace(/\s+/g, " ").slice(0, 240)}`);

  for (const [w, snap] of before) {
    const { added, changed } = diffSnap(snap, snapshot(w));
    if (added.length || changed.length) {
      console.log(`  wrote under ${tilde(w)}: ${added.length} new, ${changed.length} changed`);
      for (const [p, s] of added.slice(0, 8)) console.log(`     + ${tilde(p).replace(tilde(w), "")}${s >= 0 ? ` (${s} B)` : ""}`);
      for (const [p] of changed.slice(0, 6)) console.log(`     ~ ${tilde(p).replace(tilde(w), "")}`);
    } else if (fs.existsSync(w)) {
      console.log(`  wrote under ${tilde(w)}: nothing`);
    }
  }

  const den = await denialsSince(t0);
  console.log(`  denials (${den.length} distinct):`);
  for (const d of den.slice(0, 25)) console.log(`     ${d.op.padEnd(20)} ${tilde(d.target).slice(0, 84)}${d.n > 1 ? `  ×${d.n}` : ""}`);
  if (!den.length) console.log("     (none)");
  return { name, code, denials: den.length, out: out.trim().slice(0, 80) };
}

// ---------------------------------------------------------------- the cells
// METHOD TRAP, learned the hard way (and the F16 precedent applies): this
// lab's harness is itself a Claude Code session, which exports 8 CLAUDE_*
// markers (CLAUDECODE, CLAUDE_CODE_CHILD_SESSION, …). Inherited, they steer
// the subject — the first A' run wrote nothing to ~/.claude and produced
// zero denials, i.e. the harness had silently changed the thing being
// measured. Every cell therefore starts from a harness-scrubbed environment,
// and only vars the cell sets deliberately come back.
const HARNESS_PREFIXES = [/^CLAUDE/, /^ANTHROPIC/];
const scrubbed = () => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (HARNESS_PREFIXES.some((r) => r.test(k))) delete e[k];
  return e;
};
const fullEnv = (extra) => ({ ...scrubbed(), ...extra });
const minimalEnv = (extra) => {
  const e = {};
  for (const k of MINIMAL_ENV_KEYS) if (process.env[k]) e[k] = process.env[k];
  return { ...e, ...extra };
};
const PROMPT = "Reply with exactly: ok";
const TOOL_PROMPT = "Use the Bash tool to run `ls` in the current directory, then reply with exactly: done";

const results = [];
const has = (c) => CELLS.includes(c);

if (has("0"))
  results.push(await cell({
    name: "0", title: "control — no sandbox, config dir in the workspace",
    profile: null, configDir: CONFIG, env: fullEnv({ CLAUDE_CONFIG_DIR: CONFIG }), prompt: PROMPT,
  }));

if (has("A"))
  results.push(await cell({
    name: "A", title: "shipped demo profile, config dir in the workspace (#18's fix, deliberate)",
    profile: writeProfile("demo"), configDir: CONFIG, env: fullEnv({ CLAUDE_CONFIG_DIR: CONFIG }), prompt: PROMPT,
  }));

if (has("Ap"))
  results.push(await cell({
    name: "A'", title: "shipped demo profile, DEFAULT config dir (~/.claude) — reproduces #18's accident",
    profile: writeProfile("demo"), configDir: path.join(home, ".claude"),
    env: fullEnv({}), prompt: PROMPT,
  }));

if (has("At"))
  results.push(await cell({
    name: "At", title: "cell A + the agent spawns a child (Bash ls) — transitivity on a real workload",
    profile: writeProfile("demo"), configDir: CONFIG, env: fullEnv({ CLAUDE_CONFIG_DIR: CONFIG }),
    prompt: TOOL_PROMPT, tools: "Bash(ls:*)",
  }));

if (has("Ak"))
  results.push(await cell({
    name: "Ak", title: "cell A + keystore blinded (deny mach-lookup) — is identity in the slot or in the OS?",
    profile: writeProfile("demo-nokeystore", { noKeystore: true }), configDir: CONFIG,
    env: fullEnv({ CLAUDE_CONFIG_DIR: CONFIG }), prompt: PROMPT,
  }));

if (has("B"))
  results.push(await cell({
    name: "B", title: "R17 — state in the host-owned slot, sandbox carve exactly that wide",
    profile: writeProfile("demo-slot", { slotCarve: true }), configDir: SLOT,
    env: fullEnv({ CLAUDE_CONFIG_DIR: SLOT }), prompt: PROMPT,
  }));

if (has("C"))
  results.push(await cell({
    name: "C", title: "cell A + synthesized minimal environment — which vars are load-bearing",
    profile: writeProfile("demo"), configDir: CONFIG,
    env: minimalEnv({ CLAUDE_CONFIG_DIR: CONFIG }), prompt: PROMPT,
  }));

console.log(`\n${"=".repeat(72)}\n=== summary\n`);
for (const r of results) console.log(`  cell ${r.name.padEnd(3)} exit ${String(r.code).padEnd(12)} ${String(r.denials).padStart(2)} distinct denials   ${r.out ? JSON.stringify(r.out.slice(0, 40)) : ""}`);
console.log(`\n  profiles: ${labTmp}`);
