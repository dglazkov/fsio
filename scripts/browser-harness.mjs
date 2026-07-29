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
// Mechanism (F14/F15, measured in the #19 spike):
//   1. real host + `vite preview` of the built workbench, on a fresh shared
//      dir under $HOME (never /tmp — F9: observers break there)
//   2. headed Chrome for Testing via Playwright; CDP Input.dispatchDragEvent
//      synthesizes a directory drop → the page mints a real handle (F14)
//   3. page.click('#grant') provides the user activation; the human answers
//      Chrome's prompt — the one click (F15)
//   4. drives the page's own buttons: latency bench in both uplink lanes,
//      then types into the real terminal: `echo <nonce> > harness-echo.txt`
//      — keystrokes ride the uplink, the shell writes the file, and this
//      script reads the nonce back from the native side. No self-grading.
//   5. asserts on <dir>/.fsio/client/report.json with the same generous
//      ceiling as the node smoke (100 ms p50 — regression class, not jitter)
//
// Reports survive teardown: raw fsio-host wipes .fsio only on *startup*
// under --fresh, never on exit — so unlike the terminal-demo helper (see
// #21's teardown caveat) nothing here needs a preserve mode.
//
// Linux note: headed Chrome needs a display — run under xvfb-run. Headless
// is useless here: it auto-denies the write grant (F15).

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const KEEP = args.has("--keep");
const SKIP_BUILD = args.has("--skip-build");
const PORT = Number(process.env.FSIO_HARNESS_PORT ?? 8766);
const P50_CEILING_MS = 100; // same class as bench/test-smoke.ts (#15)
const GRANT_TIMEOUT_MS = 180_000; // human reaction time

const log = (...a) => console.log("[harness]", ...a);
const banner = (s) =>
  console.log(`\n${"=".repeat(64)}\n  ${s}\n${"=".repeat(64)}\n`);

// ---------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, timeoutMs, everyMs = 250) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await sleep(everyMs);
  }
}

/** report.json can be torn mid-write (F11-class): parse failures are retries, not errors. */
function readReport(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, ".fsio", "client", "report.json"), "utf8"));
  } catch {
    return null;
  }
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------- setup

if (!SKIP_BUILD) {
  log("npm run build (wireit graph is the ground truth)…");
  const r = spawnSync("npm", ["run", "build"], { cwd: repo, stdio: "inherit" });
  if (r.status !== 0) process.exit(2);
}

// Shared dir under $HOME, never /tmp (F9).
const runsDir = path.join(os.homedir(), ".fsio-harness");
fs.mkdirSync(runsDir, { recursive: true });
const dir = fs.mkdtempSync(path.join(runsDir, "run-"));
log(`shared dir: ${dir}`);

const children = [];
function child(name, cmd, argv, cwd) {
  const p = spawn(cmd, argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const tail = [];
  const sink = (d) => {
    for (const line of String(d).split("\n")) if (line.trim()) tail.push(line);
    if (tail.length > 40) tail.splice(0, tail.length - 40);
  };
  p.stdout.on("data", sink);
  p.stderr.on("data", sink);
  children.push({ name, p, tail });
  return p;
}

let browser = null;
async function teardown() {
  await browser?.close().catch(() => {});
  for (const { p } of children) p.kill("SIGTERM");
}

// ---------------------------------------------------------------- main

let failed = false;
try {
  // Playwright + browser preflight.
  const { chromium } = await import("playwright");
  if (!fs.existsSync(chromium.executablePath())) {
    log("Chrome for Testing not installed — running `npx playwright install chromium`…");
    const r = spawnSync("npx", ["playwright", "install", "chromium"], { cwd: repo, stdio: "inherit" });
    if (r.status !== 0) throw new Error("playwright install failed");
  }

  // Real host + static server for the built workbench.
  child("host", process.execPath, [path.join(repo, "packages/host/dist/fsio-host.js"), dir, "--fresh", "--allow-shell"]);
  child("web", "npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], path.join(repo, "packages/workbench"));
  await waitFor(`http://localhost:${PORT}/`, () => fetch(`http://localhost:${PORT}/`).then((r) => r.ok).catch(() => false), 15_000);
  log(`host + workbench up (http://localhost:${PORT}/)`);

  // Headed browser (headless auto-denies the write grant — F15).
  browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/`);

  // F14: synthesized directory drop mints a real handle.
  const cdp = await page.context().newCDPSession(page);
  const vp = page.viewportSize();
  const drop = { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2), data: { items: [], files: [dir], dragOperationsMask: 1 } };
  await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", ...drop });
  await cdp.send("Input.dispatchDragEvent", { type: "dragOver", ...drop });
  await cdp.send("Input.dispatchDragEvent", { type: "drop", ...drop });
  await page.waitForSelector('body[data-fsio-state="awaiting-grant"]', { timeout: 10_000 });
  log("directory drop accepted; handle minted (F14)");

  // F15: the one human click.
  await page.click("#grant"); // real user activation
  banner('CLICK "Allow on every visit" IN THE BROWSER — the only click needed');
  await page.waitForSelector('body[data-fsio-state="connected"]', { timeout: GRANT_TIMEOUT_MS });
  log("write granted; page connected — unattended from here");

  // Latency bench, both uplink lanes. Verdicts come from report.json,
  // read natively — the reporter flushes every ~1 s.
  const benchEvents = () => (readReport(dir)?.events ?? []).filter((e) => e.type === "bench");
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
  for (const { name, tail } of children) {
    if (tail.length) console.error(`\n--- last output from ${name} ---\n${tail.join("\n")}`);
  }
} finally {
  failed ||= checks.some((c) => !c.ok);
  console.log(`\n[harness] ${failed ? "FAIL" : "PASS"} — ${checks.filter((c) => c.ok).length}/${checks.length} checks`);
  if (KEEP) {
    log(`--keep: leaving host, web server, and browser running; shared dir ${dir}`);
  } else {
    await teardown();
    if (failed) log(`kept for forensics: ${dir} (report at ${path.join(dir, ".fsio/client/report.json")})`);
    else {
      await sleep(500); // let the host finish dying before we sweep its dir
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // a straggler write recreated something — a leftover run dir is harmless
      }
    }
    process.exit(failed ? 1 : 0);
  }
}
