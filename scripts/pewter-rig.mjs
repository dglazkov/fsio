// The Pewter loop: build a pewter, serve it, drive the shell, read the verdict.
//
// Everything before "drive the page" is automated — a scratch pewter under
// $HOME (never /tmp, F9), a real `pewt serve`, a vite preview of the built
// shell, headed Chrome for Testing, and the CDP directory drop that mints a
// real handle (F14). What is left for the human is one click on Chrome's own
// permission prompt, which is unautomatable by design and is also the whole
// security model (F15).
//
// It does not share startRig() with the workbench harness. That module is an
// instrument the measurement labs depend on, wired to the workbench's host,
// page and markup; parameterizing it to serve a second stack would put every
// lab's trustworthiness behind a refactor nobody asked for. What is shared is
// what is genuinely generic: readReport() and waitFor().
//
// Usage:  npm run pewter-rig
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readReport, waitFor } from "./harness-rig.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const PORT = 8769;
const GRANT_TIMEOUT_MS = Number(process.env.FSIO_GRANT_TIMEOUT_MS ?? 180_000);
const log = (...a) => console.log("[pewter-rig]", ...a);

const banner = (s) => {
  console.log(`\n${"=".repeat(64)}\n  ${s}\n${"=".repeat(64)}\n`);
  if (process.platform === "darwin") {
    spawn("osascript", ["-e", `display notification ${JSON.stringify(s)} with title "pewter rig" sound name "Glass"`], {
      stdio: "ignore",
    }).on("error", () => {});
  }
};

// ---- a pewter to run on
//
// Built here rather than by `create-pewt` on purpose: that scaffolder is the
// next slice, and a rig that depends on it could not run until it exists.
// What this writes is the same shape — and when `create-pewt` lands, this
// function is what it has to agree with.
function makePewter() {
  const runs = path.join(os.homedir(), ".pewter-rig");
  fs.mkdirSync(runs, { recursive: true });
  // Killed runs (grant timeouts, mid-run aborts) leave run-* dirs and their
  // profiles behind; sweep dead ones so the directory does not grow forever
  // and forensics stay findable. A day is enough.
  for (const e of fs.readdirSync(runs)) {
    const p = path.join(runs, e);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.rmSync(p, { recursive: true, force: true });
    } catch {}
  }
  const root = fs.mkdtempSync(path.join(runs, "run-"));

  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "rig-pewter",
        private: true,
        type: "module",
        pewter: {},
        // The script the extension asks the host to run. An extension can
        // only run what a package.json already declares, so the run under
        // test needs one — and this is the whole of it.
        scripts: { hello: `node -e "console.log('hello from the rig pewter')"` },
      },
      null,
      2
    )
  );
  // `pewter` has to resolve from inside the pewter, because that is where
  // esbuild resolves an extension's imports from. A link stands in for the
  // dependency a real pewter installs.
  const modules = path.join(root, "node_modules");
  fs.mkdirSync(modules, { recursive: true });
  fs.symlinkSync(path.join(repo, "packages/pewter"), path.join(modules, "pewter"), "dir");

  fs.mkdirSync(path.join(root, "repos", "site", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "repos", "atlas"), { recursive: true });

  const ext = path.join(root, "extensions", "repos");
  fs.mkdirSync(ext, { recursive: true });
  fs.writeFileSync(
    path.join(ext, "index.html"),
    `<main><h1>Projects</h1><ul id="list"></ul><p id="note">asking the host…</p><p id="ran">no run yet</p><p id="shelled">no shell yet</p></main>\n<script type="module" src="./main.ts"></script>\n`
  );
  // The extension under test: it imports the package, calls the API, and
  // renders the answer. Nothing about it is special to the rig.
  fs.writeFileSync(
    path.join(ext, "main.ts"),
    `import { pewt } from "pewter";

const list = document.getElementById("list")!;
const note = document.getElementById("note")!;

const { repos } = await pewt.repos.list();
for (const repo of repos) {
  const row = document.createElement("li");
  row.textContent = repo.git ? \`\${repo.name} (git)\` : repo.name;
  list.append(row);
}
note.textContent = \`\${repos.length} projects, read through the folder\`;

// A process, asked for from inside the sandbox: the host starts it, its
// output arrives here line by line while it runs, and the call answers with
// its exit code.
const lines: string[] = [];
const { exitCode } = await pewt.run("hello", { onOutput: (line) => lines.push(line) });
document.getElementById("ran")!.textContent = lines.includes("hello from the rig pewter")
  ? \`exit \${exitCode} · the script's line arrived\`
  : \`exit \${exitCode} · nothing the script printed arrived\`;

// A shell, from inside the same sandbox: a real pty on the machine, typed
// into from a frame with no origin of its own. This is the half no headless
// probe covers, because it is the real grant that carries it.
const term: string[] = [];
const shell = await pewt.shell({ onData: (chunk) => term.push(chunk) });
shell.resize(100, 30);
shell.write("echo the-shell-is-live\\n");
for (let i = 0; i < 200 && !term.join("").includes("the-shell-is-live"); i++) {
  await new Promise((r) => setTimeout(r, 25));
}
shell.write("exit 0\\n");
const left = await shell.exit;
document.getElementById("shelled")!.textContent = term.join("").includes("the-shell-is-live")
  ? \`exit \${left} · the shell answered\`
  : \`exit \${left} · nothing came back from the shell\`;

document.title = "projects";
`
  );
  return root;
}

