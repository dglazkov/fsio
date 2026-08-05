// The extension pipeline, in a real browser, with no folder and no click.
//
// This is the half of the skeleton that a headless browser can judge on its
// own: source is bundled into one self-contained file, mounted in a sandboxed
// iframe with no `allow-same-origin`, and reaches an API over a message
// channel. None of that touches the File System Access API, so none of it
// needs the grant that `npm run pewter-rig` needs a human for.
//
// What it deliberately does NOT cover: the shell's own page — its folder
// grant, its session, and `bridge.ts` itself. The parent half below is a
// stand-in that mirrors bridge.ts's handshake in about five lines. The real
// one is what the rig exercises, once clicked.
//
// The extension it builds awaits an API call on its first line, which is the
// ordinary shape and the one the scaffolded extension has. That timing is
// the interesting part: the extension announces itself and its call waits in
// the channel until the port lands, and this is where that stays checked.
//
// Usage:  npm run bridge-probe
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { bundleExtension, pewterAt } from "../packages/pewt/dist/index.js";
import { WIRE_VERSION } from "../packages/pewter/dist/index.js";

const repo = path.resolve(import.meta.dirname, "..");
const log = (...a) => console.log("[bridge-probe]", ...a);

// ---- a pewter with one extension in it, built without a host
//
// `bundleExtension` is the same function the `ext.bundle` operation calls;
// going through the host as well would add a session and prove nothing more
// about the browser half.
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bridge-probe-"));
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "probe", pewter: {} }));
fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
fs.symlinkSync(path.join(repo, "packages/pewter"), path.join(root, "node_modules/pewter"), "dir");

const ext = path.join(root, "extensions", "probe");
fs.mkdirSync(ext, { recursive: true });
fs.writeFileSync(
  path.join(ext, "index.html"),
  `<body><p id="out">nothing yet</p><pre id="log"></pre><p id="code">no run yet</p><pre id="term"></pre><p id="left">no shell yet</p><script type="module" src="./main.ts"></script></body>`
);
// Top-level await on the first line, on purpose: this is the shape that
// deadlocks against a load-event handshake.
//
// The run below is the second thing under test: an operation whose output
// arrives while it is still running. The callback stays in this frame — only
// its call's id crosses the channel — so this is where that survives a real
// sandbox rather than a MessageChannel in Node.
//
// The shell is the third, and it is the first thing that talks *back* across
// the sandbox: keystrokes and a window size leave the frame after the call
// that carried them was made. Everything before it could be done with one
// message in each direction.
fs.writeFileSync(
  path.join(ext, "main.ts"),
  `import { pewt } from "pewter";
const { repos } = await pewt.repos.list();
document.getElementById("out")!.textContent = repos.map((r) => r.name).join(", ");

const log = document.getElementById("log")!;
const { exitCode } = await pewt.run("build", {
  repo: "site",
  onOutput: (line, stream) => log.append(\`\${stream}: \${line}\\n\`),
});
document.getElementById("code")!.textContent = \`exit \${exitCode}\`;

const term = document.getElementById("term")!;
const shell = await pewt.shell({ repo: "site", onData: (chunk) => term.append(chunk) });
shell.resize(100, 30);
shell.write("exit 0\\n");
document.getElementById("left")!.textContent = \`left \${await shell.exit}\`;
document.title = "answered";
`
);

const bundle = await bundleExtension(pewterAt(root), "probe");
const html = fs.readFileSync(path.join(root, bundle.path), "utf8");
log(`bundled ${bundle.bytes} B (${bundle.hash})`);

