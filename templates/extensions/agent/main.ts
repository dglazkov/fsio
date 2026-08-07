// Where you talk to an agent — and this tab, not the host, is the ACP client.
//
// `pewt.agent()` hands over a live wire carrying whole ACP messages, and no
// opinion about them. Everything that makes it a conversation is this file:
// correlating ids, streaming the agent's words into a transcript, and turning
// `session/request_permission` into buttons somebody designed. That is the
// point of the arrangement: the agent's questions are answered by the party
// with you and the screen in front of it, so what a question looks like is
// yours to change — it is this file, in your pewter.
//
// One tab is one conversation with one agent. For a second one, open another
// tab: `pewt tabs add agent`.
import { pewt, args, explain, type Agent } from "pewter";
// The shared look, an ordinary dependency of this pewter — the same
// arrangement as an ACP adapter. The bare import registers the kit's
// elements; the css import is the styles. Both queries below come back
// typed because the kit's .d.ts names its tags, which is also how
// `pewt check` knows what a <pewter-menu> can do.
import "pewter-ui";
import "pewter-ui/style.css";

const status = document.querySelector("pewter-status")!;
const picker = document.getElementById("picker")!;
const note = document.getElementById("note")!;
const places = document.querySelector("pewter-menu")!;
const chat = document.getElementById("chat")!;
const who = document.getElementById("who")!;
const log = document.getElementById("log")!;
const composer = document.getElementById("composer") as HTMLFormElement;
const say = document.getElementById("say") as HTMLTextAreaElement;
const send = document.getElementById("send") as HTMLButtonElement;
const stop = document.getElementById("stop") as HTMLButtonElement;

// ---- the JSON-RPC peer ACP needs, over the wire `pewt.agent()` holds
//
// A peer rather than a client, because the interesting direction is the one
// coming at us: `session/request_permission` is a request FROM the agent.
// The host promised one message arrives whole in each direction, so there is
// no buffer here and no half-message state.

type Params = Record<string, unknown> | undefined;

class Rpc {
  #send: (message: unknown) => void;
  #next = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #requests = new Map<string, (params: Params) => Promise<unknown> | unknown>();
  #notifications = new Map<string, (params: Params) => void>();

  constructor(send: (message: unknown) => void) {
    this.#send = send;
  }

  request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.#send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  onRequest(method: string, fn: (params: Params) => Promise<unknown> | unknown): void {
    this.#requests.set(method, fn);
  }

  onNotification(method: string, fn: (params: Params) => void): void {
    this.#notifications.set(method, fn);
  }

  /** One whole message from the agent: a request, a notification, or the
   *  answer to something this tab sent. */
  deliver(message: unknown): void {
    const msg = message as {
      id?: number | string;
      method?: string;
      params?: Params;
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    if (typeof msg.method === "string") {
      if (msg.id === undefined) {
        this.#notifications.get(msg.method)?.(msg.params);
        return;
      }
      void this.#answer(msg.id, msg.method, msg.params);
      return;
    }
    if (typeof msg.id !== "number") return;
    const waiting = this.#pending.get(msg.id);
    if (!waiting) return; // an answer to nothing this tab asked; legal to ignore
    this.#pending.delete(msg.id);
    if (msg.error) waiting.reject(new Error(msg.error.message ?? "the agent refused"));
    else waiting.resolve(msg.result);
  }

  /** The agent is gone; nobody is going to answer these now. */
  fail(reason: string): void {
    for (const [, waiting] of this.#pending) waiting.reject(new Error(reason));
    this.#pending.clear();
  }

  async #answer(id: number | string, method: string, params: Params): Promise<void> {
    const fn = this.#requests.get(method);
    if (!fn) {
      // An honest refusal over silence. `fs/*` lands here on purpose: this
      // tab holds no file handle, and the agent is a process in the project
      // that reads and writes with its own hands — which is exactly what the
      // asks/does-not-ask line in the transcript is about.
      this.#send({ jsonrpc: "2.0", id, error: { code: -32601, message: `this tab has no handler for ${method}` } });
      return;
    }
    try {
      const result = await fn(params);
      this.#send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (e) {
      this.#send({ jsonrpc: "2.0", id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
    }
  }
}

// ---- the transcript

/** The agent's words arrive as fragments, so consecutive fragments of one
 *  kind append to one block — the agent owns its line breaks, not this
 *  screen. Anything else that lands in the transcript resets the weld. */
let streaming: { kind: string; el: HTMLElement } | null = null;