/** Has the shell reported the two things a verdict needs?
 *
 *  The `shell` call is the last one the extension makes, so waiting for it
 *  waits for all of them. A call is recorded when it is answered, and a
 *  shell's answer is its exit code — so this is also the point at which the
 *  pty has already gone.
 *
 *  The reporter spreads its `facts` into the top level of report.json rather
 *  than nesting them under a `facts` key (@fsio/ui/reporter.ts), and the
 *  summary lands under whatever `summaryKey` the page chose — `calls` here.
 *  The first version of this rig read `report.facts.open`, which is always
 *  undefined, so a run in which everything worked timed out waiting for
 *  itself. Exported and pure so it can be checked against a report from a
 *  real run without spending another human click on it. */
export const ready = (report) => (report?.open && report.calls?.some((c) => c.method === "shell") ? report : null);

/** The verdict, as a list of [what, ok, detail]. Pure for the same reason. */
export function verdict({ report, bundleExists, rendered, ran, shelled }) {
  return [
    ["the extension opened", !!report.open, report.open],
    ["its frame has an origin of its own", report.opaqueOrigin === true, report.opaqueOrigin],
    ["the bundle is on disk", bundleExists, bundleExists],
    ["repos.list round-tripped through the API", report.calls.some((c) => c.method === "repos.list" && c.ok), report.calls],
    ["the extension rendered what the host answered", rendered === "2 projects, read through the folder", rendered],
    ["a run the extension asked for started on the machine", report.calls.some((c) => c.method === "run" && c.ok), report.calls],
    ["its output reached the extension, and so did its exit code", ran === "exit 0 · the script's line arrived", ran],
    ["a shell the extension asked for opened on the machine", report.calls.some((c) => c.method === "shell" && c.ok), report.calls],
    ["it took what the extension typed, and answered with its exit code", shelled === "exit 0 · the shell answered", shelled],
  ];
}

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

