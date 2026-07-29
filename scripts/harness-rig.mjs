// Shared browser rig (#21 → #42/#43): everything before "drive the page" —
// build, fresh shared dir under $HOME (F9), Safe-Browsing-off profile
// (#37), real host + vite preview of the built workbench, headed Chrome
// for Testing via Playwright, the CDP directory drop (F14), and the one
// human grant click (F15). The one-click harness and the measurement labs
// differ only in what they do after `connected`; this module is the part
// they must not drift on.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(what, fn, timeoutMs, everyMs = 250) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await sleep(everyMs);
  }
}

/** Per-client report dirs (#39): each page load writes its own
 *  client/<clientId>/report.json — scan and take the newest by mtime. The
 *  rig's page is the only live writer here, but a mid-run reload would
 *  leave an older sibling behind; recency picks the live one. If the newest
 *  is torn mid-write (F11-class), that's a retry, not an error — and never
 *  a reason to fall back to a stale sibling. */
export function readReport(dir) {
  const root = path.join(dir, ".fsio", "client");
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest = null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(root, e.name, "report.json");
    try {
      const mtime = fs.statSync(p).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { p, mtime };
    } catch {}
  }
  if (!newest) return null;
  try {
    return JSON.parse(fs.readFileSync(newest.p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Bring the whole rig up, through the human grant click, to `connected`.
 * Returns { dir, run, profile, page, browser, children, teardown }.
 */
export async function startRig({
  repo,
  port,
  skipBuild = false,
  grantTimeoutMs = 180_000,
  // Measuring background behavior needs BOTH of these, learned run by run:
  //  - Playwright's default switches disable the throttling itself
  //    (--disable-background-timer-throttling & friends): run 2 of the
  //    background lab saw a flat 5 ms through 8 min of "background".
  //  - Worse, ANY attached Playwright session force-emulates focus: a
  //    covered tab stays visibilityState=visible with timers unthrottled
  //    even with the flags stripped and a same-window tab in front (probes
  //    3/4, #42). The emulation dies with the session.
  // So detachable mode spawns stock Chrome for Testing manually (clean
  // command line by construction), drives it via connectOverCDP, and lets
  // the caller detach() for measurement phases and reattach() to drive
  // again. The harness keeps the plain Playwright launch: it never
  // backgrounds anything, and automation-friendly defaults are what a
  // driver wants.
  detachable = false,
  log = (...a) => console.log("[rig]", ...a),
} = {}) {
  const banner = (s) => console.log(`\n${"=".repeat(64)}\n  ${s}\n${"=".repeat(64)}\n`);

  if (!skipBuild) {
    log("npm run build (wireit graph is the ground truth)…");
    const r = spawnSync("npm", ["run", "build"], { cwd: repo, stdio: "inherit" });
    if (r.status !== 0) process.exit(2);
  }

  // Shared dir under $HOME, never /tmp (F9). The Chrome profile lives
  // *beside* the shared dir, not inside it — the dropped handle covers the
  // whole shared dir and profile churn is not part of the experiment.
  const runsDir = path.join(os.homedir(), ".fsio-harness");
  fs.mkdirSync(runsDir, { recursive: true });
  const run = fs.mkdtempSync(path.join(runsDir, "run-"));
  const dir = path.join(run, "shared");
  const profile = path.join(run, "profile");
  fs.mkdirSync(dir, { recursive: true });
  log(`shared dir: ${dir}`);

  // Chrome for Testing ships without Google API keys: its Safe Browsing
  // after-write scan is NOT stable Chrome's ~68 ms delay (F7) — it was
  // observed to hard-abort commits mid-bench (#37). Pin the configuration
  // F7's A/B already measured (No protection): the rig is for measuring
  // OUR stack; F7-class platform truth stays with the cooperative loop on
  // stable Chrome and the drift job (#22).
  fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
  fs.writeFileSync(
    path.join(profile, "Default", "Preferences"),
    JSON.stringify({ safebrowsing: { enabled: false, enhanced: false } })
  );

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

  // From here on, failure must not leak processes: the caller has no rig
  // object yet, so an unwound startRig tears down its own children (the
  // grant-timeout path proved this the hard way — a browser, host, and
  // vite preview all survived the throw).
  let browser = null;
  async function teardown() {
    await browser?.close().catch(() => {});
    for (const { p } of children) p.kill("SIGTERM");
  }
  try {
    return await start();
  } catch (e) {
    await teardown();
    throw e;
  }

  async function start() {
  // Playwright + browser preflight.
  const { chromium } = await import("playwright");
  if (!fs.existsSync(chromium.executablePath())) {
    log("Chrome for Testing not installed — running `npx playwright install chromium`…");
    const r = spawnSync("npx", ["playwright", "install", "chromium"], { cwd: repo, stdio: "inherit" });
    if (r.status !== 0) throw new Error("playwright install failed");
  }

  // Real host + static server for the built workbench.
  child("host", process.execPath, [path.join(repo, "packages/host/dist/fsio-host.js"), dir, "--fresh", "--allow-shell"]);
  child("web", "npx", ["vite", "preview", "--port", String(port), "--strictPort"], path.join(repo, "packages/workbench"));
  await waitFor(`http://localhost:${port}/`, () => fetch(`http://localhost:${port}/`).then((r) => r.ok).catch(() => false), 15_000);
  log(`host + workbench up (http://localhost:${port}/)`);

  // Headed browser (headless auto-denies the write grant — F15), on the
  // prepared profile so the Safe Browsing pref above takes effect.
  const cdpPort = port + 100;
  const cdpUrl = `http://localhost:${cdpPort}`;
  let context;
  let page;
  if (detachable) {
    child("chrome", chromium.executablePath(), [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${cdpPort}`,
      "--no-first-run",
      "--no-default-browser-check",
      `http://localhost:${port}/`,
    ]);
    await waitFor("chrome CDP endpoint", () => fetch(`${cdpUrl}/json/version`).then((r) => r.ok).catch(() => false), 20_000);
    browser = await chromium.connectOverCDP(cdpUrl);
    context = browser.contexts()[0];
    page = await waitFor("workbench page", () => context.pages().find((p) => p.url().includes(`localhost:${port}`)), 15_000, 100);
  } else {
    browser = await chromium.launchPersistentContext(profile, { headless: false });
    context = browser;
    page = browser.pages()[0] ?? (await browser.newPage());
    await page.goto(`http://localhost:${port}/`);
  }

  // F14: synthesized directory drop mints a real handle.
  const cdp = await context.newCDPSession(page);
  // connectOverCDP pages have no viewport emulation (viewportSize() is
  // null) — ask the window itself.
  const vp = page.viewportSize() ?? (await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })));
  const drop = { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2), data: { items: [], files: [dir], dragOperationsMask: 1 } };
  await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", ...drop });
  await cdp.send("Input.dispatchDragEvent", { type: "dragOver", ...drop });
  await cdp.send("Input.dispatchDragEvent", { type: "drop", ...drop });
  await page.waitForSelector('body[data-fsio-state="awaiting-grant"]', { timeout: 10_000 });
  log("directory drop accepted; handle minted (F14)");

  // F15: the one human click.
  await page.click("#grant"); // real user activation
  banner('CLICK "Allow on every visit" IN THE BROWSER — the only click needed');
  await page.waitForSelector('body[data-fsio-state="connected"]', { timeout: grantTimeoutMs });
  log("write granted; page connected — unattended from here");

  const rig = { dir, run, profile, page, browser, context, children, teardown };
  if (detachable) {
    /** Drop the CDP connection (Chrome keeps running, F15 grant survives —
     *  same browser session). Playwright's focus emulation dies with it,
     *  so covered tabs become genuinely hidden. */
    rig.detach = async () => {
      await browser.close(); // connectOverCDP: closes the connection only
      browser = null;
      rig.browser = rig.context = rig.page = null;
    };
    /** Reconnect and rebind context/page (old handles are dead). */
    rig.reattach = async () => {
      browser = await chromium.connectOverCDP(cdpUrl);
      rig.browser = browser;
      rig.context = browser.contexts()[0];
      rig.page = await waitFor("workbench page after reattach", () => rig.context.pages().find((p) => p.url().includes(`localhost:${port}`)), 15_000, 100);
      return rig.page;
    };
  }
  return rig;
  }
}

