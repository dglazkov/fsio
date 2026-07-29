#!/usr/bin/env node
// Background-tab throttling + polling-cost lab (#42/#43): one scenario
// driver, two instrument sets, on the shared harness rig (harness-rig.mjs,
// one human grant click — F15).
//
//   node scripts/background-lab.mjs [--skip-build] [--keep]
//     [--modes=adaptive,observer] [--fg-secs=30] [--bg-secs=480]
//
// Scenario, per notifier mode: the workbench streams a 1 Hz host-side
// timestamp feed (page-side recorder: workbench "Background lab" button);
// this driver backgrounds the tab by focusing a blank tab, waits through
// Chrome's throttling regimes (≥1 s clamp on backgrounding; ~1/min
// intensive throttling after 5 min for eligible pages), then foregrounds
// and watches recovery. Delivery latency = page receipt minus host stamp,
// same machine, same clock (#42's stall axis). Meanwhile: native ps
// sampling of every Chrome process in the rig's tree — renderer AND the
// storage-service utility process, which a DevTools profile of the tab
// misses by construction — plus the host process (#43's burn axis).
//
// Results are FINDINGS material (labs tier, TESTING.md), never CI
// verdicts: this script prints tables and writes raw JSON beside the run
// dirs; it does not exit non-zero on "slow".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sleep, waitFor, readReport, startRig, sampleChromeProcesses } from "./harness-rig.mjs";

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
const MODES = opt("modes", "adaptive,observer").split(",");
const FG_SECS = Number(opt("fg-secs", "30"));
const BG_SECS = Number(opt("bg-secs", "480")); // crosses the 5-min intensive-throttling boundary with margin
const CPU_EVERY_MS = 5000;

const log = (...a) => console.log("[bg-lab]", ...a);

function stats(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], p50: q(0.5), p95: q(0.95), max: s[s.length - 1] };
}
const fmt = (x) => (x == null ? "—" : x >= 10000 ? `${(x / 1000).toFixed(1)}s` : `${Math.round(x)}`);

function sampleHost(pid) {
  const out = spawnSync("ps", ["-p", String(pid), "-o", "pcpu=,rss="], { encoding: "utf8" });
  const m = out.stdout?.trim().match(/^([\d.]+)\s+(\d+)$/);
  return m ? { pcpu: +m[1], rssMb: +m[2] / 1024 } : null;
}

let rig = null;
let failed = false;
const results = { startedAt: new Date().toISOString(), fgSecs: FG_SECS, bgSecs: BG_SECS, scenarios: [] };
// A system nap mid-run corrupts the clocks and the throttling regimes (run
// 1 slept 17 s and read it as negative latency). Keep the machine — and the
// display, so tab visibility is the ONLY variable — awake for the run.
const caffeinate = process.platform === "darwin" ? spawn("caffeinate", ["-dis"], { stdio: "ignore" }) : null;