async function run() {
  log("npm run build (the wireit graph is the ground truth)…");
  if (spawnSync("npm", ["run", "build"], { cwd: repo, stdio: "inherit" }).status !== 0) process.exit(2);

  const root = makePewter();
  log(`pewter: ${root}`);

  // The Chrome profile lives BESIDE the pewter, never inside it. Chrome will
  // not mint a File System Access handle for a directory containing its own
  // user-data-dir, and the way it declines is to leave
  // `getAsFileSystemHandle()` pending forever — no rejection, no console
  // error, just a drop that appears to do nothing. Measured here after the
  // workbench harness, whose comment says the same thing, kept working
  // against the identical page.
  const profile = path.join(path.dirname(root), `${path.basename(root)}-profile`);
  fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
  // Chrome for Testing ships without Google API keys, and its Safe Browsing
  // after-write scan is not stable Chrome's (#37). Same pin the workbench
  // harness uses, for the same reason.
  fs.writeFileSync(
    path.join(profile, "Default", "Preferences"),
    JSON.stringify({ safebrowsing: { enabled: false, enhanced: false } })
  );

  // `--allow-runs` and `--allow-shells` because this host has no terminal: it
  // is a background child of this script, so the question it would otherwise
  // ask before starting a process is one nobody could answer, and the answer
  // to a question nobody can answer is no. Two flags, not one, because they
  // are two capabilities (P3) — and a rig that had to be told about the shell
  // separately is the point of the split rather than a nuisance.
  child("pewt", process.execPath, [
    path.join(repo, "packages/pewt/dist/cli.js"), "--dir", root, "serve", "--no-open", "--allow-runs", "--allow-shells",
  ]);
  child("shell", "npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], path.join(repo, "packages/pewter-shell"));
  await waitFor(
    `http://localhost:${PORT}/`,
    () => fetch(`http://localhost:${PORT}/`).then((r) => r.ok).catch(() => false),
    20_000
  );
  await waitFor("the host's .fsio", () => fs.existsSync(path.join(root, ".fsio")), 15_000);
  log(`host + shell up (http://localhost:${PORT}/)`);

  const { chromium } = await import("playwright");
  if (!fs.existsSync(chromium.executablePath())) {
    log("Chrome for Testing not installed — running `npx playwright install chromium`…");
    if (spawnSync("npx", ["playwright", "install", "chromium"], { cwd: repo, stdio: "inherit" }).status !== 0) {
      throw new Error("playwright install failed");
    }
  }
  // Headed: headless auto-denies the write grant (F15).
  browser = await chromium.launchPersistentContext(profile, { headless: false });
  const page = browser.pages()[0] ?? (await browser.newPage());
  await page.goto(`http://localhost:${PORT}/`);

  // F14: a synthesized directory drop mints a real handle. A picker cannot
  // be synthesized at all, which is why the shell takes a drop.
  const cdp = await browser.newCDPSession(page);
  const vp = page.viewportSize() ?? (await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })));
  const drop = { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2), data: { items: [], files: [root], dragOperationsMask: 1 } };
  await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", ...drop });
  await cdp.send("Input.dispatchDragEvent", { type: "dragOver", ...drop });
  await cdp.send("Input.dispatchDragEvent", { type: "drop", ...drop });
  await page.waitForSelector('body[data-fsio-state="awaiting-grant"]', { timeout: 10_000 });
  log("directory drop accepted; handle minted (F14)");

  await page.click("#grant"); // a real user activation
  banner('CLICK "Allow on every visit" IN THE BROWSER — the only click this run needs');
  await page.waitForSelector('body[data-fsio-state="connected"]', { timeout: GRANT_TIMEOUT_MS });
  log("write granted; connected — unattended from here");

  // The verdict comes off the folder, not off the page: the shell writes
  // .fsio/client/<id>/report.json and this reads it, which is the same loop
  // every other page here is verified by (TESTING.md).
  const report = await waitFor(
    "the shell's report, with the extension open and its shell finished",
    () => ready(readReport(root)),
    30_000
  );

  // Read once, from inside the frame. An earlier version also accepted
  // `page.title() === "Projects"` as a pass — but `page` is the shell, whose
  // title is "Pewter", so that clause could never be true and was quietly
  // widening a check that looked like it had two ways to succeed.
  const read = (selector) =>
    page
      .frameLocator("iframe")
      .locator(selector)
      .textContent()
      .catch((e) => `unreadable: ${e instanceof Error ? e.message : String(e)}`);
  const rendered = await read("#note");
  const ran = await read("#ran");
  const shelled = await read("#shelled");

  const bundle = path.join(root, ".pewter", "build", "repos.html");
  const checks = verdict({ report, bundleExists: fs.existsSync(bundle), rendered, ran, shelled });

  console.log();
  let failed = 0;
  for (const [what, ok, detail] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${what}`);
    if (!ok) {
      failed++;
      console.log(`      ${JSON.stringify(detail)}`);
    }
  }
  console.log(`\n  report: ${path.join(root, ".fsio", "client")}\n  pewter: ${root}\n`);
  return failed;
}

// Only when run, never when imported. `ready` and `verdict` above are
// exported so they can be checked against a real report without spending a
// human click — and an import that launched a browser and drove a whole run
// instead would be a nasty surprise for whoever tried it. (It was.)
const invoked = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invoked) {
  let code = 1;
  try {
    code = (await run()) === 0 ? 0 : 1;
  } catch (e) {
    console.error(`[pewter-rig] ${e instanceof Error ? e.message : String(e)}`);
    for (const { name, tail } of children) {
      if (tail.length) console.error(`\n--- ${name} ---\n${tail.join("\n")}`);
    }
  } finally {
    await teardown();
  }
  process.exit(code);
}