/**
 * A cover tab in the SAME window as the workbench, switchable via CDP
 * (window.open is popup-blocked in stock Chrome; Playwright's newPage()
 * opens a separate window that never hides the workbench). Sessions are
 * minted per call because detach() kills them. Remember: with any CDP
 * client attached the workbench stays visibilityState=visible regardless
 * of the active tab (F16 method note) — activate, then detach.
 */
export async function coverTab(rig, port) {
  const cdp = await rig.context.newCDPSession(rig.page);
  const blank = (await cdp.send("Target.createTarget", { url: "about:blank", background: true })).targetId;
  const workbench = (await cdp.send("Target.getTargets")).targetInfos.find(
    (t) => t.type === "page" && t.url.includes(`localhost:${port}`)
  )?.targetId;
  if (!workbench) throw new Error("could not find the workbench tab target");
  return {
    activate: async (which) => {
      const s = await rig.context.newCDPSession(rig.page);
      await s.send("Target.activateTarget", { targetId: which === "blank" ? blank : workbench });
    },
  };
}

function parseCputime(s) {
  // ps cputime: [[dd-]hh:]mm:ss.cc
  const m = s.trim().match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return (Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/**
 * Exact cumulative CPU seconds per Chrome process (+ the host process).
 * For small-magnitude cells (#43's idle matrix) the decayed `ps %cpu`
 * average smears phase boundaries; snapshotting cputime at a cell's start
 * and end and dividing the delta by wall time is exact. Same tree walk as
 * sampleChromeProcesses.
 */
export function sampleCpuTimes(profile, hostPid) {
  const out = spawnSync("ps", ["-axo", "pid=,ppid=,cputime=,rss=,command="], { encoding: "utf8" });
  if (out.status !== 0) return { at: Date.now(), procs: [], host: null };
  const rows = out.stdout
    .split("\n")
    .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], cpuSec: parseCputime(m[3]), rssMb: +m[4] / 1024, command: m[5] }))
    .filter((r) => r.cpuSec != null);
  const main = rows.find((r) => r.command.includes(`--user-data-dir=${profile}`));
  const procs = [];
  if (main) {
    const keep = new Map([[main.pid, { ...main, type: "browser" }]]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const r of rows) {
        if (keep.has(r.pid) || !keep.has(r.ppid)) continue;
        const m = r.command.match(/--type=(\S+)/);
        let type = m ? m[1] : "helper";
        const sub = r.command.match(/--utility-sub-type=(\S+)/);
        if (type === "utility" && sub) type = `utility:${sub[1].split(".").pop()}`;
        keep.set(r.pid, { ...r, type });
        grew = true;
      }
    }
    for (const { pid, type, cpuSec, rssMb } of keep.values()) procs.push({ pid, type, cpuSec, rssMb });
  }
  const host = rows.find((r) => r.pid === hostPid);
  return { at: Date.now(), procs, host: host ? { cpuSec: host.cpuSec, rssMb: host.rssMb } : null };
}

