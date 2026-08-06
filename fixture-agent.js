#!/usr/bin/env node
// fsio acp-demo fixture-agent — generated bundle; source: packages/acp-demo (github.com/dglazkov/fsio)

// dist/fixture-agent.js
import process from "node:process";
var out = (msg) => {
  process.stdout.write(JSON.stringify(msg) + "\n");
};
var nextId = 1;
var pending = /* @__PURE__ */ new Map();
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    out({ jsonrpc: "2.0", id, method, params });
  });
}
var notify = (method, params) => {
  out({ jsonrpc: "2.0", method, params });
};
var sessionId = "fixture-session";
var cwd = "";
var cancelled = false;
var turn = 0;
var update = (u) => notify("session/update", { sessionId, update: u });
var say = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: text + "\n" } });
var think = (text) => update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function toolCall(id, title, edit, status = "pending") {
  update({
    sessionUpdate: "tool_call",
    toolCallId: id,
    title,
    kind: "edit",
    status,
    locations: [{ path: edit.path }],
    content: [{ type: "diff", path: edit.path, oldText: edit.oldText, newText: edit.newText }]
  });
}
var toolDone = (id, status) => update({ sessionUpdate: "tool_call_update", toolCallId: id, status });
async function askPermission(id, title, edit) {
  const res = await request("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId: id,
      title,
      kind: "edit",
      locations: [{ path: edit.path }],
      content: [{ type: "diff", path: edit.path, oldText: edit.oldText, newText: edit.newText }]
    },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Always allow edits", kind: "allow_always" },
      { optionId: "reject", name: "Reject", kind: "reject_once" }
    ]
  });
  const o = res?.outcome;
  if (!o || o.outcome === "cancelled")
    return null;
  return o.optionId ?? null;
}
async function readFile(path) {
  try {
    const r = await request("fs/read_text_file", { sessionId, path });
    return { ok: true, content: r?.content ?? "" };
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
}
async function writeFile(path, content) {
  try {
    await request("fs/write_text_file", { sessionId, path, content });
    return { ok: true };
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
}
var join = (name) => `${cwd.replace(/\/+$/, "")}/${name}`;
var NOTES = "NOTES.md";
async function scenarioEdit() {
  const path = join(NOTES);
  think(`I should look at ${NOTES} before proposing a change.`);
  const read = await readFile(path);
  const oldText = read.ok ? read.content : "";
  if (!read.ok)
    say(`${NOTES} isn't there yet (the page said: ${read.why}). I'll propose creating it.`);
  else
    say(`Read ${NOTES} through the page \u2014 ${oldText.length} characters. Here's what I'd add.`);
  const newText = `${oldText}${oldText.endsWith("\n") || oldText === "" ? "" : "\n"}- puppet edit #${turn}
`;
  const edit = { path, oldText, newText };
  const id = `edit-${turn}`;
  toolCall(id, `Edit ${NOTES}`, edit);
  const answer = await askPermission(id, `Edit ${NOTES}`, edit);
  if (cancelled)
    return;
  if (answer === null || answer === "reject") {
    toolDone(id, "failed");
    say(answer === null ? "Cancelled \u2014 I left the file alone." : "Understood. I left the file alone.");
    return;
  }
  const wrote = await writeFile(path, newText);
  if (!wrote.ok) {
    toolDone(id, "failed");
    say(`The page refused the write: ${wrote.why}`);
    return;
  }
  toolDone(id, "completed");
  say(`Done \u2014 ${NOTES} was written through your grant, not by me. I never touched the disk.`);
}
async function scenarioRefuse() {
  const probes = [
    { what: "somewhere outside the folder entirely", path: "/etc/passwd" },
    { what: "the protocol's own area inside the folder", path: join(".fsio/host.json") },
    { what: "a parent directory, by traversal", path: join("../secrets.txt") },
    { what: "a relative path (ACP sends absolute ones)", path: NOTES }
  ];
  say("I'll try to reach four places I shouldn't, and tell you exactly what the page says back.");
  for (const p of probes) {
    if (cancelled)
      return;
    const r = await readFile(p.path);
    if (r.ok)
      say(`\u26A0 ${p.what} \u2014 ALLOWED (${p.path}). That is a hole; the page should have refused this.`);
    else
      say(`\u2713 ${p.what}
    asked for: ${p.path}
    page said: ${r.why}`);
  }
  say("Those refusals arrived as ordinary errors, which is what lets an agent relay them to you.");
}
async function scenarioMany() {
  say("Three separate changes, three separate asks. Answer them in any order.");
  for (let i = 1; i <= 3; i++) {
    if (cancelled)
      return;
    const name = `puppet-${i}.txt`;
    const path = join(name);
    const edit = { path, oldText: "", newText: `file ${i}, written after you said yes
` };
    const id = `many-${turn}-${i}`;
    toolCall(id, `Create ${name}`, edit);
    const answer = await askPermission(id, `Create ${name}`, edit);
    if (answer === null || answer === "reject") {
      toolDone(id, "failed");
      say(`Skipped ${name}.`);
      continue;
    }
    const wrote = await writeFile(path, edit.newText);
    toolDone(id, wrote.ok ? "completed" : "failed");
    say(wrote.ok ? `Wrote ${name}.` : `Could not write ${name}: ${wrote.why}`);
  }
}
async function scenarioRead() {
  const path = join(NOTES);
  const r = await readFile(path);
  if (r.ok)
    say(`${NOTES} is ${r.content.length} characters. I asked the page for it; no permission card, because you already granted the folder.`);
  else
    say(`Could not read ${NOTES}: ${r.why}`);
}
async function scenarioMarkdown() {
  think("Rendering check \u2014 no files are touched by this one.");
  say(`# Markdown check

This paragraph has **bold**, *italic*, \`inline code\`, and a
soft line break that should stay a line break.

## What should render
- a bullet list
- with \`read_text_file\` and \`write_text_file\` in it \u2014 snake_case, *not* italics
- and [a real link](https://github.com/dglazkov/fsio)

1. ordered too
2. second item

> A blockquote, for the look of it.

---
`);
  say(`Here is a code block, streamed in two pieces:

\`\`\`ts
export function greet(name: string): string {`);
  await sleep(700);
  say(`  return \`hello \${name}\`;
}
\`\`\`

## What should NOT render

None of these four may become clickable or disappear \u2014 you should be able to
read every one of them as plain text:

- a script tag: <script>alert(1)</script>
- an image handler: <img src=x onerror=alert(1)>
- a javascript link: [click me](javascript:alert(1))
- a data link: [click me too](data:text/html,<script>alert(1)</script>)

If any of those four vanished or turned blue, that is a bug worth stopping for.`);
}
function pickScenario(text) {
  const t = text.toLowerCase();
  if (t.includes("refuse"))
    return scenarioRefuse;
  if (t.includes("many"))
    return scenarioMany;
  if (t.includes("markdown"))
    return scenarioMarkdown;
  if (t.includes("read"))
    return scenarioRead;
  return scenarioEdit;
}
function promptText(params) {
  const blocks = params?.["prompt"] ?? [];
  return blocks.map((b) => b.text ?? "").join(" ");
}
async function handleRequest(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentInfo: { name: "fsio puppet (not a real agent)", version: "1" },
        // Only claim what it actually does. It asks for permission and it
        // uses the client's filesystem; it runs no terminals.
        agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
        authMethods: []
      };
    case "session/new":
      sessionId = `fixture-${Date.now().toString(36)}`;
      cwd = String(params?.["cwd"] ?? "");
      if (!cwd)
        throw { code: -32602, message: "session/new needs an absolute cwd \u2014 the puppet has no hands and cannot guess one" };
      return { sessionId };
    case "session/prompt": {
      turn++;
      cancelled = false;
      await pickScenario(promptText(params))();
      return { stopReason: cancelled ? "cancelled" : "end_turn" };
    }
    default:
      throw { code: -32601, message: `the puppet does not implement ${method}` };
  }
}
function handleNotification(method) {
  if (method === "session/cancel")
    cancelled = true;
}
var buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim())
      dispatch(line);
  }
});
process.stdin.on("end", () => process.exit(0));
function dispatch(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stderr.write(`puppet: unparseable input: ${line.slice(0, 120)}
`);
    return;
  }
  if (msg.method === void 0) {
    if (msg.id === void 0)
      return;
    const waiter = pending.get(Number(msg.id));
    if (!waiter)
      return;
    pending.delete(Number(msg.id));
    if (msg.error)
      waiter.reject(new Error(msg.error.message));
    else
      waiter.resolve(msg.result);
    return;
  }
  if (msg.id === void 0) {
    handleNotification(msg.method);
    return;
  }
  const id = msg.id;
  void handleRequest(msg.method, msg.params).then((result) => out({ jsonrpc: "2.0", id, result: result ?? null }), (e) => {
    const err = e;
    out({ jsonrpc: "2.0", id, error: { code: typeof err.code === "number" ? err.code : -32603, message: err.message ?? String(e) } });
  });
}
