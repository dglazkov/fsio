#!/usr/bin/env node
// A puppet agent: it asks permission, and it has no hands.
//
// The demo page can draw a permission card and can serve a file to an agent
// through the folder handle the human granted. Neither had ever run
// ([#100](https://github.com/dglazkov/fsio/issues/100)): the agent on hand
// (pi-acp) reads and edits with its own hands and asks nobody, so the page's
// two hardest paths — `session/request_permission` and `fs/*` — were shipped
// and never fired.
//
// This puppet is the inverse of that agent, on purpose:
//
//   - **It never touches the filesystem.** Not once, not even to check
//     whether a file exists. Every byte it reads or writes travels as an
//     `fs/read_text_file` / `fs/write_text_file` request to the page, which
//     serves it through the human's grant. An agent with hands can skip the
//     client; this one cannot, which is exactly why it exercises it.
//   - **It blocks on the human.** The edit does not happen until a
//     `session/request_permission` comes back answered. R6 asks that the
//     mechanism compose with a consent surface it does not own; this is the
//     thing that presupposes such a surface.
//   - **It reports its own refusals.** When it reaches for a path outside
//     the folder, the browser refuses it — and the puppet writes the refusal
//     *text* into the transcript. R9 says that text is written to be
//     relayed; until now nothing had ever relayed it, so nobody had read one.
//
// It is a **test asset, not a demo**. Nothing here calls a model, opens a
// socket, or costs anything, and it behaves identically on every run — which
// is the point: a browser loop can drive it and assert on the result, where a
// real agent phrases things differently every time. It still spawns through
// the same kind and the same Seatbelt profile as a real agent, so it is a
// subject of the confinement story rather than a hole in it.
//
// Distinct from `test-fake-agent.ts`, which is a deliberately *bad* citizen
// (torn writes, junk on stdout, over-long lines) stressing the framing
// contract. This one is a well-behaved ACP speaker stressing the client role.
//
// Scenarios, keyed off the prompt text so a loop can ask for one by name:
//   (anything)  edit    — read, propose a diff, ask, write when allowed
//   "refuse"            — reach outside the folder; report each refusal
//   "many"              — three permission asks in one turn
//   "read"              — read-only: no ask, no write
import process from "node:process";

// ---- JSON-RPC plumbing (both directions: this peer asks, and is asked)

interface Rpc {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const out = (msg: unknown): void => {
  process.stdout.write(JSON.stringify(msg) + "\n");
};

let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/** puppet → page request. Rejects with the page's own error text, which is
 *  the whole point of the refusal scenario. */
function request(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    out({ jsonrpc: "2.0", id, method, params });
  });
}

const notify = (method: string, params: Record<string, unknown>): void => {
  out({ jsonrpc: "2.0", method, params });
};

// ---- session state

let sessionId = "fixture-session";
/** the absolute folder the page granted; `session/new` supplies it. */
let cwd = "";
let cancelled = false;
let turn = 0;

// ---- ACP helpers, named for what the human sees rather than the wire

const update = (u: Record<string, unknown>): void => notify("session/update", { sessionId, update: u });

/** One line of agent-visible text.
 *
 *  The trailing newline is load-bearing and was measured, not guessed: an
 *  `agent_message_chunk` is a *fragment* of one message, so a client that
 *  concatenates consecutive chunks into one flowing block is behaving
 *  correctly (the demo page does exactly that). Emitting these without a
 *  terminator welded every line to the next one in the transcript — the
 *  agent owns its own line breaks, because only the agent knows where its
 *  sentences end. */
const say = (text: string): void => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: text + "\n" } });

const think = (text: string): void => update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });

interface Edit {
  path: string;
  oldText: string;
  newText: string;
}

/** The tool call the human is being asked about. `locations` puts the file
 *  name on the card and `content` gives it a diff — together they are the
 *  "does the card carry enough to decide on" question, made answerable. */