try {
  rig = await startRig({ repo, port: PORT, skipBuild: SKIP_BUILD, detachable: true, log });
  const { dir, profile, children } = rig;
  const hostPid = children.find((c) => c.name === "host")?.p.pid;

  // Precondition 1: stock command line. Detachable mode spawns Chrome
  // itself so Playwright's throttling-disable defaults never apply (run
  // 2's flat 5 ms through 8 min of "background" — see harness-rig.mjs);
  // trust nothing, read the live command line.
  {
    const ver = await rig.context.newPage();
    await ver.goto("chrome://version");
    const cmdline = await ver.evaluate(() => document.getElementById("command_line")?.textContent ?? "");
    await ver.close();
    const leaked = ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"].filter((f) => cmdline.includes(f));
    if (leaked.length) throw new Error(`throttling-disable flags leaked into the browser: ${leaked.join(" ")}`);
    log("command line clean: no throttling-disable flags");
  }

  // Precondition 2: "backgrounded" must mean document.visibilityState ===
  // "hidden", and with an attached automation session it NEVER is —
  // Playwright force-emulates focus, so a covered tab stays visible with
  // timers unthrottled (probes 3/4; run 3 measured exactly that and called
  // it background). Hence the choreography below: cover tab via CDP
  // Target.createTarget (window.open is popup-blocked in stock Chrome),
  // switch tabs while attached, then DETACH for every measurement phase.
  // The page records visibilityState per sample; analysis rejects the
  // scenario unless the background phase really ran hidden.
  const tabs = {};
  {
    const cdp = await rig.context.newCDPSession(rig.page);
    tabs.blank = (await cdp.send("Target.createTarget", { url: "about:blank", background: true })).targetId;
    tabs.workbench = (await cdp.send("Target.getTargets")).targetInfos.find(
      (t) => t.type === "page" && t.url.includes(`localhost:${PORT}`)
    )?.targetId;
    if (!tabs.workbench) throw new Error("could not find the workbench tab target");
  }
  const activateTab = async (targetId) => {
    const cdp = await rig.context.newCDPSession(rig.page);
    await cdp.send("Target.activateTarget", { targetId });
  };
  await rig.page.evaluate(() => (document.getElementById("b-count").closest("details").open = true));

  const events = (type) => (readReport(dir)?.events ?? []).filter((e) => e.type === type);

  for (const mode of MODES) {
    log(`=== scenario: mode=${mode} (fg ${FG_SECS}s → bg ${BG_SECS}s → recovery ${FG_SECS}s) ===`);
    await rig.page.selectOption("#b-mode", mode);
    await rig.page.fill("#b-poll", "5");
    const startedBefore = events("bg-lab-started").length;
    await rig.page.click("#run-bg-lab");
    const started = await waitFor("bg-lab-started event", () => events("bg-lab-started")[startedBefore], 30_000, 500);
    log(`streaming; effective client mode: ${started.mode}`);

    const cpu = [];
    const phaseWait = async (phase, secs) => {
      const until = Date.now() + secs * 1000;
      while (Date.now() < until) {
        cpu.push({ at: Date.now(), phase, chrome: sampleChromeProcesses(profile), host: hostPid ? sampleHost(hostPid) : null });
        await sleep(Math.min(CPU_EVERY_MS, Math.max(0, until - Date.now())));
      }
    };

    // Every measurement phase runs DETACHED (see precondition 2); the rig
    // reattaches only long enough to switch tabs or click buttons.
    await rig.detach();
    const wallStart = Date.now();
    await phaseWait("fg", FG_SECS);

    await rig.reattach();
    await activateTab(tabs.blank); // workbench behind the cover tab…
    await rig.detach(); // …and hidden for real only once we let go
    const bgStart = Date.now();
    log(`backgrounded at +${((bgStart - wallStart) / 1000).toFixed(0)}s — waiting ${BG_SECS}s detached (intensive throttling begins ~300s in)`);
    await phaseWait("bg", BG_SECS);

    const fgReturn = Date.now();
    await rig.reattach();
    await activateTab(tabs.workbench);
    log("foregrounded — watching recovery");
    await phaseWait("recovery", FG_SECS);

    const stoppedBefore = events("bg-lab-stopped").length;
    await rig.page.click("#run-bg-lab"); // toggle: stop + flush buffered samples
    await waitFor("bg-lab-stopped event", () => events("bg-lab-stopped")[stoppedBefore], 30_000, 500);
    await sleep(2000); // final reporter flush

    // ---- analysis (#42): delivery latency by throttling regime
    const all = events("bg-samples")
      .flatMap((e) => e.samples ?? [])
      .filter((s) => s.t >= wallStart - 2000 && s.t <= Date.now());
    // The measurement is void unless the bg phase really ran hidden — the
    // page's own per-sample visibilityState is the arbiter (allow the
    // transition seconds at the edges).
    const bgSamples = all.filter((s) => s.t >= bgStart + 2000 && s.t < fgReturn - 2000);
    const hiddenFrac = bgSamples.length ? bgSamples.filter((s) => s.vis === "hidden").length / bgSamples.length : 0;
    if (hiddenFrac < 0.9) {
      throw new Error(`bg phase not actually hidden (${(hiddenFrac * 100).toFixed(0)}% hidden samples) — measurement void`);
    }
    log(`bg phase verified hidden (${(hiddenFrac * 100).toFixed(1)}% of ${bgSamples.length} samples)`);
    const bucketDefs = [
      ["foreground", (s) => s.t < bgStart],
      ["bg 0–60 s", (s) => s.t >= bgStart && s.t < bgStart + 60_000],
      ["bg 60 s–5 min", (s) => s.t >= bgStart + 60_000 && s.t < bgStart + 300_000],
      ["bg >5 min", (s) => s.t >= bgStart + 300_000 && s.t < fgReturn],
      ["recovery", (s) => s.t >= fgReturn],
    ];
    // Wall-clock delta (atW − t): comparable to the host stamp even if the
    // renderer's performance clock paused. The at/atW divergence is the
    // sleep detector — nonzero drift means the numbers need a caveat.
    const buckets = bucketDefs.map(([name, pred]) => {
      const xs = all.filter(pred);
      return { name, delta: stats(xs.map((s) => (s.atW ?? s.at) - s.t)) };
    });
    const skews = all.filter((s) => s.atW != null).map((s) => s.atW - s.at);
    const clockDriftMs = skews.length ? Math.max(...skews) - Math.min(...skews) : null;
    // stall depth ≠ sample count: lines emitted 1/s, so missing samples mean
    // the stream died, and huge deltas mean it stalled then burst.
    const arrival = (s) => s.atW ?? s.at;
    const pendingAtFg = all.filter((s) => s.t < fgReturn && arrival(s) >= fgReturn);
    const drainedBy = pendingAtFg.length ? Math.max(...pendingAtFg.map(arrival)) - fgReturn : null;
    const firstAfterFg = all.filter((s) => arrival(s) >= fgReturn).sort((a, b) => arrival(a) - arrival(b))[0] ?? null;

    console.log(`\n  delivery latency (page receipt − host stamp, ms) — mode=${started.mode}:`);
    console.log(`  ${"regime".padEnd(16)} ${"n".padStart(5)} ${"p50".padStart(8)} ${"p95".padStart(8)} ${"max".padStart(8)}`);
    for (const b of buckets) {
      const d = b.delta;
      console.log(`  ${b.name.padEnd(16)} ${String(d?.n ?? 0).padStart(5)} ${fmt(d?.p50).padStart(8)} ${fmt(d?.p95).padStart(8)} ${fmt(d?.max).padStart(8)}`);
    }
    console.log(`  on foreground: ${pendingAtFg.length} stalled line(s) drained in ${fmt(drainedBy)} ms; first delivery ${fmt(firstAfterFg ? arrival(firstAfterFg) - fgReturn : null)} ms after focus`);
    console.log(`  renderer clock drift over scenario (sleep detector): ${fmt(clockDriftMs)} ms\n`);

    // ---- analysis (#43): %CPU by process type per phase
    const phases = ["fg", "bg", "recovery"];
    const cpuSummary = {};
    for (const phase of phases) {
      const rows = cpu.filter((c) => c.phase === phase);
      const byType = {};
      for (const r of rows) {
        for (const p of r.chrome) (byType[p.type] ??= []).push(p.pcpu);
        if (r.host) (byType["fsio-host"] ??= []).push(r.host.pcpu);
      }
      // mean of per-sample sums per type — "how much CPU does this type burn
      // during this phase", robust to helper processes coming and going
      const sums = {};
      for (const [type, _xs] of Object.entries(byType)) {
        const perSample = rows.map((r) =>
          (type === "fsio-host" ? [r.host?.pcpu ?? 0] : r.chrome.filter((p) => p.type === type).map((p) => p.pcpu)).reduce((a, b) => a + b, 0)
        );
        sums[type] = { mean: perSample.reduce((a, b) => a + b, 0) / perSample.length, max: Math.max(...perSample) };
      }
      cpuSummary[phase] = sums;
    }
    console.log(`  %CPU by process (mean over phase, ps sampling every ${CPU_EVERY_MS / 1000}s):`);
    const types = [...new Set(Object.values(cpuSummary).flatMap((s) => Object.keys(s)))].sort();
    console.log(`  ${"process".padEnd(28)} ${phases.map((p) => p.padStart(10)).join("")}`);
    for (const t of types) {
      console.log(`  ${t.padEnd(28)} ${phases.map((p) => (cpuSummary[p][t] ? cpuSummary[p][t].mean.toFixed(1) : "—").padStart(10)).join("")}`);
    }
    console.log("");

    results.scenarios.push({
      mode,
      effectiveMode: started.mode,
      wallStart,
      bgStart,
      fgReturn,
      buckets,
      pendingAtFg: pendingAtFg.length,
      drainedByMs: drainedBy,
      firstDeliveryAfterFgMs: firstAfterFg ? arrival(firstAfterFg) - fgReturn : null,
      clockDriftMs,
      cpuSummary,
      samples: all,
      cpuRaw: cpu,
    });
  }

  const outPath = path.join(os.homedir(), ".fsio-harness", `bg-lab-${Date.now().toString(36)}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  log(`raw data: ${outPath}`);
} catch (e) {
  failed = true;
  console.error("\n[bg-lab] FAILED:", e.message ?? e);
  for (const { name, tail } of rig?.children ?? []) {
    if (tail.length) console.error(`\n--- last output from ${name} ---\n${tail.join("\n")}`);
  }
} finally {
  caffeinate?.kill("SIGTERM");
  if (KEEP) {
    log(`--keep: leaving host, web server, and browser running; shared dir ${rig?.dir}`);
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