/**
 * Sample every Chrome process of this rig (#43: the cost lands in three
 * processes; a DevTools profile of the tab undercounts by construction).
 * The main process is found by its --user-data-dir=<profile> argument;
 * descendants are walked via ppid. Returns [{pid, type, pcpu, rssMb}].
 */
export function sampleChromeProcesses(profile) {
  const out = spawnSync("ps", ["-axo", "pid=,ppid=,pcpu=,rss=,command="], { encoding: "utf8" });
  if (out.status !== 0) return [];
  const rows = out.stdout
    .split("\n")
    .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], pcpu: +m[3], rssMb: +m[4] / 1024, command: m[5] }));
  const main = rows.find((r) => r.command.includes(`--user-data-dir=${profile}`));
  if (!main) return [];
  const keep = new Map([[main.pid, { ...main, type: "browser" }]]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      if (keep.has(r.pid) || !keep.has(r.ppid)) continue;
      const m = r.command.match(/--type=(\S+)/);
      let type = m ? m[1] : "helper";
      // The storage service is where FSA brokering runs (#43); name it.
      const sub = r.command.match(/--utility-sub-type=(\S+)/);
      if (type === "utility" && sub) type = `utility:${sub[1].split(".").pop()}`;
      keep.set(r.pid, { ...r, type });
      grew = true;
    }
  }
  return [...keep.values()].map(({ pid, type, pcpu, rssMb }) => ({ pid, type, pcpu, rssMb }));
}
