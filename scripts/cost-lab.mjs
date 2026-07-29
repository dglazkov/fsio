#!/usr/bin/env node
// Polling-cost lab (#43, idle half + pollMs sweep) on the shared harness
// rig (one grant click — F15).
//
//   node scripts/cost-lab.mjs [--skip-build] [--keep] [--cell-secs=60]
//
// Methodology (agreed in #43 discussion): hold the workload constant,
// vary one knob per cell, measure cost as a CPU-TIME DELTA against a
// zero-session baseline (macOS `ps %cpu` is a decaying average — too
// smeared for idle magnitudes; Δcputime/Δwall is exact). Cells:
//
//   baseline        0 sessions            the floor everything subtracts
//   idle ×1         1 echo, adaptive 5ms  D4's "zero idle cost" claim
//   idle ×8         8 echo                linearity (#34's tabs)
//   idle ×8 hidden  8 echo, tab hidden    the wall-of-tabs posture (F16)
//   stream 5/15/50  1 Hz stream           burn curve vs hot-poll rate
//   poll-pinned 5   1 Hz stream, no obs   what the observer sentinel saves
//   saturation 1ms  1 Hz stream           RTT-floor-≈-wake-duration check
//
// Stream cells co-measure latency: 60 s of constant 1 Hz load for CPU
// (comparable across cells AND to F16/F17), then a standard 100-ping
// bench in the same config for RTT. Wakeup counts from the page turn CPU
// seconds into CPU-µs per wake — the machine-portable constant (burn ≈
// wake rate × per-wake cost; the rate is workload, only the constant is
// hardware).
//
// Every measured phase runs DETACHED (F16 method note: an attached CDP
// session force-emulates focus and would also add its own noise).
// Results are FINDINGS material (labs tier), never CI verdicts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sleep, waitFor, readReport, startRig, coverTab, sampleCpuTimes } from "./harness-rig.mjs";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const KEEP = flag("keep");
const SKIP_BUILD = flag("skip-build");
const PORT = Number(process.env.FSIO_HARNESS_PORT ?? 8766);
const CELL_SECS = Number(opt("cell-secs", "60"));
const SETTLE_SECS = 5;

const log = (...a) => console.log("[cost-lab]", ...a);
const pct = (x) => (x == null ? "—" : (x * 100).toFixed(2));

// A machine nap poisons cputime-vs-wall arithmetic; hold everything awake.
const caffeinate = process.platform === "darwin" ? spawn("caffeinate", ["-dis"], { stdio: "ignore" }) : null;