// ---- a page that mounts it exactly as the shell does
// `<` is escaped in the embedded literal: the bundle contains its own
// `</script>` and would end this one early. The same hazard the bundler
// handles for an extension's compiled JavaScript, one level up.
const PARENT = `<!doctype html>
<body>
<script type="module">
  const html = ${JSON.stringify(html).replace(/</g, "\\u003c")};
  window.__result = { hello: false, calls: [], opaque: null, wire: null, typed: [], sized: null };

  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.srcdoc = html;

  addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    if (!event.data || event.data.type !== "pewt:hello") return;
    window.__result.hello = true;
    window.__result.opaque = frame.contentDocument === null;
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => {
      const call = e.data;
      const post = (msg) => channel.port1.postMessage({ v: call.v, id: call.id, ...msg });
      // More for a call already running: this stand-in plays the pty, which
      // means echoing what it is typed and leaving when told to.
      if (call.type === "pewt:send") {
        if (typeof call.body.d === "string") {
          window.__result.typed.push(call.body.d);
          post({ type: "pewt:event", event: { d: call.body.d } });
          if (call.body.d.startsWith("exit")) post({ ok: true, result: { exitCode: 0 } });
        } else if (typeof call.body.cols === "number") {
          window.__result.sized = { cols: call.body.cols, rows: call.body.rows };
        }
        return;
      }
      window.__result.calls.push(call.method);
      window.__result.wire = call.v;
      if (call.method === "shell") {
        // The prompt before the started event, which is the order the real
        // bridge produces: it registers the data callback and then announces
        // the shell, so bytes can arrive before pewt.shell() has resolved.
        // (No backticks in here — this comment is inside a template literal.)
        post({ type: "pewt:event", event: { d: "$ " } });
        post({ type: "pewt:event", event: { started: true } });
        return;
      }
      if (call.method === "run") {
        // What the shell does with a process: events keyed to the call while
        // it runs, then the ordinary answer. The host's own frame shapes,
        // relayed unchanged (packages/pewt/src/run.ts).
        post({ type: "pewt:event", event: { o: "compiling " + call.params.repo } });
        post({ type: "pewt:event", event: { e: "one warning" } });
        post({ ok: true, result: { exitCode: 0 } });
        return;
      }
      post({ ok: true, result: { repos: [{ name: "atlas", git: false }, { name: "site", git: true }] } });
    };
    channel.port1.start();
    // The version comes from the package rather than a literal: a stand-in
    // that silently speaks last year's wire would pass this probe while the
    // real shell failed.
    frame.contentWindow.postMessage({ v: ${WIRE_VERSION}, type: "pewt:connect" }, "*", [channel.port2]);
  });

  document.body.append(frame);
</script>
</body>`;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PARENT);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const { chromium } = await import("playwright");
if (!fs.existsSync(chromium.executablePath())) {
  console.error("[bridge-probe] Chrome for Testing is not installed — run `npx playwright install chromium`");
  process.exit(2);
}
// Headless is fine: nothing here asks for a File System Access grant, which
// is the one thing headless cannot be given (F15).
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);

const empty = { hello: false, calls: [], opaque: null, wire: null, typed: [], sized: null };
let result = empty;
let rendered = "";
let streamed = "";
let code = "";
let terminal = "";
let left = "";
try {
  // Short on purpose. The failure this exists to catch is a hang, and a
  // generous timeout would turn a deadlock into a slow pass on a busy
  // machine. Five seconds is many orders of magnitude over the real path.
  // The extension's own title, in the extension's own frame — it is set on
  // the last line of main.ts, so it means every call above it came back. The
  // parent's title would be a different document's and always wrong.
  const extension = page.frames().find((f) => f !== page.mainFrame());
  await extension.waitForFunction(() => document.title === "answered", null, { timeout: 5000 });
  result = await page.evaluate(() => window.__result);
  const frame = page.frameLocator("iframe");
  rendered = await frame.locator("#out").textContent();
  streamed = await frame.locator("#log").textContent();
  code = await frame.locator("#code").textContent();
  terminal = await frame.locator("#term").textContent();
  left = await frame.locator("#left").textContent();
} catch (e) {
  result = await page.evaluate(() => window.__result ?? empty);
  errors.push(e instanceof Error ? e.message : String(e));
}

const checks = [
  ["the extension announced itself without waiting for load", result.hello],
  ["its frame has an origin of its own", result.opaque === true],
  ["a call awaited on the extension's first line reached the shell", result.calls.includes("repos.list")],
  ["the extension rendered what it was answered", rendered === "atlas, site"],
  ["it speaks this build's wire version", result.wire === WIRE_VERSION],
  ["a run's output reached the extension while the run was still going", streamed === "out: compiling site\nerr: one warning\n"],
  ["and its exit code arrived as the call's answer", code === "exit 0"],
  ["an extension held a live shell, and what it printed first was not lost", terminal.startsWith("$ ")],
  ["keystrokes left the sandbox after the call was made", JSON.stringify(result.typed) === JSON.stringify(["exit 0\n"])],
  ["so did a window size", JSON.stringify(result.sized) === JSON.stringify({ cols: 100, rows: 30 })],
  ["and the shell's exit code came back as its call's answer", left === "left 0"],
  ["nothing threw in the page", errors.length === 0],
];

console.log();
let failed = 0;
for (const [what, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failed++;
}
if (failed)
  console.log(
    `\n  result: ${JSON.stringify(result)}\n  rendered: ${JSON.stringify(rendered)}\n  streamed: ${JSON.stringify(streamed)}\n  code: ${JSON.stringify(code)}\n  terminal: ${JSON.stringify(terminal)}\n  left: ${JSON.stringify(left)}\n  errors: ${errors.join(" · ")}`
  );
console.log();

await browser.close();
server.close();
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
