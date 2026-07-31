#!/usr/bin/env node
// Child-confinement lab (#86, security track) — the measurement pass the
// profile-content design (#71 slice 3) is built on top of.
//
// #86 derived the profile mechanism's requirements from NARRATIVE.md's acts
// and left seven open questions, three of which it asked to settle by
// measurement rather than argument. Two of those are answerable with no
// browser, no grant, and no human: **is confinement transitive** (OQ6), and
// **what does a confined child actually still hold** (OQ4's read wall, plus
// the env-policy baseline).
//
// Method: the shipped profile (packages/terminal-demo/src/profile.ts) and
// the shipped argv shape (sandbox.ts `sandboxArgv` — same reasoning as D12's
// resolveShell sharing: measure the invocation sessions really use), a
// scratch ROOT, and a canary directory that appears in NO -D parameter.
// Every escape case asks one question: did a file appear at the canary path?
//
// Nothing sensitive is printed: read cases report open()-success and a byte
// count, never bytes, and paths are shown $HOME-relative.
//
// Usage: node scripts/confinement-lab.mjs             # ~30 s, no side effects
//        node scripts/confinement-lab.mjs --launchd   # + the two launchd
//            spawn-proxy cases (bootstraps a job into gui/$UID and boots it
//            out again; off by default because it mutates launchd state)
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const WITH_LAUNCHD = process.argv.includes("--launchd");

if (process.platform !== "darwin") {
  console.log("confinement-lab: Seatbelt is macOS-only; nothing to measure here.");
  process.exit(0);
}

// The profile as source, not as a copy: this lab must fail when the shipped
// posture changes, which is the point of pointing it at the real file.
const profileSrc = fs.readFileSync(path.join(REPO, "packages/terminal-demo/src/profile.ts"), "utf8");
const m = profileSrc.match(/export const SANDBOX_PROFILE = `([\s\S]*?)`;\n/);
if (!m) {
  console.error("confinement-lab: could not extract SANDBOX_PROFILE from profile.ts");
  process.exit(1);
}
const PROFILE = m[1];

const mk = (n) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), n)));
const root = mk("fsio-conf-root-");
const tmp = mk("fsio-conf-tmp-");
const outside = mk("fsio-conf-outside-");
const fsioDir = path.join(root, ".fsio");
fs.mkdirSync(fsioDir);
const profilePath = path.join(fsioDir, "sandbox.sb");
fs.writeFileSync(profilePath, PROFILE);
const home = os.homedir();
const tilde = (p) => p.replace(home, "~");

const run = (file, args, opts = {}) =>
  new Promise((res) => {
    execFile(file, args, { cwd: root, timeout: 30000, ...opts }, (err, stdout, stderr) =>
      res({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, out: ((stdout ?? "") + (stderr ?? "")).trim() })
    );
  });