function toolCall(id: string, title: string, edit: Edit, status = "pending"): void {
  update({
    sessionUpdate: "tool_call",
    toolCallId: id,
    title,
    kind: "edit",
    status,
    locations: [{ path: edit.path }],
    content: [{ type: "diff", path: edit.path, oldText: edit.oldText, newText: edit.newText }],
  });
}

const toolDone = (id: string, status: string): void => update({ sessionUpdate: "tool_call_update", toolCallId: id, status });

/** Ask, and block. Three option kinds so the page styles three buttons
 *  differently (allow / allow-always / reject). */
async function askPermission(id: string, title: string, edit: Edit): Promise<string | null> {
  const res = (await request("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId: id,
      title,
      kind: "edit",
      locations: [{ path: edit.path }],
      content: [{ type: "diff", path: edit.path, oldText: edit.oldText, newText: edit.newText }],
    },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Always allow edits", kind: "allow_always" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  })) as { outcome?: { outcome?: string; optionId?: string } };
  const o = res?.outcome;
  if (!o || o.outcome === "cancelled") return null;
  return o.optionId ?? null;
}

/** Read through the page. Returns null when the page refused or the file is
 *  absent — the puppet cannot tell the difference, and does not need to. */
async function readFile(path: string): Promise<{ ok: true; content: string } | { ok: false; why: string }> {
  try {
    const r = (await request("fs/read_text_file", { sessionId, path })) as { content?: string };
    return { ok: true, content: r?.content ?? "" };
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
}

async function writeFile(path: string, content: string): Promise<{ ok: true } | { ok: false; why: string }> {
  try {
    await request("fs/write_text_file", { sessionId, path, content });
    return { ok: true };
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
}

const join = (name: string): string => `${cwd.replace(/\/+$/, "")}/${name}`;

// ---- scenarios

const NOTES = "NOTES.md";

/** The default turn, and the one the demo exists to show: propose a change,
 *  ask, and only then write — through the page, both times. */
async function scenarioEdit(): Promise<void> {
  const path = join(NOTES);
  think(`I should look at ${NOTES} before proposing a change.`);
  const read = await readFile(path);
  const oldText = read.ok ? read.content : "";
  if (!read.ok) say(`${NOTES} isn't there yet (the page said: ${read.why}). I'll propose creating it.`);
  else say(`Read ${NOTES} through the page — ${oldText.length} characters. Here's what I'd add.`);

  const newText = `${oldText}${oldText.endsWith("\n") || oldText === "" ? "" : "\n"}- puppet edit #${turn}\n`;
  const edit: Edit = { path, oldText, newText };
  const id = `edit-${turn}`;
  toolCall(id, `Edit ${NOTES}`, edit);

  const answer = await askPermission(id, `Edit ${NOTES}`, edit);
  if (cancelled) return;
  if (answer === null || answer === "reject") {
    toolDone(id, "failed");
    say(answer === null ? "Cancelled — I left the file alone." : "Understood. I left the file alone.");
    return;
  }

  const wrote = await writeFile(path, newText);
  if (!wrote.ok) {
    toolDone(id, "failed");
    say(`The page refused the write: ${wrote.why}`);
    return;
  }
  toolDone(id, "completed");
  say(`Done — ${NOTES} was written through your grant, not by me. I never touched the disk.`);
}

/** The R9 leg: reach where the folder does not go, and read the refusal out
 *  loud so a human can judge whether it makes sense on the receiving end. */
async function scenarioRefuse(): Promise<void> {
  const probes = [
    { what: "somewhere outside the folder entirely", path: "/etc/passwd" },
    { what: "the protocol's own area inside the folder", path: join(".fsio/host.json") },
    { what: "a parent directory, by traversal", path: join("../secrets.txt") },
    { what: "a relative path (ACP sends absolute ones)", path: NOTES },
  ];
  say("I'll try to reach four places I shouldn't, and tell you exactly what the page says back.");
  for (const p of probes) {
    if (cancelled) return;
    const r = await readFile(p.path);
    if (r.ok) say(`⚠ ${p.what} — ALLOWED (${p.path}). That is a hole; the page should have refused this.`);
    else say(`✓ ${p.what}\n    asked for: ${p.path}\n    page said: ${r.why}`);
  }
  say("Those refusals arrived as ordinary errors, which is what lets an agent relay them to you.");
}

/** Several asks in one turn — does the card stack, and does answering one
 *  leave the others answerable? */
async function scenarioMany(): Promise<void> {
  say("Three separate changes, three separate asks. Answer them in any order.");
  for (let i = 1; i <= 3; i++) {
    if (cancelled) return;
    const name = `puppet-${i}.txt`;
    const path = join(name);
    const edit: Edit = { path, oldText: "", newText: `file ${i}, written after you said yes\n` };
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

/** No ask at all: proves a read needs no permission card, because the human
 *  already granted the folder. */
async function scenarioRead(): Promise<void> {
  const path = join(NOTES);
  const r = await readFile(path);
  if (r.ok) say(`${NOTES} is ${r.content.length} characters. I asked the page for it; no permission card, because you already granted the folder.`);
  else say(`Could not read ${NOTES}: ${r.why}`);
}

function pickScenario(text: string): () => Promise<void> {
  const t = text.toLowerCase();
  if (t.includes("refuse")) return scenarioRefuse;
  if (t.includes("many")) return scenarioMany;
  if (t.includes("read")) return scenarioRead;
  return scenarioEdit;
}

// ---- request handling (the page asks; the puppet answers)

function promptText(params: Record<string, unknown> | undefined): string {
  const blocks = (params?.["prompt"] as { type?: string; text?: string }[] | undefined) ?? [];
  return blocks.map((b) => b.text ?? "").join(" ");
}

async function handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentInfo: { name: "fsio puppet (not a real agent)", version: "1" },
        // Only claim what it actually does. It asks for permission and it
        // uses the client's filesystem; it runs no terminals.
        agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
        authMethods: [],
      };
    case "session/new":
      sessionId = `fixture-${Date.now().toString(36)}`;
      cwd = String(params?.["cwd"] ?? "");
      if (!cwd) throw { code: -32602, message: "session/new needs an absolute cwd — the puppet has no hands and cannot guess one" };
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

function handleNotification(method: string): void {
  if (method === "session/cancel") cancelled = true;
}

// ---- stdio loop

let buf = "";
process.stdin.on("data", (chunk: Buffer) => {
  buf += chunk.toString("utf8");
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) dispatch(line);
  }
});
process.stdin.on("end", () => process.exit(0));

function dispatch(line: string): void {
  let msg: Rpc;
  try {
    msg = JSON.parse(line) as Rpc;
  } catch {
    process.stderr.write(`puppet: unparseable input: ${line.slice(0, 120)}\n`);
    return;
  }

  // A response to something the puppet asked.
  if (msg.method === undefined) {
    if (msg.id === undefined) return;
    const waiter = pending.get(Number(msg.id));
    if (!waiter) return; // unknown id: legal to ignore
    pending.delete(Number(msg.id));
    if (msg.error) waiter.reject(new Error(msg.error.message));
    else waiter.resolve(msg.result);
    return;
  }

  // A notification from the page.
  if (msg.id === undefined) {
    handleNotification(msg.method);
    return;
  }

  // A request from the page.
  const id = msg.id;
  void handleRequest(msg.method, msg.params).then(
    (result) => out({ jsonrpc: "2.0", id, result: result ?? null }),
    (e: unknown) => {
      const err = e as { code?: number; message?: string };
      out({ jsonrpc: "2.0", id, error: { code: typeof err.code === "number" ? err.code : -32603, message: err.message ?? String(e) } });
    }
  );
}
