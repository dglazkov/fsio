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
// One node_modules, the repository's own — which already holds `pewter` and
// `pewter-ui` as workspace links, plus lit and the signals graph the kit
// declares as peers. Handing over the whole directory rather than a chosen
// few is what makes this a pewter with one copy of everything, the way npm
// would install one: a bundle with two copies of lit in it renders once and
// then silently stops (bundle.ts, `preserveSymlinks`), so the closure is not
// something this probe should be curating by hand.
fs.symlinkSync(path.join(repo, "node_modules"), path.join(root, "node_modules"), "dir");

const ext = path.join(root, "extensions", "probe");
fs.mkdirSync(ext, { recursive: true });
fs.writeFileSync(
  path.join(ext, "index.html"),
  `<body><p id="out">nothing yet</p><pre id="log"></pre><p id="code">no run yet</p><p id="cloned">no clone yet</p><pre id="cprog"></pre><form id="form"><input id="field" /><button>go</button></form><p id="formed">no submit yet</p><pre id="term"></pre><p id="left">no shell yet</p><pre id="acp"></pre><p id="agentinfo">no agent yet</p><p id="tabbed">no tab yet</p><p id="filed">no file yet</p><p id="granted">nothing asked</p><p id="opened">opened with nothing</p><p id="picked">no pick yet</p><p id="drawn"></p><p id="md">no markdown</p><p id="card">no card</p><p id="ran">nothing run</p><p id="screens">nothing listed</p><div id="broken"></div><script type="module" src="./main.ts"></script></body>`
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
  `import { pewt, args } from "pewter";
import { html } from "lit";
import { signal } from "@lit-labs/signals";
import { screen } from "pewter-ui";
import "pewter-ui/style.css";
const { repos } = await pewt.repos.list();
document.getElementById("out")!.textContent = repos.map((r) => r.name).join(", ");

const log = document.getElementById("log")!;
const { exitCode } = await pewt.run("build", {
  repo: "site",
  onOutput: (line, stream) => log.append(\`\${stream}: \${line}\\n\`),
});
document.getElementById("code")!.textContent = \`exit \${exitCode}\`;

// The two mutating repo verbs (#189), from the same sandbox. \`create\` is an
// ordinary call; \`clone\` is \`run\`'s shape with a different child — events on
// the call's id while git works, the exit code as the answer.
const cprog = document.getElementById("cprog")!;
const made = await pewt.repos.create({ name: "atlas2" });
const clone = await pewt.repos.clone("https://example.test/things/atlas3.git", {
  onOutput: (line) => cprog.append(line + "\\n"),
});
document.getElementById("cloned")!.textContent = \`\${made.repo.name} · clone exit \${clone.exitCode}\`;

// A form, because the scaffolded extension is made of them. Without
// allow-forms Chrome blocks submission BEFORE the submit event fires, so a
// handler's preventDefault never runs and every form is silently dead —
// found by a human in the first minutes of using the real screen (#189).
// requestSubmit() walks the same path a click on the button does.
const form = document.getElementById("form") as HTMLFormElement;
form.addEventListener("submit", (e) => {
  e.preventDefault();
  document.getElementById("formed")!.textContent = "submit handled";
});
form.requestSubmit();

const term = document.getElementById("term")!;
const shell = await pewt.shell({ repo: "site", onData: (chunk) => term.append(chunk) });
shell.resize(100, 30);
shell.write("exit 0\\n");
document.getElementById("left")!.textContent = \`left \${await shell.exit}\`;

// An agent, from the same sandbox. The extension is the ACP client, so what
// crosses is whole messages in both directions and nothing in between reads
// one — which is the claim this checks.
const acp = document.getElementById("acp")!;
const agent = await pewt.agent({ repo: "site", onMessage: (m) => acp.append(JSON.stringify(m) + "\\n") });
// What the host said it started, on the same event that resolved the handle
// — the cwd is what an ACP client's session/new has to name.
document.getElementById("agentinfo")!.textContent = \`\${agent.info.title} in \${agent.info.cwd}\`;
agent.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
await agent.exit;

// A tab, from the same sandbox. This one is answered by the shell rather than
// by the host, and the extension cannot tell: same package, same channel, same
// shape of call. That indistinguishability is the claim.
const { id } = await pewt.tabs.add({ name: "chat" });
const { tabs } = await pewt.tabs.list();
document.getElementById("tabbed")!.textContent = \`\${id} · \${tabs.length} open\`;

// A file, from the same sandbox. \`open\` is a path and nothing else — the page
// reads the bytes through the grant it holds, which an extension has no part
// of and cannot see. What this checks is that the two spellings reach the
// shell; what they do once there is the rig's, because it needs a real folder.
const view = await pewt.open("notes.md");
const { files } = await pewt.files.list();
document.getElementById("filed")!.textContent = \`\${view.path} → \${view.id} · \${files.length} held\`;

// What the host will start without asking. An extension can read this and take
// one back; it cannot make one, because the only gesture that makes a grant is
// a human typing at the host's terminal (P5). So this is the one operation
// where the sandbox is not the interesting boundary — the terminal is.
const { grants } = await pewt.grants.list();
document.getElementById("granted")!.textContent = grants.map((g) => \`\${g.kind}/\${g.repo ?? "."}\`).join(", ");

// What this tab was opened with (#198). It rode the connect message beside
// the port, so by the time any call above was answered it had already
// settled — awaiting it last is the lazy option, not a race.
document.getElementById("opened")!.textContent = JSON.stringify(await args);

// The kit's elements, in the same sandbox: registered by the import's side
// effect, rendered into their own shadow roots, and driven by a real click.
// The tag map makes both createElement calls typed — misuse here is a
// compile error in a pewter, though this probe's own compiler is esbuild and
// only the runtime half is under test.
//
// These are lit components, so a draw is a microtask after the property
// that caused it and \`updateComplete\` is what waits for it. That is the
// difference this probe is really pinning: a screen that sets a property and
// reads the DOM on the next line reads the DOM it had before.
const menu = document.createElement("pewter-menu");
document.body.append(menu);
menu.choices = [{ value: "site", label: "site" }, { value: null, label: "this pewter" }];
menu.onpick = (v) => { document.getElementById("picked")!.textContent = \`picked \${v}\`; };
await menu.updateComplete;
menu.shadowRoot!.querySelector("button")!.click();

const status = document.createElement("pewter-status");
document.body.append(status);
status.say("kit status");
status.offer("again", () => status.say("kit acted"));
await status.updateComplete;
status.shadowRoot!.querySelector("button")!.click();
await status.updateComplete;

// A hidden element must stay hidden. The kit styles its elements as block
// boxes and an author rule outranks the UA stylesheet's [hidden] — the exact
// bug a human found on the first screen — so the guard rule is pinned here.
// It lives in the component's own styles now rather than in the stylesheet,
// which is what this check is worth: the element is hidden because of what
// it carries, not because of what the page imported.
const quiet = document.createElement("pewter-status");
quiet.id = "quiet";
quiet.hidden = true;
document.body.append(quiet);
await quiet.updateComplete;

// The screen helper, in the same sandbox: a signal written, and the DOM
// caught up by the time \`drawn()\` resolves. This is the loop every
// scaffolded screen now runs on.
const drawnInto = document.getElementById("drawn")!;
const beat = signal("first");
const drawing = screen(drawnInto, () => html\`<b>\${beat.get()}</b>\`);
beat.set("second");
await drawing.drawn();
drawnInto.setAttribute("data-drew", drawnInto.textContent ?? "");

// A program, from inside the sandbox (#210's open question, settled by
// letting extensions run things). argv goes out as a list — the awkward
// argument is the point, because there is no shell on the other end to
// re-split it — and stdout and stderr arrive apart.
const ran = document.getElementById("ran")!;
const execOut: string[] = [];
const execCode = await pewt.exec("git", ["log", "--format=%cI", "a b"], {
  repo: "site",
  onOutput: (line, stream) => execOut.push(\`\${stream}:\${line}\`),
});
ran.textContent = \`\${execOut.join(" ")} exit \${execCode.exitCode}\`;

// What the folder holds, asked from inside the sandbox (#187). The shell's
// own opener reads exactly this, so an extension and the strip's + are two
// callers of one operation — which is the claim the two front ends make.
const screens = await pewt.ext.list();
document.getElementById("screens")!.textContent = screens.extensions
  .map((e) => (e.ready ? e.name : \`\${e.name} (no \${e.missing})\`))
  .join(", ");

// Markdown, in the same sandbox. An agent answers in markdown and the screen
// used to put it on the page as-is; this is the element that renders it. The
// interesting checks are the two the parser exists for: an unclosed fence is
// (a tilde fence here, because this whole block lives inside a template
// literal and a backtick would end it)
// already a code block while the rest is still arriving, and a javascript:
// link stays text rather than becoming clickable.
const md = document.createElement("pewter-markdown");
document.body.append(md);
md.text = "# hi\\n\\nsee [safe](https://e.test) and [bad](javascript:alert(1))\\n\\n~~~ts\\nconst a = 1;";
await md.updateComplete;
const root = md.shadowRoot!;
document.getElementById("md")!.setAttribute(
  "data-md",
  [
    root.querySelector("h1") ? "h1" : "-",
    root.querySelector("a")?.getAttribute("href") ?? "-",
    root.querySelectorAll("a").length,
    root.querySelector("pre")?.hasAttribute("data-open") ? "open" : "-",
    root.querySelector("pre code")?.textContent ?? "-",
    root.querySelector("script") ? "SCRIPT" : "none",
  ].join(" | ")
);

// A question and a step, driven the way the agent screen drives them. The
// two things worth pinning: an answer carries what it *means* (an affirm is
// styled apart from a deny, so a human is not doing that reading), and a
// file the question names reports a click back to the screen — which is the
// half a terminal cannot do at all.
const ask = document.createElement("pewter-ask");
document.body.append(ask);
ask.question = "Write to src/main.ts?";
ask.paths = ["/abs/repos/site/src/main.ts"];
let opened = "";
ask.onpath = (p) => { opened = p; };
ask.choices = [
  { value: "y", label: "allow once", intent: "affirm" },
  { value: "n", label: "reject", intent: "deny" },
];
let picked = "";
ask.onpick = (v) => { picked = v ?? "(dismissed)"; ask.answered = v ?? ""; };
await ask.updateComplete;
const askRoot = ask.shadowRoot!;
askRoot.querySelector<HTMLButtonElement>("button.path")!.click();
askRoot.querySelectorAll<HTMLButtonElement>(".choices button")[0]!.click();
await ask.updateComplete;

const step = document.createElement("pewter-step");
document.body.append(step);
step.label = "edit main.ts";
step.state = "failed";
await step.updateComplete;

document.getElementById("card")!.setAttribute(
  "data-card",
  [
    picked,
    opened,
    // The answer replaced the buttons and stayed on screen as a record.
    askRoot.querySelector(".answered")?.textContent?.trim().replace(/\\s+/g, " ") ?? "-",
    askRoot.querySelector(".choices") ? "still-asking" : "answered",
    step.getAttribute("state") ?? "-",
  ].join(" | ")
);

// A view that throws must put its reason on screen. The bug this pins cost a
// session: an extension called a helper declared below its own \`screen()\`
// call, the first draw is synchronous, and the pane went blank — which looks
// exactly like a frame that never mounted. The reason existed only in a
// console an agent cannot open.
//
// Thrown from the first draw deliberately, which is the case that bit: the
// view runs inside \`screen()\` before the line after it has been evaluated.
const brokenInto = document.getElementById("broken")!;
screen(brokenInto, () => {
  throw new Error("this screen is meant to throw");
});
brokenInto.setAttribute("data-broke", brokenInto.textContent?.includes("could not draw") ? "said so" : "silent");
brokenInto.setAttribute("data-stack", brokenInto.textContent?.includes("meant to throw") ? "kept" : "lost");

// Two failures that nothing in the extension handles, reported out of the
// frame rather than dying in a console nobody can open (#210). Last, so
// everything above has already been measured.
window.setTimeout(() => {
  throw new Error("uncaught, on purpose");
}, 0);
void Promise.reject(new Error("unhandled, on purpose"));
// Both are asynchronous by nature, so the title — which is what the probe
// waits on — is set after they have had a turn. Without this the probe reads
// the result before the frame has finished failing.
await new Promise((r) => setTimeout(r, 50));

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
  window.__result = { hello: false, calls: [], opaque: null, wire: null, typed: [], sized: null, messaged: [], tabs: [], troubles: [], execArgs: null };

  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts allow-forms");
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
      // What escaped the frame (#210). Not a call, never answered — the
      // stand-in records it exactly as the shell does, because the claim is
      // that a screen's failure leaves the sandbox at all.
      if (call.type === "pewt:trouble") {
        window.__result.troubles.push({ kind: call.kind, message: call.message, hasStack: typeof call.stack === "string" && call.stack.length > 0 });
        return;
      }
      if (call.type === "pewt:send") {
        if (typeof call.body.d === "string") {
          window.__result.typed.push(call.body.d);
          post({ type: "pewt:event", event: { d: call.body.d } });
          if (call.body.d.startsWith("exit")) post({ ok: true, result: { exitCode: 0 } });
        } else if ("m" in call.body) {
          // An ACP peer: it answers the request it was handed, then leaves.
          window.__result.messaged.push(call.body.m);
          post({ type: "pewt:event", event: { m: { jsonrpc: "2.0", id: call.body.m.id, result: { protocolVersion: 1 } } } });
          post({ ok: true, result: { exitCode: 0 } });
        } else if (typeof call.body.cols === "number") {
          window.__result.sized = { cols: call.body.cols, rows: call.body.rows };
        }
        return;
      }
      window.__result.calls.push(call.method);
      if (call.method === "exec") window.__result.execArgs = call.params.args;
      window.__result.wire = call.v;
      // The page's own operations, answered by the page. This stand-in keeps
      // the list the real shell keeps, which is all a tab is at this level.
      if (call.method === "tabs.add") {
        const tab = { id: "tab-" + (window.__result.tabs.length + 1), title: call.params.name, body: { kind: "extension", name: call.params.name } };
        window.__result.tabs.push(tab);
        post({ ok: true, result: { id: tab.id, name: call.params.name, title: tab.title, active: true } });
        return;
      }
      if (call.method === "tabs.list") {
        post({ ok: true, result: { tabs: window.__result.tabs, activeId: window.__result.tabs.at(-1)?.id ?? null } });
        return;
      }
      if (call.method === "files.open") {
        // Only a path crossed the sandbox, which is the claim: the bytes never
        // leave the page, and this stand-in has no folder to read them from
        // anyway. What a real shell does with the path is the rig's to judge.
        const tab = { id: "tab-" + (window.__result.tabs.length + 1), title: call.params.path, body: { kind: "file", path: call.params.path } };
        window.__result.tabs.push(tab);
        post({ ok: true, result: { id: tab.id, path: call.params.path, title: tab.title, active: true, reused: false } });
        return;
      }
      if (call.method === "files.list") {
        post({ ok: true, result: { files: [] } });
        return;
      }
      if (call.method === "grants.list") {
        post({ ok: true, result: { grants: [{ kind: "run", repo: "site", granted: "2026-08-06T12:06:02.000Z" }] } });
        return;
      }
      if (call.method === "agent") {
        // An agent's start carries what the host said it started — the tab
        // is the ACP client, and the cwd is what its session/new must name.
        post({ type: "pewt:event", event: { started: { agent: "fake", title: "A fake agent", version: "1.0.0", asks: true, unmeasured: false, where: "site", cwd: "/probe/repos/site" } } });
        return;
      }
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
      if (call.method === "exec") {
        // A run's frames with a different child (packages/pewt/src/exec.ts),
        // which is the claim: one shape, two children, one reader. No
        // backticks in here — this whole block is inside a template literal.
        post({ type: "pewt:event", event: { o: "M1" } });
        post({ type: "pewt:event", event: { e: "on stderr" } });
        post({ ok: true, result: { exitCode: 0 } });
        return;
      }
      if (call.method === "ext.list") {
        // The page's own door to a screen (#187). Half-written screens are on
        // the list on purpose — a menu that hides one disagrees with the
        // folder it is describing.
        post({ ok: true, result: { extensions: [{ name: "probe", ready: true }, { name: "half", ready: false, missing: "main.ts" }] } });
        return;
      }
      if (call.method === "repos.create") {
        post({ ok: true, result: { repo: { name: call.params.name, git: true } } });
        return;
      }
      if (call.method === "repos.clone") {
        // A clone rides run's rails: same event shape, same answer shape
        // (packages/pewt/src/clone.ts). git narrates on stderr.
        post({ type: "pewt:event", event: { e: "Cloning into 'atlas3'..." } });
        post({ type: "pewt:event", event: { e: "Receiving objects: 100%, done." } });
        post({ ok: true, result: { exitCode: 0 } });
        return;
      }
      post({ ok: true, result: { repos: [{ name: "atlas", git: false, branch: null, scripts: [], installed: null }, { name: "site", git: true, branch: "main", scripts: ["build"], installed: true }] } });
    };
    channel.port1.start();
    // The version comes from the package rather than a literal: a stand-in
    // that silently speaks last year's wire would pass this probe while the
    // real shell failed.
    // What the tab opens with rides beside the port (#198), so the probe
    // opens its extension the way the repos row's shell verb would.
    frame.contentWindow.postMessage({ v: ${WIRE_VERSION}, type: "pewt:connect", args: { repo: "site" } }, "*", [channel.port2]);
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
// The extension now fails on purpose at the end, to prove a failure leaves
// the sandbox at all (#210). Those two are the probe's own doing; anything
// else arriving here is a real one and still fails the run.
const ON_PURPOSE = ["uncaught, on purpose", "unhandled, on purpose"];
page.on("pageerror", (e) => {
  const said = String(e);
  if (!ON_PURPOSE.some((m) => said.includes(m))) errors.push(said);
});
await page.goto(url);

const empty = { hello: false, calls: [], opaque: null, wire: null, typed: [], sized: null, messaged: [], tabs: [], troubles: [], execArgs: null };
let result = empty;
let rendered = "";
let streamed = "";
let code = "";
let cloned = "";
let cprog = "";
let formed = "";
let terminal = "";
let left = "";
let acp = "";
let tabbed = "";
let filed = "";
let granted = "";
let opened = "";
let agentinfo = "";
let picked = "";
let kitsaid = "";
let kitdrew = "";
let quietDisplay = "";
let broke = "";
let brokeStack = "";
let screens = "";
let ran = "";
let md = "";
let card = "";
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
  cloned = await frame.locator("#cloned").textContent();
  cprog = await frame.locator("#cprog").textContent();
  formed = await frame.locator("#formed").textContent();
  terminal = await frame.locator("#term").textContent();
  left = await frame.locator("#left").textContent();
  acp = await frame.locator("#acp").textContent();
  agentinfo = await frame.locator("#agentinfo").textContent();
  tabbed = await frame.locator("#tabbed").textContent();
  filed = await frame.locator("#filed").textContent();
  granted = await frame.locator("#granted").textContent();
  opened = await frame.locator("#opened").textContent();
  picked = await frame.locator("#picked").textContent();
  kitsaid = await frame.locator("pewter-status span").first().textContent();
  kitdrew = await frame.locator("#drawn").getAttribute("data-drew");
  quietDisplay = await frame.locator("#quiet").evaluate((el) => getComputedStyle(el).display);
  broke = await frame.locator("#broken").getAttribute("data-broke");
  brokeStack = await frame.locator("#broken").getAttribute("data-stack");
  screens = await frame.locator("#screens").textContent();
  ran = await frame.locator("#ran").textContent();
  md = await frame.locator("#md").getAttribute("data-md");
  card = await frame.locator("#card").getAttribute("data-card");
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
  ["an extension created a project and cloned one over the same channel", result.calls.includes("repos.create") && result.calls.includes("repos.clone")],
  ["the clone's progress streamed while git worked", cprog === "Cloning into 'atlas3'...\nReceiving objects: 100%, done.\n"],
  ["and both answers came back typed", cloned === "atlas2 · clone exit 0"],
  ["a form submits to its own handler — the sandbox allows forms and the handler cancels the rest", formed === "submit handled"],
  ["an extension held a live shell, and what it printed first was not lost", terminal.startsWith("$ ")],
  ["keystrokes left the sandbox after the call was made", JSON.stringify(result.typed) === JSON.stringify(["exit 0\n"])],
  ["so did a window size", JSON.stringify(result.sized) === JSON.stringify({ cols: 100, rows: 30 })],
  ["and the shell's exit code came back as its call's answer", left === "left 0"],
  ["an extension sent an agent a whole ACP message", JSON.stringify(result.messaged) === JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "initialize" }])],
  ["and read the agent's answer back whole", acp.trim() === JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })],
  ["what the host started arrived with the handle, cwd included", agentinfo === "A fake agent in /probe/repos/site"],
  ["an extension asked the page for a tab over the same channel", result.calls.includes("tabs.add") && result.calls.includes("tabs.list")],
  ["and read back a strip holding it", tabbed === "tab-1 · 1 open"],
  ["an extension asked for a file by path, and only the path crossed", result.calls.includes("files.open") && result.calls.includes("files.list")],
  ["and the tab it got back names the file", filed === "notes.md → tab-2 · 0 held"],
  ["an extension read what the host will start without asking", result.calls.includes("grants.list") && granted === "run/site"],
  ["what the tab opened with arrived inside the sandbox", opened === '{"repo":"site"}'],
  ["the kit's menu rendered in the sandbox, and a click came back through onpick", picked === "picked site"],
  ["the kit's status line spoke, offered, and acted", kitsaid === "kit acted"],
  ["a hidden element stays hidden — the kit's block box does not defeat the attribute", quietDisplay === "none"],
  ["a screen redrew from a signal, and drawn() waited for it", kitdrew === "second"],
  ["an extension ran a program and read its output, stderr kept apart", ran === "out:M1 err:on stderr exit 0"],
  ["markdown an agent wrote renders as markup, and a fence still arriving is already code", md === "h1 | https://e.test | 1 | open | const a = 1; | none"],
  ["a permission question answers, keeps the answer on screen, and hands a file back to the screen", card === "y | /abs/repos/site/src/main.ts | answered: allow once | answered | failed"],
  ["and its argv crossed as a list, so an awkward argument stayed one argument", result.calls.includes("exec") && result.execArgs?.length === 3 && result.execArgs[2] === "a b"],
  ["an extension read what extensions/ holds, half-written ones included", screens === "probe, half (no main.ts)"],
  ["an uncaught error left the sandbox instead of dying in a console", result.troubles.some((t) => t.kind === "error" && t.message.includes("uncaught, on purpose"))],
  ["an unhandled rejection did too, and says which kind it is", result.troubles.some((t) => t.kind === "rejection" && t.message.includes("unhandled, on purpose"))],
  ["a stack came with it — the half that fixes the bug", result.troubles.every((t) => t.hasStack)],
  ["and a caught first-draw throw is reported too, though the screen recovered", result.troubles.some((t) => t.message.includes("this screen is meant to throw"))],
  ["a view that throws puts its reason on screen instead of a blank pane", broke === "said so"],
  ["and the stack goes with it, for the reader who cannot open a console", brokeStack === "kept"],
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
    `\n  result: ${JSON.stringify(result)}\n  rendered: ${JSON.stringify(rendered)}\n  streamed: ${JSON.stringify(streamed)}\n  code: ${JSON.stringify(code)}\n  terminal: ${JSON.stringify(terminal)}\n  left: ${JSON.stringify(left)}\n  acp: ${JSON.stringify(acp)}\n  tabbed: ${JSON.stringify(tabbed)}\n  filed: ${JSON.stringify(filed)}\n  granted: ${JSON.stringify(granted)}\n  errors: ${errors.join(" · ")}`
  );
console.log();

await browser.close();
server.close();
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
