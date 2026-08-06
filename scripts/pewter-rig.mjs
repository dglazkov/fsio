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
import { ADAPTERS } from "../packages/pewt/dist/agents.js";
import { readReport, waitFor } from "./harness-rig.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const PORT = 8769;
const GRANT_TIMEOUT_MS = Number(process.env.FSIO_GRANT_TIMEOUT_MS ?? 180_000);
/** The file the run opens, flings, and then deletes. Its length is what the
 *  catalog is checked against: the page reported a size it could only have
 *  learned by opening the file itself. */
const NOTES = "notes.md";
const NOTES_TEXT = "the file this run opens and flings\n";
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

  // An ACP adapter, exactly where `npm i` would leave one: the package, and
  // its binary linked into node_modules/.bin. That is what the roster reads,
  // so this is the real lookup rather than a way around it. A fixture and not
  // a real adapter because a rig must not need a model, a credential, or a
  // network — and because a real one phrases things differently every run.
  const adapter = ADAPTERS[0];
  const pkgDir = path.join(modules, ...adapter.pkg.split("/"));
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: adapter.pkg, version: adapter.measured }));
  const agentBin = path.join(modules, ".bin", adapter.bin);
  fs.mkdirSync(path.dirname(agentBin), { recursive: true });
  fs.writeFileSync(
    agentBin,
    `#!/usr/bin/env node
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  for (;;) {
    const at = buf.indexOf("\\n");
    if (at === -1) break;
    const line = buf.slice(0, at);
    buf = buf.slice(at + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "leave") process.exit(0);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { saw: msg.method } }) + "\\n");
  }
});
`
  );
  fs.chmodSync(agentBin, 0o755);

  fs.mkdirSync(path.join(root, "repos", "site", ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "repos", "atlas"), { recursive: true });

  // A file for `pewt open` and `pewt fling` to be about. It is deleted partway
  // through the run, which is the one moment a window and a copy stop looking
  // alike — and the only way to measure the difference the two commands exist
  // to make.
  fs.writeFileSync(path.join(root, NOTES), NOTES_TEXT);

  // A second extension, so that "open a tab" has something to open that is
  // not the one already on screen. Trivial on purpose: what is under test is
  // that a tab appears, not what is in it.
  const chat = path.join(root, "extensions", "chat");
  fs.mkdirSync(chat, { recursive: true });
  fs.writeFileSync(path.join(chat, "index.html"), `<main><h1>Chat</h1></main>\n<script type="module" src="./main.ts"></script>\n`);
  fs.writeFileSync(path.join(chat, "main.ts"), `document.title = "chat";\n`);

  const ext = path.join(root, "extensions", "repos");
  fs.mkdirSync(ext, { recursive: true });
  fs.writeFileSync(
    path.join(ext, "index.html"),
    `<main><h1>Projects</h1><ul id="list"></ul><p id="note">asking the host…</p><p id="ran">no run yet</p><p id="shelled">no shell yet</p><p id="talked">no agent yet</p><p id="tabbed">no tab yet</p><p id="filed">no file yet</p></main>\n<script type="module" src="./main.ts"></script>\n`
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

// An ACP agent, from the same sandbox, against a real adapter this pewter
// depends on. The extension is the client: what crosses is whole messages.
const heard: unknown[] = [];
const agent = await pewt.agent({ onMessage: (m) => heard.push(m) });
agent.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
for (let i = 0; i < 200 && heard.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
agent.send({ jsonrpc: "2.0", method: "leave" });
const agentLeft = await agent.exit;
const answered = heard[0] as { result?: { saw?: string } } | undefined;
document.getElementById("talked")!.textContent = answered?.result?.saw === "initialize"
  ? \`exit \${agentLeft} · the agent answered\`
  : \`exit \${agentLeft} · nothing came back from the agent\`;

// A tab, asked for from inside the sandbox. Every call above this one travels
// to the host; this one stops at the shell, which is the only party that knows
// what a tab is. Nothing in the extension says which kind it made.
const { id } = await pewt.tabs.add({ name: "chat", activate: false });
const { tabs } = await pewt.tabs.list();
document.getElementById("tabbed")!.textContent = \`\${id} · \${tabs.length} open\`;

// A file, asked for from inside the sandbox. What crosses is a path: this
// frame has an origin of its own and no folder grant at all, so the shell is
// the party that opens the file — which is the whole reason \`open\` costs no
// frames and \`fling\` has no size limit.
const view = await pewt.open("${NOTES}", { activate: false });
const { files } = await pewt.files.list();
document.getElementById("filed")!.textContent = \`\${view.path} → \${view.id} · \${files.length} held\`;

document.title = "projects";
`
  );
  return root;
}

