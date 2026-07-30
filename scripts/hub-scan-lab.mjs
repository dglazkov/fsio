#!/usr/bin/env node
// Hub-scale scan-loop cost lab (#68, hub track / D19) - F18's deferred
// host-cost pass, priced for fsiod.
//
// Mechanism under test (host-server.ts): the host's hot poll was gated on
// session LIVENESS (`started && !done`), not traffic - N idle-but-running
// sessions kept a 5 ms x O(N) scan loop hot forever. The idle machinery
// the hot poll drowns out (per-dir fs.watch wakeups + 250 ms safety scan)
// is already there; fsiod needs to know what each configuration costs.
//
// FIXED in #73 (2026-07-30): the gate is now recent traffic (D4, host-side).
// This lab keeps working as the regression bench - cell A is the shipped
// default and cell B is the floor, so *A converging on B* is the pass
// condition, and A drifting up means the gate broke (F22 addendum).
//
// Cells (all idle - zero traffic; CPU-time delta over 60 s, F18's method):
//   A  status quo:   real host CLI, --hot 5 (alive-gated hot poll)
//   B  idle-gated:   real host CLI, --hot 0 (watchers + 250 ms safety only)
//   C  hub probe:    ONE recursive fs.watch + 250 ms full scan (this file,
//                    --probe mode) over an identical static session tree
// x N in {0, 1, 8, 32} (C: no N=0), plus wake-from-idle latency for C at
// N=32 (20 chunk drops; detection = recursive watch OR safety scan,
// whichever fires first - D1's combined system is what ships).
//
// Usage: node scripts/hub-scan-lab.mjs            # full matrix, ~13 min
//        node scripts/hub-scan-lab.mjs --probe <root>   # (internal)

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const HOST_CLI = path.join(REPO, "packages/host/dist/fsio-host.js");
const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------- probe
// fsiod's candidate idle loop: one recursive watcher over sessions/, full
// idempotent scan on wakeup, 250 ms safety scan (D1). Scan work mirrors
// the host's scanOnce(): readdir(sessions/) + readdir of each in/.
if (process.argv[2] === "--probe") {
  const root = process.argv[3];
  const sessionsDir = path.join(root, ".fsio", "sessions");
  const seen = new Map(); // sessionId -> Set of in/ names
  const scanDurations = [];
  let scanning = false, rescan = false;
  const scan = () => {
    if (scanning) { rescan = true; return; }
    scanning = true;
    do {
      rescan = false;
      const t0 = process.hrtime.bigint();
      let entries = [];
      try { entries = fs.readdirSync(sessionsDir, { withFileTypes: true }); } catch {}
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        let inNames = [];
        try { inNames = fs.readdirSync(path.join(sessionsDir, e.name, "in")); } catch {}
        let known = seen.get(e.name);
        if (!known) { known = new Set(); seen.set(e.name, known); }
        for (const n of inNames) {
          if (known.has(n)) continue;
          known.add(n);
          const m = /^c-(\d+)$/.exec(n);
          if (m) console.log(JSON.stringify({ detect: n, latencyMs: Date.now() - Number(m[1]) }));
        }
      }
      scanDurations.push(Number(process.hrtime.bigint() - t0) / 1000);
    } while (rescan);
    scanning = false;
  };
  const watcher = fs.watch(sessionsDir, { recursive: true }, () => scan());
  watcher.on("error", () => {});
  setInterval(scan, 250);
  scan();
  console.log("ready");
  process.on("SIGTERM", () => {
    const s = scanDurations.slice(1).sort((a, b) => a - b);
    console.log(JSON.stringify({
      scans: s.length,
      scanUsP50: Math.round(s[Math.floor(s.length / 2)] ?? 0),
      scanUsMax: Math.round(s[s.length - 1] ?? 0),
    }));
    process.exit(0);
  });
} else {
  await runner();
}

