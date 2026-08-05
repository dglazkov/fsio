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
fs.writeFileSync(path.join(ext, "index.html"), `<body><p id="out">nothing yet</p><script type="module" src="./main.ts"></script></body>`);
// Top-level await on the first line, on purpose: this is the shape that
// deadlocks against a load-event handshake.
fs.writeFileSync(
  path.join(ext, "main.ts"),
  `import { pewt } from "pewter";
const { repos } = await pewt.repos.list();
document.getElementById("out")!.textContent = repos.map((r) => r.name).join(", ");
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
  window.__result = { hello: false, calls: [], opaque: null };

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
      window.__result.calls.push(call.method);
      channel.port1.postMessage({
        v: 1, id: call.id, ok: true,
        result: { repos: [{ name: "atlas", git: false }, { name: "site", git: true }] },
      });
    };
    channel.port1.start();
    frame.contentWindow.postMessage({ v: 1, type: "pewt:connect" }, "*", [channel.port2]);
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

let result = { hello: false, calls: [], opaque: null };
let rendered = "";
try {
  // Short on purpose. The failure this exists to catch is a hang, and a
  // generous timeout would turn a deadlock into a slow pass on a busy
  // machine. Five seconds is many orders of magnitude over the real path.
  await page.waitForFunction(() => window.__result?.calls.length > 0, null, { timeout: 5000 });
  result = await page.evaluate(() => window.__result);
  rendered = await page.frameLocator("iframe").locator("#out").textContent();
} catch (e) {
  result = await page.evaluate(() => window.__result ?? { hello: false, calls: [], opaque: null });
  errors.push(e instanceof Error ? e.message : String(e));
}

const checks = [
  ["the extension announced itself without waiting for load", result.hello],
  ["its frame has an origin of its own", result.opaque === true],
  ["a call awaited on the extension's first line reached the shell", result.calls.includes("repos.list")],
  ["the extension rendered what it was answered", rendered === "atlas, site"],
  ["nothing threw in the page", errors.length === 0],
];

console.log();
let failed = 0;
for (const [what, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failed++;
}
if (failed) console.log(`\n  result: ${JSON.stringify(result)}\n  rendered: ${JSON.stringify(rendered)}\n  errors: ${errors.join(" · ")}`);
console.log();

await browser.close();
server.close();
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
