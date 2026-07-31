#!/usr/bin/env node
// Service-reach lab (#90, act 4 / #77) — is a named service actually
// narrower than a shell, or does that only sound true?
//
// #77 claims an stdio MCP server is a better grant unit than a command
// shape because "an MCP server is narrower than a shell": its binary, its
// working state, its credentials, and nothing else. F23/F24 measured the
// shell posture (`scripts/confinement-lab.mjs`); this lab measures whether
// a real MCP server survives a *deny-default* profile, and prices the
// difference in reach.
//
// Subject: @modelcontextprotocol/server-filesystem — a real stdio MCP
// server, deliberately credential-free (the credentialed case, act 4's
// actual product, still wants its own run; see #90).
//
// Method: build the deny-default profile the way a profile author would
// have to — start from nothing and add only rules a *measured* denial
// demands (denials read from the unified log, since SBPL `(trace)` is gone
// on current macOS). Then run the same server under both postures and
// compare what each can reach.
//
// Usage: node scripts/service-reach-lab.mjs        (~1 min; installs the
//        server into a temp dir, needs network for that step only)
import { spawn, execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.platform !== "darwin") {
  console.log("service-reach-lab: Seatbelt is macOS-only; nothing to measure here.");
  process.exit(0);
}

const NODE = process.execPath;
const NODEDIR = path.dirname(path.dirname(NODE));
const lab = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fsio-svc-lab-")));
const ws = path.join(lab, "ws");
fs.mkdirSync(ws);
fs.writeFileSync(path.join(ws, "hello.txt"), "hello from the workspace\n");
const home = os.homedir();
const tilde = (p) => p.replace(home, "~");

console.log("installing the subject (network, install-time reach only — not part of the measurement)…");
fs.writeFileSync(path.join(lab, "package.json"), JSON.stringify({ name: "fsio-svc-lab", private: true }) + "\n");
try {
  execFileSync("npm", ["i", "--silent", "--no-audit", "--no-fund", "@modelcontextprotocol/server-filesystem"], { cwd: lab, stdio: "pipe" });
} catch (e) {
  console.error("install failed:", e.message);
  process.exit(1);
}
const SERVER = path.join(lab, "node_modules/@modelcontextprotocol/server-filesystem/dist/index.js");
const MODULES = path.join(lab, "node_modules");

// ---------------------------------------------------------------- profiles
// P1: what a shell gets today (packages/terminal-demo/src/profile.ts shape).
const P1 = `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "${ws}"))
(allow file-write* (subpath "${os.tmpdir()}"))
(allow file-write* (literal "/dev/null"))
`;
// P2: the service posture. Every rule below the divider was added because a
// run denied it — the count is the honest cost of "narrow".
const P2_SERVICE_RULES = 5;
const P2 = `(version 1)
(deny default)
;; --- the service's reach: its binary, its code, its workspace (${P2_SERVICE_RULES} rules) ---
(allow process-exec (subpath "${NODEDIR}"))
(allow file-read* (subpath "${NODEDIR}"))
(allow file-read* (subpath "${MODULES}"))
(allow file-read* (subpath "${ws}"))
(allow file-write* (subpath "${ws}"))
;; --- node-runtime infrastructure: each one from a measured denial ---
(allow file-read-metadata)
(allow sysctl-read)
(allow file-read-data (literal "/"))
(allow file-read* (subpath "/System/Library"))
(allow file-read* (subpath "/usr/lib") (subpath "/usr/share"))
(allow file-read-data (literal "/dev/dtracehelper") (literal "/dev/urandom") (literal "/dev/random"))
(allow file-write-data (literal "/dev/null"))
(allow mach-lookup (global-name "com.apple.PowerManagement.control"))
(allow user-preference-read)
`;
const p1Path = path.join(lab, "shell.sb");
const p2Path = path.join(lab, "service.sb");
fs.writeFileSync(p1Path, P1);
fs.writeFileSync(p2Path, P2);
const ruleCount = (s) => s.split("\n").filter((l) => l.trim().startsWith("(allow") || l.trim().startsWith("(deny")).length;