/** Exactly what a terminal-demo session runs (sandbox.ts sandboxArgv). */
const sandboxed = (script, env) =>
  run(
    "/usr/bin/sandbox-exec",
    ["-f", profilePath, "-D", `ROOT=${root}`, "-D", `FSIO=${fsioDir}`, "-D", `TMP=${tmp}`, "/bin/sh", "-c", script],
    env ? { env } : {}
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const escapes = [];

async function escapeCase(name, script, { canary = null, settleMs = 0 } = {}) {
  const c = canary ?? path.join(outside, `canary-${++n}`);
  try { fs.unlinkSync(c); } catch {}
  const r = await sandboxed(script.replaceAll("$CANARY", c));
  if (settleMs) await sleep(settleMs);
  const escaped = fs.existsSync(c);
  escapes.push({ name, escaped, code: r.code, out: r.out });
  console.log(`  ${escaped ? "ESCAPED " : "confined"}  ${name}`);
  if (r.out) console.log(`            ${r.out.split("\n")[0].slice(0, 120)}`);
  try { fs.unlinkSync(c); } catch {}
}

console.log(`\n=== A. Is the wall transitive? (#86 OQ6) — canary lives outside every -D param\n`);

await escapeCase("1. direct child writes outside ROOT (baseline: the wall itself)", `/usr/bin/touch "$CANARY"`);
await escapeCase("2. grandchild — sh -c inside sh -c", `/bin/sh -c '/bin/sh -c "/usr/bin/touch \\"$CANARY\\""'`);
await escapeCase("3. depth 4 through another interpreter — perl → sh → sh → touch",
  `/usr/bin/perl -e 'system("/bin/sh", "-c", "/bin/sh -c \\"/usr/bin/touch $CANARY\\"")'`);
await escapeCase("4. detached child, parent exits before the write", `(/bin/sh -c 'sleep 1; /usr/bin/touch "$CANARY"' &) ; exit 0`, { settleMs: 3000 });
await escapeCase("5. re-enter sandbox-exec with a permissive profile (widen)",
  `/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/touch "$CANARY"`);
await escapeCase("6. re-enter sandbox-exec with the same profile, ROOT widened to /",
  `/usr/bin/sandbox-exec -f "${profilePath}" -D ROOT=/ -D FSIO="${fsioDir}" -D TMP="${tmp}" /usr/bin/touch "$CANARY"`);
// The safe direction matters for act 5 (the mirror hall): can a confined
// child narrow ITSELF, e.g. an fsio host running inside a sandbox that wants
// to apply a per-service profile to its own children?
const narrow = await sandboxed(
  `/usr/bin/sandbox-exec -p '(version 1)(deny default)' /usr/bin/true 2>&1; echo "rc=$?"`
);
console.log(`  ${narrow.out.includes("rc=0") ? "APPLIED " : "refused "}  7. re-enter sandbox-exec to NARROW itself (deny default)`);
console.log(`            ${narrow.out.split("\n")[0].slice(0, 120)}`);

if (WITH_LAUNCHD) {
  await escapeCase("8. launchctl submit — launchd spawns on the child's behalf",
    `/bin/launchctl submit -l fsio.conflab.submit -- /bin/sh -c '/usr/bin/touch "$CANARY"' 2>&1; echo "submit rc=$?"`,
    { settleMs: 3000 });
  const plist = path.join(root, "conflab.plist");
  const bootCanary = path.join(outside, "canary-boot");
  fs.writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>fsio.conflab.bootstrap</string>
<key>ProgramArguments</key><array><string>/usr/bin/touch</string><string>${bootCanary}</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>\n`
  );
  await escapeCase("9. launchctl bootstrap of a plist the child wrote INSIDE ROOT",
    `/bin/launchctl bootstrap gui/$(/usr/bin/id -u) "${plist}" 2>&1; echo "bootstrap rc=$?"`,
    { canary: bootCanary, settleMs: 3000 });
  await run("/bin/launchctl", ["bootout", `gui/${process.getuid()}/fsio.conflab.bootstrap`]);
  await run("/bin/launchctl", ["remove", "fsio.conflab.submit"]);
  const left = (await run("/bin/launchctl", ["list"])).out.split("\n").filter((l) => l.includes("fsio.conflab"));
  console.log(`  launchd jobs left behind: ${left.length ? left.join(" ") : "(none)"}`);
} else {
  console.log(`  (skipped: launchd spawn-proxy cases 8–9 — re-run with --launchd)`);
}

console.log(`\n=== B. What crosses the wall anyway: environment (#86 env-policy baseline)\n`);

// The falsifiable test #86 asks for: export canaries into the "daemon", then
// diff what the child actually received against what a policy would declare.
// Not "we intended to scrub" — the bytes the child got.
const canaryNames = ["FSIO_LAB_SECRET", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "ANTHROPIC_API_KEY"];
const parentEnv = { ...process.env };
for (const k of canaryNames) parentEnv[k] = `canary-${k.toLowerCase()}`;
const envOut = await sandboxed("/usr/bin/env", parentEnv);
const childEnv = Object.fromEntries(
  envOut.out.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
console.log(`  vars exported to the host: ${Object.keys(parentEnv).length}   vars the child received: ${Object.keys(childEnv).length}`);
console.log(`  canary secrets that reached the child: ${canaryNames.filter((k) => childEnv[k]).length}/${canaryNames.length}` +
  ` — ${canaryNames.filter((k) => childEnv[k]).join(", ") || "(none)"}`);
for (const k of ["SSH_AUTH_SOCK", "HOME", "SHELL", "TMPDIR", "NODE_OPTIONS", "DYLD_LIBRARY_PATH"]) {
  if (childEnv[k] !== undefined) console.log(`  inherited ${k} = ${tilde(childEnv[k])}`);
}
console.log(`  PATH entries inherited: ${(childEnv.PATH ?? "").split(":").filter(Boolean).length}` +
  `  (first: ${tilde((childEnv.PATH ?? "").split(":")[0] ?? "")})`);
const agent = await sandboxed("/usr/bin/ssh-add -l 2>&1 | /usr/bin/head -1", parentEnv);
console.log(`  ssh-agent reachable through the inherited socket: ${agent.out}`);

console.log(`\n=== C. What crosses the wall anyway: reads and egress (#86 OQ4)\n`);

const readTargets = [
  path.join(home, ".ssh/id_ed25519"),
  path.join(home, ".ssh/id_rsa"),
  path.join(home, ".aws/credentials"),
  path.join(home, ".claude/.credentials.json"),
  path.join(home, ".config/gh/hosts.yml"),
  path.join(home, ".gitconfig"),
  "/etc/passwd",
];
for (const t of readTargets) {
  const r = await sandboxed(`if [ -e "${t}" ]; then /bin/cat "${t}" 2>/dev/null | /usr/bin/wc -c; else echo ABSENT; fi`);
  const v = r.out.trim();
  console.log(`  ${v === "ABSENT" ? "not present   " : r.code === 0 ? `READABLE ${v.padStart(6)}B` : "DENIED        "}  ${tilde(t)}`);
}
const siblings = await sandboxed(`/bin/ls "${path.join(home, "Documents")}" 2>/dev/null | /usr/bin/wc -l`);
console.log(`  READABLE          ~/Documents — ${siblings.out.trim()} entries (every sibling project)`);
const tcc = await sandboxed(`/bin/ls "${path.join(home, "Library/Messages")}" >/dev/null 2>&1; echo rc=$?`);
console.log(`  ${tcc.out.includes("rc=0") ? "READABLE      " : "DENIED by TCC "}  ~/Library/Messages (a wall the OS holds, not Seatbelt)`);
const net = await sandboxed(`/usr/bin/curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://example.com 2>&1`);
console.log(`  network egress (deliberate, D-none — the demo allows it): HTTP ${net.out.trim()}`);

console.log(`\n=== D. Exec reach: which binaries a confined child cannot run\n`);
for (const bin of ["/bin/ps", "/usr/bin/top", "/usr/bin/crontab", "/usr/bin/sudo", "/usr/bin/id", "/usr/bin/whoami", "/usr/bin/ssh", "/usr/sbin/lsof"]) {
  let mode = "----";
  try { mode = (fs.statSync(bin).mode & 0o7777).toString(8).padStart(4, "0"); } catch { continue; }
  const r = await sandboxed(`${bin} 2>&1 >/dev/null | /usr/bin/head -1`);
  const denied = r.out.includes("Operation not permitted");
  console.log(`  ${denied ? "EXEC DENIED" : "exec ok    "}  ${bin} (mode ${mode}${mode.startsWith("4") || mode.startsWith("2") ? ", setuid/setgid" : ""})`);
}
const psPermissive = await run("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/bin/sh", "-c", "/bin/ps -o pid= -p $$ 2>&1 | /usr/bin/head -1"]);
console.log(`  control — /bin/ps under a fully permissive profile: ${psPermissive.out || "(ran)"}`);
const psFree = await run("/bin/sh", ["-c", "/bin/ps -o pid= -p $$ 2>&1 | /usr/bin/head -1"]);
console.log(`  control — /bin/ps with no sandbox at all: ${psFree.out ? "ran" : "(no output)"}`);

console.log(`\n=== summary\n`);
const escaped = escapes.filter((e) => e.escaped);
console.log(`  escape attempts: ${escapes.length}   escapes: ${escaped.length}${escaped.length ? " — " + escaped.map((e) => e.name).join("; ") : ""}`);
console.log(`  scratch (safe to delete): ${root}  ${tmp}  ${outside}`);
for (const d of [root, tmp, outside]) fs.rmSync(d, { recursive: true, force: true });
process.exit(escaped.length ? 1 : 0);