let rig = null;
let failed = false;
const results = { startedAt: new Date().toISOString(), cellSecs: CELL_SECS, cells: [] };
try {
  rig = await startRig({ repo, port: PORT, skipBuild: SKIP_BUILD, detachable: true, log });
  const { dir, profile, children } = rig;
  const hostPid = children.find((c) => c.name === "host")?.p.pid;

  {
    const ver = await rig.context.newPage();
    await ver.goto("chrome://version");
    const cmdline = await ver.evaluate(() => document.getElementById("command_line")?.textContent ?? "");
    await ver.close();
    const leaked = ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"].filter((f) => cmdline.includes(f));
    if (leaked.length) throw new Error(`throttling-disable flags leaked into the browser: ${leaked.join(" ")}`);
    log("command line clean: no throttling-disable flags");
  }
  const tabs = await coverTab(rig, PORT);
  await rig.page.evaluate(() => (document.getElementById("b-count").closest("details").open = true));

  const events = (type) => (readReport(dir)?.events ?? []).filter((e) => e.type === type);
  const sessionDirs = () => {
    try {
      return fs.readdirSync(path.join(dir, ".fsio", "sessions")).length;
    } catch {
      return 0;
    }
  };

  /** Detach, settle, snapshot, wait, snapshot, reattach → per-type CPU%. */
  async function measure(label) {
    await rig.detach();
    await sleep(SETTLE_SECS * 1000);
    const a = sampleCpuTimes(profile, hostPid);
    await sleep(CELL_SECS * 1000);
    const b = sampleCpuTimes(profile, hostPid);
    await rig.reattach();
    const wall = (b.at - a.at) / 1000;
    const byType = {};
    const aById = new Map(a.procs.map((p) => [p.pid, p]));
    let unmatched = 0;
    for (const p of b.procs) {
      const prev = aById.get(p.pid);
      if (!prev || prev.type !== p.type) {
        unmatched++;
        continue; // process born mid-cell — skip rather than misattribute
      }
      byType[p.type] = (byType[p.type] ?? 0) + (p.cpuSec - prev.cpuSec);
    }
    const cpu = Object.fromEntries(Object.entries(byType).map(([t, s]) => [t, s / wall]));
    if (b.host && a.host) cpu["fsio-host"] = (b.host.cpuSec - a.host.cpuSec) / wall;
    if (unmatched) log(`  (${label}: ${unmatched} process(es) appeared mid-cell, excluded)`);
    return { wall, cpu };
  }

  async function setConfig(mode, pollMs) {
    await rig.page.selectOption("#b-mode", mode);
    await rig.page.fill("#b-poll", String(pollMs));
  }

  /** Between cells: all sessions closed and host-reaped (D6) so nothing bleeds. */
  async function drained() {
    await waitFor("host to reap all session dirs (D6)", () => sessionDirs() === 0, 20_000, 500);
  }

  // ---------------- idle cells ----------------

  async function idleCell(label, n, hidden) {
    log(`=== ${label} ===`);
    let wakeups = null;
    if (n > 0) {
      await setConfig("adaptive", 5);
      await rig.page.fill("#c-count", String(n));
      const before = events("cost-lab-started").length;
      await rig.page.click("#run-cost-lab");
      await waitFor("cost-lab-started", () => events("cost-lab-started")[before], 30_000, 500);
    }
    if (hidden) await tabs.activate("blank");
    const hiddenFrom = Date.now();
    const m = await measure(label);
    if (hidden) {
      await tabs.activate("workbench");
      await sleep(1000);
      // The transition events are the arbiter of hiddenness (no stream →
      // no per-sample vis to check).
      const vis = events("cost-visibility").filter((e) => e.atW >= hiddenFrom - 2000);
      if (!vis.some((e) => e.state === "hidden")) throw new Error(`${label}: no hidden visibility transition recorded — cell void`);
    }
    if (n > 0) {
      const before = events("cost-lab-stopped").length;
      await rig.page.click("#run-cost-lab");
      const stopped = await waitFor("cost-lab-stopped", () => events("cost-lab-stopped")[before], 30_000, 500);
      wakeups = (stopped.sessions ?? []).reduce((a, s) => a + (s.wakeups ?? 0), 0);
      await drained();
    }
    results.cells.push({ label, kind: "idle", n, hidden: !!hidden, ...m, wakeups });
    log(`  browser ${pct(m.cpu.browser)}% renderer ${pct(m.cpu.renderer)}% host ${pct(m.cpu["fsio-host"])}%`);
  }

  await idleCell("baseline (0 sessions)", 0, false);
  await idleCell("idle ×1", 1, false);
  await idleCell("idle ×8", 8, false);
  await idleCell("idle ×8 hidden", 8, true);

  // ---------------- stream cells (CPU + latency per config) ----------------

  async function streamCell(label, mode, pollMs) {
    log(`=== ${label} ===`);
    await setConfig(mode, pollMs);
    const before = events("bg-lab-started").length;
    await rig.page.click("#run-bg-lab");
    await waitFor("bg-lab-started", () => events("bg-lab-started")[before], 30_000, 500);
    const m = await measure(label);
    const stopBefore = events("bg-lab-stopped").length;
    await rig.page.click("#run-bg-lab");
    const stopped = await waitFor("bg-lab-stopped", () => events("bg-lab-stopped")[stopBefore], 30_000, 500);
    const wakeups = stopped.stats?.wakeups ?? null;
    await drained();
    // Latency in the same config: the standard bench, 100 pings.
    await rig.page.fill("#b-count", "100");
    await rig.page.selectOption("#b-uplink", "auto");
    const benchBefore = events("bench").length;
    await rig.page.click("#run-bench");
    const bench = await waitFor(`bench (${label})`, () => events("bench")[benchBefore], 120_000, 500);
    await drained();
    // Wakeups from the whole lab window (incl. settle) vs CPU from the
    // measured slice: rate is what transfers, so compute it over the
    // measured wall and derive per-wake cost from chrome-side CPU.
    const wakeRate = wakeups != null ? wakeups / ((stopped.at - (events("bg-lab-started")[before].at ?? 0)) / 1000) : null;
    const chromeSec = (m.cpu.browser ?? 0) + (m.cpu.renderer ?? 0);
    const usPerWake = wakeRate ? (chromeSec * 1e6) / wakeRate : null;
    results.cells.push({ label, kind: "stream", mode, pollMs, ...m, wakeups, wakeRate, usPerWake, rtt: bench.legs?.rtt ?? null });
    log(`  browser ${pct(m.cpu.browser)}% renderer ${pct(m.cpu.renderer)}% host ${pct(m.cpu["fsio-host"])}% · rtt p50 ${bench.legs?.rtt?.p50?.toFixed(2)} ms · ${wakeRate?.toFixed(0)} wakes/s`);
  }

  await streamCell("stream adaptive 5ms", "adaptive", 5);
  await streamCell("stream adaptive 15ms", "adaptive", 15);
  await streamCell("stream adaptive 50ms", "adaptive", 50);
  await streamCell("stream poll-pinned 5ms", "poll", 5);
  await streamCell("saturation probe 1ms", "adaptive", 1);

  // ---------------- tables ----------------

  const base = results.cells.find((c) => c.label.startsWith("baseline"));
  const rel = (c, t) => (c.cpu[t] ?? 0) - (base.cpu[t] ?? 0);
  console.log(`\n  idle matrix (%CPU over ${CELL_SECS}s, cputime deltas; Δ = minus baseline):`);
  console.log(`  ${"cell".padEnd(22)} ${"browser".padStart(9)} ${"Δbrowser".padStart(9)} ${"renderer".padStart(9)} ${"Δrenderer".padStart(10)} ${"host".padStart(7)}`);
  for (const c of results.cells.filter((c) => c.kind === "idle")) {
    console.log(
      `  ${c.label.padEnd(22)} ${pct(c.cpu.browser).padStart(9)} ${pct(rel(c, "browser")).padStart(9)} ${pct(c.cpu.renderer).padStart(9)} ${pct(rel(c, "renderer")).padStart(10)} ${pct(c.cpu["fsio-host"]).padStart(7)}`
    );
  }
  const i1 = results.cells.find((c) => c.label === "idle ×1");
  const i8 = results.cells.find((c) => c.label === "idle ×8");
  if (i1 && i8) {
    console.log(`  per-session marginal: ×1 ${pct(rel(i1, "browser") + rel(i1, "renderer"))}% · ×8 ${pct((rel(i8, "browser") + rel(i8, "renderer")) / 8)}%/session`);
  }
  console.log(`\n  pollMs sweep (1 Hz stream · %CPU · bench rtt):`);
  console.log(`  ${"cell".padEnd(24)} ${"browser".padStart(9)} ${"renderer".padStart(9)} ${"host".padStart(7)} ${"wakes/s".padStart(8)} ${"µs/wake".padStart(8)} ${"rtt p50".padStart(8)} ${"p95".padStart(7)}`);
  for (const c of results.cells.filter((c) => c.kind === "stream")) {
    console.log(
      `  ${c.label.padEnd(24)} ${pct(c.cpu.browser).padStart(9)} ${pct(c.cpu.renderer).padStart(9)} ${pct(c.cpu["fsio-host"]).padStart(7)} ${(c.wakeRate?.toFixed(0) ?? "—").padStart(8)} ${(c.usPerWake?.toFixed(0) ?? "—").padStart(8)} ${(c.rtt?.p50?.toFixed(2) ?? "—").padStart(8)} ${(c.rtt?.p95?.toFixed(2) ?? "—").padStart(7)}`
    );
  }

  const outPath = path.join(os.homedir(), ".fsio-harness", `cost-lab-${Date.now().toString(36)}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  log(`raw data: ${outPath}`);
} catch (e) {
  failed = true;
  console.error("\n[cost-lab] FAILED:", e.message ?? e);
  for (const { name, tail } of rig?.children ?? []) {
    if (tail.length) console.error(`\n--- last output from ${name} ---\n${tail.join("\n")}`);
  }
} finally {
  caffeinate?.kill("SIGTERM");
  if (KEEP) {
    log(`--keep: leaving everything running; shared dir ${rig?.dir}`);
  } else {
    await rig?.teardown();
    if (failed) log(`kept for forensics: ${rig?.dir}`);
    else if (rig) {
      await sleep(500);
      try {
        fs.rmSync(rig.run, { recursive: true, force: true });
      } catch {}
    }
    process.exit(failed ? 1 : 0);
  }
}