function entry(kind: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `entry ${kind}`;
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function line(kind: string, text: string): HTMLElement {
  streaming = null;
  const el = entry(kind);
  el.textContent = text;
  return el;
}

function stream(kind: "agent" | "thought", text: string): void {
  if (!text) return;
  if (!streaming || streaming.kind !== kind) streaming = { kind, el: entry(kind) };
  streaming.el.textContent += text;
  log.scrollTop = log.scrollHeight;
}

interface Block {
  type?: string;
  text?: string;
  path?: string;
  content?: Block;
}

const blockText = (b: Block | undefined): string => (b ? (typeof b.text === "string" ? b.text : blockText(b.content)) : "");

interface ToolCall {
  toolCallId?: string;
  title?: string;
  status?: string;
  content?: Block[];
}

/** One line of what a tool call is about — enough to judge a permission
 *  question without a diff viewer. A diff viewer is a fine thing to add;
 *  this file is in your pewter. */
function summary(content: Block[] | undefined): string {
  if (!content?.length) return "";
  return content
    .map((c) => {
      if (c.type === "diff" && c.path) return `edit ${c.path}`;
      const t = blockText(c).trim();
      return t.length > 200 ? t.slice(0, 200) + "…" : t;
    })
    .filter((t) => t)
    .join("\n");
}

const tools = new Map<string, { title: HTMLElement; status: HTMLElement; detail: HTMLElement }>();

function toolRow(tc: ToolCall): void {
  streaming = null;
  const el = entry("tool");
  const title = document.createElement("span");
  title.className = "tool-title";
  title.textContent = tc.title ?? "tool call";
  const state = document.createElement("span");
  state.className = "tool-status";
  state.textContent = tc.status ?? "pending";
  const detail = document.createElement("div");
  detail.className = "tool-detail";
  detail.textContent = summary(tc.content);
  el.append(title, state, detail);
  if (tc.toolCallId) tools.set(tc.toolCallId, { title, status: state, detail });
}

function toolUpdate(tc: ToolCall): void {
  const row = tc.toolCallId ? tools.get(tc.toolCallId) : undefined;
  if (!row) return;
  if (tc.title) row.title.textContent = tc.title;
  if (tc.status) row.status.textContent = tc.status;
  const more = summary(tc.content);
  if (more) row.detail.textContent = more;
}

/** `session/update` — everything the agent narrates while it works. */
function update(params: Params): void {
  const u = (params?.["update"] ?? {}) as Record<string, unknown>;
  switch (String(u["sessionUpdate"] ?? "")) {
    case "agent_message_chunk":
      return stream("agent", blockText(u["content"] as Block));
    case "agent_thought_chunk":
      return stream("thought", blockText(u["content"] as Block));
    case "tool_call":
      return toolRow(u as ToolCall);
    case "tool_call_update":
      return toolUpdate(u as ToolCall);
    case "plan": {
      const items = (u["entries"] as { content?: string; status?: string }[] | undefined) ?? [];
      if (items.length) line("note", "plan: " + items.map((i) => `${i.status === "completed" ? "✓" : "•"} ${i.content ?? ""}`).join("  "));
      return;
    }
    default:
      return; // available_commands_update and friends — not this screen's business
  }
}

/** The agent's permission question, as a card with buttons. The promise
 *  resolves when you click, and that IS the JSON-RPC response — the agent
 *  stays parked on it for exactly as long as you take. */
function permission(params: Params): Promise<unknown> {
  const tc = (params?.["toolCall"] ?? {}) as ToolCall;
  const options = ((params?.["options"] as { optionId?: string; name?: string }[] | undefined) ?? []).filter((o) => o.optionId);
  streaming = null;
  const card = entry("permission");
  const title = document.createElement("p");
  title.textContent = tc.title ?? "the agent wants to do something";
  card.append(title);
  const detail = summary(tc.content);
  if (detail) {
    const p = document.createElement("pre");
    p.textContent = detail;
    card.append(p);
  }
  const verbs = document.createElement("div");
  verbs.className = "choices";
  card.append(verbs);
  return new Promise((resolve) => {
    const settle = (optionId: string | null, name: string): void => {
      verbs.replaceChildren();
      const answer = document.createElement("em");
      answer.textContent = name;
      verbs.append(answer);
      resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
    };
    for (const o of options) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = o.name ?? o.optionId!;
      b.addEventListener("click", () => settle(o.optionId!, b.textContent ?? ""));
      verbs.append(b);
    }
    // A question with no options is not answerable in its own words, and
    // cancelling is the one honest answer this screen can always give.
    if (!options.length) {
      const never = document.createElement("button");
      never.type = "button";
      never.textContent = "cancel";
      never.addEventListener("click", () => settle(null, "cancelled"));
      verbs.append(never);
    }
  });
}

// ---- the conversation

/** The one running conversation, or null. Everything the composer needs. */
let live: { rpc: Rpc; sessionId: string } | null = null;
/** Which agent's exit still means anything — an old exit must not narrate
 *  over a newer conversation. */
let current: Agent | null = null;
let turning = false;

/** Where the agent runs, and which agent it would be. Asked fresh every time
 *  the picker shows, so a project cloned — or an adapter installed — since
 *  the last conversation is on the list. */