// --------------------------------------------------------------- runner
async function runner() {
  const BASE = process.env.HUB_SCAN_LAB_DIR ?? fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "hub-scan-lab-"));
  const CELL_S = Number(process.env.HUB_SCAN_LAB_CELL_S ?? 60);
  const results = [];
  const log = (s) => console.log(`[lab] ${s}`);

  const cpuSeconds = (pid) => {
    const out = execFileSync("ps", ["-o", "cputime=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const parts = out.split(":").map(Number); // [SS.cc] | [MM, SS.cc] | [HH, MM, SS.cc]
    return parts.reduce((acc, v) => acc * 60 + v, 0);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (label, fn, timeoutMs = 20000) => {
    const t0 = Date.now();
    while (!fn()) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
      await sleep(100);
    }
  };
  const stop = (child) => new Promise((resolve) => {
    child.on("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000).unref();
  });
  // Atomic per invariant 5: native writers use write-temp-then-rename.
  const writeAtomic = (file, data) => {
    fs.writeFileSync(file + ".tmp", data);
    fs.renameSync(file + ".tmp", file);
  };
  const makeSessionDirs = (root, n, { forProbe }) => {
    const sessions = path.join(root, ".fsio", "sessions");
    for (let i = 0; i < n; i++) {
      const dir = path.join(sessions, `s-lab-${String(i).padStart(2, "0")}`);
      fs.mkdirSync(path.join(dir, "in"), { recursive: true });
      if (forProbe) {
        // Static session-shaped tree; no host will adopt these.
        writeAtomic(path.join(dir, "status.json"), JSON.stringify({ state: "running", t: Date.now() }));
        writeAtomic(path.join(dir, "out.sig"), JSON.stringify({ gen: 0, size: 0, prevFinal: 0, total: 0 }));
        fs.writeFileSync(path.join(dir, "out.00000000.log"), "");
      }
      // spawn.json LAST (spec: presence = session ready).
      writeAtomic(path.join(dir, "spawn.json"), JSON.stringify({
        jsonrpc: "2.0", id: 0, method: "spawn",
        params: { kind: "echo", client: "hub-scan-lab" },
      }));
    }
    return sessions;
  };
  const measure = async (pid) => {
    await sleep(2000); // settle
    const c0 = cpuSeconds(pid);
    const t0 = performance.now();
    await sleep(CELL_S * 1000);
    const c1 = cpuSeconds(pid);
    const wallS = (performance.now() - t0) / 1000;
    return Math.round(((c1 - c0) / wallS) * 1000 * 100) / 1000; // % of a core
  };

  const hostCell = async (name, n, hot) => {
    const root = path.join(BASE, name);
    fs.mkdirSync(root, { recursive: true });
    const child = spawn(process.execPath, [HOST_CLI, root, "--hot", String(hot)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    try {
      await waitFor("host.json", () => fs.existsSync(path.join(root, ".fsio", "host.json")));
      const sessions = makeSessionDirs(root, n, { forProbe: false });
      await waitFor(`${n} running`, () => {
        for (let i = 0; i < n; i++) {
          const st = path.join(sessions, `s-lab-${String(i).padStart(2, "0")}`, "status.json");
          try {
            if (JSON.parse(fs.readFileSync(st, "utf8")).state !== "running") return false;
          } catch { return false; }
        }
        return true;
      });
      const pct = await measure(child.pid);
      results.push({ cell: name, mode: hot ? `host hot ${hot}ms` : "host hot 0 (idle-gated)", n, cpuPct: pct });
      log(`${name}: ${pct}% of a core`);
    } catch (e) {
      log(`${name} FAILED: ${e.message}\n--- host output ---\n${out}`);
      results.push({ cell: name, n, error: String(e.message) });
    } finally {
      await stop(child);
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  const probeCell = async (name, n, { wake } = {}) => {
    const root = path.join(BASE, name);
    fs.mkdirSync(root, { recursive: true });
    const sessions = makeSessionDirs(root, n, { forProbe: true });
    const child = spawn(process.execPath, [SELF, "--probe", root], { stdio: ["ignore", "pipe", "inherit"] });
    const lines = [];
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    try {
      await waitFor("probe ready", () => lines.includes("ready"));
      const pct = await measure(child.pid);
      const row = { cell: name, mode: "probe: 1 recursive watch + 250ms scan", n, cpuPct: pct };
      if (wake) {
        for (let k = 0; k < 20; k++) {
          const sid = `s-lab-${String(k % n).padStart(2, "0")}`;
          fs.writeFileSync(path.join(sessions, sid, "in", `c-${Date.now()}`), "x");
          await sleep(500);
        }
        await sleep(500);
        const lat = lines.filter((l) => l.startsWith("{") && l.includes("latencyMs"))
          .map((l) => JSON.parse(l).latencyMs).sort((a, b) => a - b);
        row.wake = {
          detected: lat.length, of: 20,
          p50: lat[Math.floor(lat.length / 2)] ?? null,
          max: lat[lat.length - 1] ?? null,
        };
      }
      await stop(child);
      const tail = lines[lines.length - 1];
      if (tail?.includes("scanUsP50")) row.scan = JSON.parse(tail);
      results.push(row);
      log(`${name}: ${pct}% of a core${row.wake ? ` — wake ${row.wake.detected}/20, p50 ${row.wake.p50}ms` : ""}`);
    } catch (e) {
      log(`${name} FAILED: ${e.message}`);
      results.push({ cell: name, n, error: String(e.message) });
      await stop(child);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  log(`base: ${BASE}; ${CELL_S}s cells; node ${process.version}`);
  for (const n of [0, 1, 8, 32]) await hostCell(`A-hot5-x${n}`, n, 5);
  for (const n of [0, 1, 8, 32]) await hostCell(`B-hot0-x${n}`, n, 0);
  for (const n of [1, 8, 32]) await probeCell(`C-probe-x${n}`, n, { wake: n === 32 });
  console.log("\n=== results ===");
  console.log(JSON.stringify(results, null, 2));
  fs.rmSync(BASE, { recursive: true, force: true });
}