/** Has the shell reported the two things a verdict needs?
 *
 *  The `files.list` call is the last one the extension makes, so waiting for it
 *  waits for all of them. A call is recorded when it is answered, and a
 *  shell's answer is its exit code — so by then the pty has already gone.
 *
 *  The reporter spreads its `facts` into the top level of report.json rather
 *  than nesting them under a `facts` key (@fsio/ui/reporter.ts), and the
 *  summary lands under whatever `summaryKey` the page chose — `calls` here.
 *  The first version of this rig read `report.facts.open`, which is always
 *  undefined, so a run in which everything worked timed out waiting for
 *  itself. Exported and pure so it can be checked against a report from a
 *  real run without spending another human click on it. */
export const ready = (report) => (report?.open && report.calls?.some((c) => c.method === "files.list") ? report : null);

/** A report's view of one reference, by key (pewter-shell/web/files.ts). */
const view = (report, key) => report?.views?.find((v) => v.key === key);

/** The verdict, as a list of [what, ok, detail]. Pure for the same reason. */
export function verdict({
  report,
  bundleExists,
  rendered,
  ran,
  shelled,
  talked,
  tabbed,
  filed,
  noPage,
  listed,
  added,
  afterAdd,
  closed,
  afterClose,
  outside,
  flung,
  afterFling,
  afterDelete,
  files,
  dropped,
  afterDrop,
}) {
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
    ["an agent the extension asked for started from this pewter's own node_modules", report.calls.some((c) => c.method === "agent" && c.ok), report.calls],
    ["and a whole ACP message crossed the sandbox in each direction", talked === "exit 0 · the agent answered", talked],
    // The page's own operations. Everything above is answered on the machine;
    // these are answered in the browser, and the interesting half is that a
    // terminal can reach them at all.
    // The id is the page's own and is random, so this matches its shape
    // rather than a value. A rig that expected `tab-2` would be asserting
    // that ids are sequential, which is a claim nothing makes.
    ["an extension opened a tab through the shell rather than the host", /^tab-[0-9a-f]+ · 2 open$/.test(tabbed ?? ""), tabbed],
    // A file, and the read that produced it. The extension sent a path; the
    // page opened the file through the grant, which nothing in the frame has.
    ["an extension put a file in a tab by naming it", new RegExp(`^${NOTES} → tab-[0-9a-f]+ · 0 held$`).test(filed ?? ""), filed],
    ["and the page read it through the grant, not through a session", view(report, `file:${NOTES}`)?.missing === false, report.views],
    ["`pewt tabs` with no page open is exit 4, not exit 3", noPage?.status === 4 && /no page is open/.test(noPage.stderr ?? ""), noPage],
    ["`pewt tabs` in a terminal lists what the browser is holding", listed?.status === 0 && /repos/.test(listed.stdout ?? "") && /chat/.test(listed.stdout ?? ""), listed],
    ["`pewt tabs add` in a terminal put a fourth tab in the page", added?.status === 0 && afterAdd?.tabs?.length === 4, added],
    ["and the page brought it forward, which is what the receipt said", afterAdd?.tabs?.at(-1)?.active === true, afterAdd?.tabs],
    ["`pewt tabs close` in a terminal took it back out", closed?.status === 0 && afterClose?.tabs?.length === 3, closed],
    // The file half, from a terminal. Everything above about tabs is state the
    // page invented; this is state the page read off the machine's disk with
    // its own hands, on the strength of a path somebody typed.
    ["`pewt open` on a path outside the pewter is refused before it travels", outside?.status === 2 && /outside/.test(outside.stderr ?? ""), outside],
    ["`pewt fling` in a terminal gave the page custody of a copy", flung?.status === 0 && afterFling?.held?.length === 1, flung],
    ["and the copy's bytes are the file's, read through the grant", afterFling?.held?.[0]?.size === NOTES_TEXT.length, afterFling?.held],
    // The claim both commands exist to make, and the only moment it is
    // visible: one file deleted, two tabs, two different answers.
    ["with the file deleted, the window says it is gone", view(afterDelete, `file:${NOTES}`)?.missing === true, afterDelete?.views],
    ["and the copy carries on, because the page holds those bytes", view(afterDelete, `held:${afterFling?.held?.[0]?.id}`)?.missing === false, afterDelete?.views],
    ["`pewt files` in a terminal lists what the page has custody of", files?.status === 0 && new RegExp(NOTES).test(files.stdout ?? ""), files],
    ["`pewt files drop` freed it and closed the tab showing it", dropped?.status === 0 && afterDrop?.held?.length === 0 && afterDrop?.tabs?.length === 3, dropped],
  ];
}