async function offer(): Promise<void> {
  chat.hidden = true;
  picker.hidden = false;
  note.textContent = "asking the host…";
  try {
    const [{ agents }, { repos }] = await Promise.all([pewt.agents.list(), pewt.repos.list()]);
    const installed = agents.filter((a) => a.installed);
    if (installed.length === 0) {
      // Nothing to start. An adapter is an ordinary dependency, so the fix
      // is a line you type, and the roster knows the lines — hints, not
      // choices, because there is nothing to pick yet.
      note.textContent = "this pewter has no ACP adapter installed — an adapter is an ordinary dependency:";
      places.hints = agents.map((a) => `${a.install} — ${a.asks ? "asks before it edits" : "edits with its own hands"}`);
      return;
    }
    const first = installed[0]!;
    note.textContent = `${first.title}${first.version ? ` ${first.version}` : ""} — ${first.asks ? "asks before it edits" : "edits with its own hands"}. The host asks before it starts one.`;
    places.choices = [{ value: null, label: "this pewter" }, ...repos.map((r) => ({ value: r.name, label: r.name }))];
    places.onpick = (where) => void open(where);
  } catch (e) {
    note.textContent = explain(e);
  }
}

/** One conversation, for as long as the agent runs. */
async function open(repo: string | null): Promise<void> {
  picker.hidden = true;
  chat.hidden = false;
  log.replaceChildren();
  tools.clear();
  streaming = null;
  live = null;
  who.textContent = "";
  say.disabled = true;
  send.disabled = true;
  status.say("waiting — the host asks on its own terminal before it starts an agent");

  let agent: Agent;
  const rpc = new Rpc((message) => agent.send(message));
  try {
    agent = await pewt.agent({ ...(repo ? { repo } : {}), onMessage: (m) => rpc.deliver(m) });
  } catch (e) {
    // A refusal is a normal ending: the human at the host's terminal said
    // no, or there is nothing to start. Back to the picker, under the reason.
    status.say(explain(e));
    await offer();
    return;
  }
  current = agent;

  const info = agent.info;
  who.textContent = `${info.title}${info.version ? ` ${info.version}` : ""} — in ${info.where}`;
  // The roster measured whether this agent asks before it edits. Said before
  // the first prompt rather than found out after the first edit.
  line(
    "note",
    (info.asks ? "this agent asks before it changes a file" : "this agent edits with its own hands — it will not ask first") +
      (info.unmeasured ? " (measured against a different version than yours)" : "")
  );

  rpc.onNotification("session/update", update);
  rpc.onRequest("session/request_permission", permission);

  // The exit, whenever it comes. Anything the agent said on stderr on the
  // way out is on the terminal running `pewt serve`, not here.
  void agent.exit.then((code) => {
    if (current !== agent) return;
    rpc.fail("the agent exited");
    live = null;
    turn(false);
    say.disabled = true;
    send.disabled = true;
    status.say(code === null ? "the agent ended without an exit code — a signal, or the host went away" : `the agent exited (${code})`);
    status.offer("new conversation", () => {
      current = null;
      void offer();
    });
  });

  try {
    // The ACP handshake. The fs capabilities are declared false because they
    // are: this tab holds no file handle, so the agent touches the project
    // with its own hands and this screen narrates what it hears.
    await rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const made = await rpc.request<{ sessionId?: string }>("session/new", {
      // Absolute, because ACP requires one — it arrived with the started
      // agent, labelled for exactly this call.
      cwd: info.cwd,
      mcpServers: [],
    });
    if (!made.sessionId) throw new Error("the agent answered session/new without a sessionId");
    live = { rpc, sessionId: made.sessionId };
  } catch (e) {
    line("error", explain(e));
    agent.close();
    return;
  }
  status.hide();
  say.disabled = false;
  send.disabled = false;
  say.focus();
}

/** One turn: your words in, the agent's stream back, an end reason. */
async function ask(): Promise<void> {
  const text = say.value.trim();
  if (!text || !live || turning) return;
  say.value = "";
  line("user", text);
  turn(true);
  try {
    const done = await live.rpc.request<{ stopReason?: string }>("session/prompt", {
      sessionId: live.sessionId,
      prompt: [{ type: "text", text }],
    });
    if (done.stopReason && done.stopReason !== "end_turn") line("note", `turn ended: ${done.stopReason}`);
  } catch (e) {
    line("error", explain(e));
  } finally {
    turn(false);
    streaming = null;
  }
}

function turn(on: boolean): void {
  turning = on;
  send.disabled = on || !live;
  stop.hidden = !on;
}

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  void ask();
});
// Enter sends; Shift+Enter is a newline. A chat-box convention, and yours to
// change.
say.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void ask();
  }
});
// Stop is a notification, not a plea: the agent ends the turn and says how
// (`stopReason: "cancelled"`), and the prompt's answer arrives normally.
stop.addEventListener("click", () => {
  if (live) live.rpc.notify("session/cancel", { sessionId: live.sessionId });
});

// Opened with `{repo}` — the repos row's agent verb — this screen skips its
// picker and goes straight there. Opened bare, it offers the choice. Either
// way the host asks before anything starts: the argument opened a screen,
// not a process.
const openedWith = (await args) as { repo?: unknown } | undefined;
if (openedWith && typeof openedWith.repo === "string") {
  await open(openedWith.repo);
} else {
  await offer();
}