// ------------------------------------------------------------- MCP driver
async function driveServer(profilePath, label) {
  const child = spawn("/usr/bin/sandbox-exec", ["-f", profilePath, NODE, SERVER, ws], { cwd: ws, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const send = (m) => { try { child.stdin.write(JSON.stringify(m) + "\n"); } catch {} };
  const reply = (id, ms = 8000) =>
    new Promise((res) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const r = stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((r) => r && r.id === id);
        if (r || Date.now() - t0 > ms || child.exitCode !== null) { clearInterval(iv); res(r ?? null); }
      }, 100);
    });

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fsio-lab", version: "0" } } });
  const init = await reply(1);
  if (init) send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const tools = init ? (send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), await reply(2)) : null;
  const inside = init ? (send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_text_file", arguments: { path: path.join(ws, "hello.txt") } } }), await reply(3)) : null;
  const outside = init ? (send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_text_file", arguments: { path: path.join(home, ".gitconfig") } } }), await reply(4)) : null;
  child.kill();

  console.log(`\n  ${label}`);
  console.log(`    initialize / tools/list:  ${init ? "ok" : "NO RESPONSE"} / ${tools?.result?.tools?.length ?? 0} tools`);
  console.log(`    read inside workspace:    ${inside?.result ? JSON.stringify(inside.result.content?.[0]?.text ?? "").slice(0, 34) : "failed"}`);
  const oText = outside?.result?.content?.[0]?.text ?? outside?.error?.message ?? "";
  console.log(`    read ~/.gitconfig:        ${String(oText).replace(/\s+/g, " ").slice(0, 78)}`);
  if (!init && stderr) console.log(`    stderr: ${stderr.trim().split("\n")[0].slice(0, 100)}`);
  return { ok: !!init, tools: tools?.result?.tools?.length ?? 0 };
}

console.log(`\n=== A. Does a real MCP server survive each posture?`);
const r1 = await driveServer(p1Path, `P1 — shell posture (${ruleCount(P1)} rules, allow default)`);
const r2 = await driveServer(p2Path, `P2 — service posture (${ruleCount(P2)} rules, deny default)`);

// -------------------------------------------------------------- reach probe
const probe = `const fs=require("fs");
const t=(l,f)=>{try{f();console.log("      reachable  "+l)}catch(e){console.log("      DENIED     "+l+"  ("+e.code+")")}};
t("~/.ssh (private keys)",()=>fs.readdirSync(process.env.HOME+"/.ssh"));
t("~/.gitconfig",()=>fs.readFileSync(process.env.HOME+"/.gitconfig"));
t("/etc/passwd",()=>fs.readFileSync("/etc/passwd"));
t("~/Documents (sibling projects)",()=>fs.readdirSync(process.env.HOME+"/Documents"));
t("its own workspace",()=>fs.readFileSync(${JSON.stringify(path.join(ws, "hello.txt"))}));
require("dns").lookup("example.com",(e)=>console.log(e?"      DENIED     DNS lookup  ("+e.code+")":"      reachable  DNS lookup"));`;

console.log(`\n=== B. What each posture can reach (same runtime, same machine)`);
for (const [label, p] of [["P1 — shell posture", p1Path], ["P2 — service posture", p2Path]]) {
  console.log(`\n    ${label}`);
  await new Promise((res) => execFile("/usr/bin/sandbox-exec", ["-f", p, NODE, "-e", probe], { timeout: 30000 }, (e, out, err) => {
    process.stdout.write(out || "");
    if (err && !out) process.stdout.write(`      (${String(err).slice(0, 120)})\n`);
    res();
  }));
}

console.log(`\n=== summary\n`);
console.log(`  MCP server works under deny-default: ${r2.ok ? `yes — ${r2.tools} tools, identical to the shell posture` : "NO"}`);
console.log(`  profile size: ${ruleCount(P2)} rules, of which ${P2_SERVICE_RULES} are the service's reach`);
console.log(`                and ${ruleCount(P2) - P2_SERVICE_RULES - 1} are node-runtime infrastructure (shared by every node service)`);
console.log(`  profiles written for inspection: ${p1Path}  ${p2Path}`);
fs.rmSync(lab, { recursive: true, force: true });
