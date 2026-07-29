#!/usr/bin/env node
// One-click local browser harness (#21): the agent drives the real
// workbench against a real host and reads verdicts natively.
//
//   node scripts/browser-harness.mjs            # build, run, assert, tear down
//   node scripts/browser-harness.mjs --keep     # leave host+browser up after
//   node scripts/browser-harness.mjs --skip-build
//
// The one human interaction: when the terminal says so, click
// "Allow on every visit" in Chrome's permission prompt. Everything else is
// unattended (F15: one gesture unlocks the whole browser session).
//
// Setup lives in harness-rig.mjs (shared with the measurement labs,
// #42/#43): build, fresh shared dir under $HOME (F9), Safe-Browsing-off
// profile (#37), host + vite preview, headed CfT, CDP directory drop
// (F14), the one grant click (F15). This script is the driving + asserting
// half:
//   1. latency bench in both uplink lanes, asserted at the smoke's
//      generous ceiling (100 ms p50 — regression class, not jitter)
//   2. B4 conformance battery (#35): the page's own structured verdicts
//   3. types into the real terminal: `echo <nonce> > harness-echo.txt` —
//      keystrokes ride the uplink, the shell writes the file, and this
//      script reads the nonce back natively. No self-grading.
//   4. asserts on <dir>/.fsio/client/<clientId>/report.json
//
// Reports survive teardown: raw fsio-host wipes .fsio only on *startup*
// under --fresh, never on exit — so unlike the terminal-demo helper (see
// #21's teardown caveat) nothing here needs a preserve mode.
//
// Linux note: headed Chrome needs a display — run under xvfb-run. Headless
// is useless here: it auto-denies the write grant (F15).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sleep, waitFor, readReport, startRig } from "./harness-rig.mjs";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const KEEP = args.has("--keep");
const SKIP_BUILD = args.has("--skip-build");
const PORT = Number(process.env.FSIO_HARNESS_PORT ?? 8766);
const P50_CEILING_MS = 100; // same class as bench/test-smoke.ts (#15)

const log = (...a) => console.log("[harness]", ...a);

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------- main

let rig = null;
let failed = false;
try {
  rig = await startRig({ repo, port: PORT, skipBuild: SKIP_BUILD, log });
  const { dir, page } = rig;

  // Latency bench, both uplink lanes. Verdicts come from report.json,
  // read natively — the reporter flushes every ~1 s.
  const benchEvents = () => (readReport(dir)?.events ?? []).filter((e) => e.type === "bench");
  // The bench controls live inside the collapsed "advanced settings"
  // <details>; Playwright (rightly) refuses to fill invisible inputs.
  await page.evaluate(() => (document.getElementById("b-count").closest("details").open = true));
  async function runBench(uplink) {
    const before = benchEvents().length;
    await page.fill("#b-count", "100");
    await page.selectOption("#b-uplink", uplink);
    await page.click("#run-bench");
    const ev = await waitFor(`bench result (uplink=${uplink})`, () => benchEvents()[before], 120_000, 500);
    const p50 = ev.legs?.rtt?.p50;
    check(`bench uplink=${uplink} p50 ≤ ${P50_CEILING_MS} ms`, typeof p50 === "number" && p50 > 0 && p50 <= P50_CEILING_MS, `p50 ${p50?.toFixed(2)} ms (mode: ${ev.mode})`);
    return ev;
  }
  await runBench("file");
  await runBench("auto"); // dirname fast lane (F10)

  // B4 conformance battery (#35): the page's own structured verdicts —
  // the same button a human clicks in the cooperative loop.
  const confEvents = () => (readReport(dir)?.events ?? []).filter((e) => e.type === "conformance");
  {
    const before = confEvents().length;
    await page.click("#run-conformance");
    const ev = await waitFor("conformance verdicts in report.json", () => confEvents()[before], 120_000, 500);
    const bad = (ev.checks ?? []).filter((c) => !c.ok);
    check(
      `conformance battery: ${ev.passed}/${ev.checks?.length ?? 0} checks pass`,
      (ev.checks?.length ?? 0) > 0 && ev.failed === 0,
      bad.map((c) => `${c.name}: ${c.detail}`).join("; ")
    );
  }

  // Shell echo: keystrokes → uplink → pty shell → file → native read.
  await page.click("#open-term");
  await page.waitForFunction(() => document.getElementById("term-status").textContent.includes("connected"), { timeout: 20_000 });
  const nonce = `fsio-harness-${Date.now().toString(36)}`;
  await page.keyboard.type(`echo ${nonce} > harness-echo.txt`, { delay: 20 });
  await page.keyboard.press("Enter");
  const echoed = await waitFor(
    "shell-written harness-echo.txt",
    () => {
      try {
        return fs.readFileSync(path.join(dir, "harness-echo.txt"), "utf8").trim() === nonce;
      } catch {
        return false;
      }
    },
    20_000
  ).then(() => true, () => false);
  check("shell echo round trip (typed in browser, read natively)", echoed, `nonce ${nonce}`);
  await page.click("#close-term"); // D6-clean close

  // Page-reported errors are failures.
  await sleep(1500); // let the reporter flush
  const report = readReport(dir);
  const errors = (report?.events ?? []).filter((e) => e.type === "error");
  check("no error events in report.json", errors.length === 0, errors.map((e) => e.msg).join("; "));
  check("report.json heartbeat present", !!report?.updated, `updated ${report?.updated}`);
} catch (e) {
  failed = true;
  console.error("\n[harness] FAILED:", e.message ?? e);
  for (const { name, tail } of rig?.children ?? []) {
    if (tail.length) console.error(`\n--- last output from ${name} ---\n${tail.join("\n")}`);
  }
} finally {
  failed ||= checks.some((c) => !c.ok);
  console.log(`\n[harness] ${failed ? "FAIL" : "PASS"} — ${checks.filter((c) => c.ok).length}/${checks.length} checks`);
  if (KEEP) {
    log(`--keep: leaving host, web server, and browser running; shared dir ${rig?.dir}`);
  } else {
    await rig?.teardown();
    if (failed) log(`kept for forensics: ${rig?.dir} (reports under ${rig ? path.join(rig.dir, ".fsio/client") : "?"}/*/report.json)`);
    else if (rig) {
      await sleep(500); // let the host finish dying before we sweep its dir
      try {
        fs.rmSync(rig.run, { recursive: true, force: true });
      } catch {
        // a straggler write recreated something — a leftover run dir is harmless
      }
    }
    process.exit(failed ? 1 : 0);
  }
}