/** One `pewt` invocation against this pewter, as a terminal would run it.
 *
 *  Synchronous on purpose: the page and the host are separate processes, so
 *  blocking here blocks nothing that has to keep moving — and the command's
 *  whole point is that it waits for a browser to answer. */
const pewt = (root, argv) =>
  spawnSync(process.execPath, [path.join(repo, "packages/pewt/dist/cli.js"), "--dir", root, ...argv], { encoding: "utf8" });

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
    path.join(repo, "packages/pewt/dist/cli.js"), "--dir", root, "serve", "--no-open", "--allow-runs", "--allow-shells", "--allow-agents",
  ]);
  child("shell", "npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], path.join(repo, "packages/pewter-shell"));
  await waitFor(
    `http://localhost:${PORT}/`,
    () => fetch(`http://localhost:${PORT}/`).then((r) => r.ok).catch(() => false),
    20_000
  );
  await waitFor("the host's .fsio", () => fs.existsSync(path.join(root, ".fsio")), 15_000);
  log(`host + shell up (http://localhost:${PORT}/)`);

  // Exit 4, measured before the browser exists. A host is running and a page
  // is not, which is the one moment those two are unambiguously different —
  // and it costs nothing to ask here.
  const noPage = pewt(root, ["tabs"]);
  log(`pewt tabs with no page: exit ${noPage.status}`);

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

  // Read once, from inside the frame — and name which frame. An earlier
  // version also accepted `page.title() === "Projects"` as a pass, but `page`
  // is the shell, whose title is "Pewter", so that clause could never be true
  // and was quietly widening a check that looked like it had two ways to
  // succeed. A later one said `frameLocator("iframe")`, which was
  // unambiguous only while the shell held exactly one tab: the moment the
  // extension opened a second, every read failed with a strict-mode violation
  // and five checks reported the subject broken when the instrument was.
  // The title is the bridge's (`<name> (extension)`).
  const read = (selector) =>
    page
      .frameLocator('iframe[title="repos (extension)"]')
      .locator(selector)
      .textContent()
      .catch((e) => `unreadable: ${e instanceof Error ? e.message : String(e)}`);
  const rendered = await read("#note");
  const ran = await read("#ran");
  const shelled = await read("#shelled");
  const talked = await read("#talked");
  const tabbed = await read("#tabbed");
  const filed = await read("#filed");

  // The terminal half of the round trip, and the only place it can be
  // measured: a command typed on this machine, forwarded by the host down the
  // session the browser holds, answered in the browser, and back. Nothing
  // short of a real page can stand in for the middle of that.
  const listed = pewt(root, ["tabs"]);
  const added = pewt(root, ["tabs", "add", "chat", "--json"]);
  log(`pewt tabs add chat: exit ${added.status} ${added.stdout?.trim()}`);
  // A wait that gives up returns the last report rather than throwing: this
  // is the verdict's evidence, and a run that ends in a stack trace instead of
  // a list of checks has spent a human's click to say nothing.
  const settle = (what, ok) =>
    waitFor(what, () => (ok(readReport(root)) ? readReport(root) : null), 15_000).catch(() => readReport(root));

  const afterAdd = await settle("the page to report four tabs", (r) => r?.tabs?.length === 4);
  const id = JSON.parse(added.stdout || "{}").id;
  const closed = pewt(root, ["tabs", "close", String(id)]);
  const afterClose = await settle("the page to report the tab gone", (r) => r?.tabs?.length === 3 && !r.tabs.some((t) => t.id === id));

  // ---- the file half
  //
  // A path outside the pewter never travels: the command line resolves what
  // was typed against the folder and refuses what lands outside it, so this
  // exits 2 without a host or a page being involved at all.
  const outside = pewt(root, ["open", "../escaped.md"]);
  log(`pewt open ../escaped.md: exit ${outside.status}`);

  const flung = pewt(root, ["fling", NOTES, "--json"]);
  log(`pewt fling ${NOTES}: exit ${flung.status} ${flung.stdout?.trim()}`);
  const afterFling = await settle("the page to report a copy in its catalog", (r) => r?.held?.length === 1);
  const fileId = afterFling?.held?.[0]?.id;

  // The one moment a window and a copy stop looking alike. The window polls
  // its file every 2 s, so this waits for the poll rather than for a command.
  fs.rmSync(path.join(root, NOTES));
  log(`deleted ${NOTES} — waiting for the window onto it to notice`);
  const afterDelete = await waitFor(
    "the window to report its file gone, with the copy still there",
    () => {
      const r = readReport(root);
      const window = r?.views?.find((v) => v.key === `file:${NOTES}`);
      const copy = r?.views?.find((v) => v.key === `held:${fileId}`);
      return window?.missing === true && copy?.missing === false ? r : null;
    },
    20_000
  ).catch(() => readReport(root));

  const files = pewt(root, ["files"]);
  const dropped = pewt(root, ["files", "drop", String(fileId)]);
  log(`pewt files drop ${fileId}: exit ${dropped.status}`);
  const afterDrop = await settle("the page to report the copy gone", (r) => r?.held?.length === 0 && r?.tabs?.length === 3);

  // What a report cannot say: whether the strip looks like a strip. Written
  // beside the pewter rather than inside it, for the same reason the Chrome
  // profile is — nothing that is not the channel goes in the folder.
  const shot = `${root}-screen.png`;
  await page.screenshot({ path: shot }).catch(() => {});

  const bundle = path.join(root, ".pewter", "build", "repos.html");
  const checks = verdict({
    report,
    bundleExists: fs.existsSync(bundle),
    rendered,
    ran,
    shelled,
    talked,
    tabbed,
    filed,
    noPage,
    listed,
    added,
    afterAdd,
    closed,
    afterClose,
    outside,
    flung,
    afterFling,
    afterDelete,
    files,
    dropped,
    afterDrop,
  });

  console.log();
  let failed = 0;
  for (const [what, ok, detail] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${what}`);
    if (!ok) {
      failed++;
      console.log(`      ${JSON.stringify(detail)}`);
    }
  }
  console.log(`\n  report: ${path.join(root, ".fsio", "client")}\n  pewter: ${root}\n  screen: ${shot}\n`);
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
