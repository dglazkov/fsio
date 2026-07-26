#!/usr/bin/env node
// Protocol integration smoke test. Hermetic: fresh temp dir, own host
// process, real clients — CI and local runs are byte-identical (`npm test`).
//
//   1. echo bench, file uplink    — transport + JSON-RPC round trip
//   2. echo bench, dirname uplink — fast-lane encoding (F10)
//   3. firehose, fast consumer    — throughput + segment GC (F12)
//   4. firehose, slow consumer    — ack-window pause/resume (F12)
//
// Latency assertion is a *generous ceiling only* (see #15): it catches
// wakeup-strategy regressions (the F1/F2 class lands at 50–300 ms p50)
// without flaking on shared runners.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // …/bench/dist
const hostJs = path.join(here, "..", "..", "host", "dist", "fsio-host.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsio-smoke-"));

const P50_CEILING_MS = 100;

function run(label: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    console.log(`\n=== ${label}`);
    const p = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => {
      out += d;
      process.stdout.write(d);
    });
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`${label}: timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    p.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${label}: exit code ${code}`));
    });
  });
}

// The bench prints a markdown row: | node client | mode | count | payload | min | p50 | p95 | max |
function assertP50(label: string, out: string): void {
  const row = out
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("| node client |"));
  if (!row) throw new Error(`${label}: no result row in output`);
  const p50 = Number(row.split("|")[6]);
  if (!(p50 > 0)) throw new Error(`${label}: unparseable p50 in: ${row}`);
  if (p50 > P50_CEILING_MS) throw new Error(`${label}: p50 ${p50}ms exceeds the ${P50_CEILING_MS}ms ceiling — wakeup-strategy regression?`);
  console.log(`    p50 ${p50}ms ≤ ${P50_CEILING_MS}ms ceiling ✓`);
}

// ---- host lifecycle
let shuttingDown = false;
console.log(`smoke: host on ${dir}`);
const host = spawn(process.execPath, [hostJs, dir, "--fresh", "--allow-shell"], { stdio: ["ignore", "inherit", "inherit"] });
host.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`smoke FAIL: host exited early (code ${code})`);
    process.exit(1);
  }
});

// wait for the heartbeat
const hostJson = path.join(dir, ".fsio", "host.json");
for (let i = 0; ; i++) {
  if (fs.existsSync(hostJson)) break;
  if (i > 100) {
    console.error("smoke FAIL: host never wrote host.json");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 50));
}

// ---- the battery
const nodeClient = path.join(here, "node-client.js");
const firehose = path.join(here, "firehose.js");
let ok = false;
try {
  const out1 = await run("echo bench (file uplink)", [nodeClient, dir, "--count", "50", "--poll", "5"], 60_000);
  assertP50("file uplink", out1);
  const out2 = await run("echo bench (dirname uplink)", [nodeClient, dir, "--count", "50", "--poll", "5", "--uplink", "dirname"], 60_000);
  assertP50("dirname uplink", out2);
  await run("firehose (fast consumer)", [firehose, dir, "--lines", "200000"], 120_000);
  await run("firehose (slow consumer)", [firehose, dir, "--lines", "800000", "--slow"], 150_000);
  ok = true;
} catch (e) {
  console.error(`\nsmoke FAIL: ${e instanceof Error ? e.message : e}`);
} finally {
  shuttingDown = true;
  host.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(ok ? "\nsmoke PASS" : "");
process.exit(ok ? 0 : 1);
