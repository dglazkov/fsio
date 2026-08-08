#!/usr/bin/env node
// A scripted agent: it says things, it names files, and it asks.
//
// **What it is for.** Four screens' worth of work landed with commit messages
// ending "nobody has looked at it", because looking meant having a
// conversation — an API key, a network, and an agent that happened to ask for
// permission at the right moment. `npm run kit` fixed that for the kit's
// elements; this fixes it for the screen those elements are in. Nothing here
// calls a model, opens a socket, or costs anything, and it does the same
// thing every run, which is what makes it drivable.
//
// **It is startable at all because of #201.** The adapter catalog used to
// refuse any name it did not know, so a puppet could be installed and never
// run. The catalog informs now; what makes this startable is npm putting it
// in `node_modules/.bin`. It arrives with `asks: null` — nobody measured it —
// and the host's question says so, which is itself worth seeing once.
//
// **What it exercises, which is the half `acp-demo`'s puppet does not.** That
// one is built around `fs/read_text_file`: it has no hands and reads
// everything through the page's grant. Pewter's agent screen declares those
// capabilities false on purpose — an agent here is a process in the project
// with its own hands — so the interesting surface is the other one: markdown
// streaming into a transcript, tool calls carrying `locations` that a screen
// turns into real tabs, and `session/request_permission` with option kinds a
// card can weigh.
//
// **Scenarios, keyed off the prompt** so a person or a loop can ask for one
// by name. Anything unrecognized runs `edit`.
//
//   edit       stream, one tool call, one permission ask, then the outcome
//   markdown   every construct the renderer handles, and one it must refuse
//   many       three asks in one turn — the card stack, and the queue
//   tools      four tool calls, one in each state
//   slow       a long turn with pauses, for typing into while it runs
//   quiet      no asks at all: the path a well-behaved read-only turn takes
//
// Locations are absolute and rooted at this process's cwd, because that is
// what a real agent reports and what the screen's path arithmetic has to
// undo (`pewterPath` in the scaffolded agent screen).
import path from "node:path";
import process from "node:process";

interface Rpc {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

const out = (msg: unknown): void => {
  process.stdout.write(JSON.stringify(msg) + "\n");
};

/** Requests this peer sent that are still waiting — a permission ask is a
 *  request *from* the agent, and the answer arrives as an ordinary result. */
const waiting = new Map<number, (result: unknown) => void>();
let nextId = 1;

function ask<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve) => {
    waiting.set(id, resolve as (r: unknown) => void);
    out({ jsonrpc: "2.0", id, method, params });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let sessionId = "puppet-1";

const update = (u: Record<string, unknown>): void => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });

/** Say something, a few characters at a time.
 *
 *  Chunked because that is the case worth exercising: the screen welds
 *  consecutive fragments into one block and re-parses on every one, so a
 *  message that arrived whole would never test the thing that actually runs. */
async function say(text: string, kind: "agent_message_chunk" | "agent_thought_chunk" = "agent_message_chunk", chunk = 24): Promise<void> {
  for (let i = 0; i < text.length; i += chunk) {
    update({ sessionUpdate: kind, content: { type: "text", text: text.slice(i, i + chunk) } });
    await sleep(15);
  }
}

const here = (rel: string): string => path.resolve(process.cwd(), rel);

/** A tool call, and the handle to update it. */
function tool(id: string, title: string, kind: string, locations: string[], status = "pending"): (patch: Record<string, unknown>) => void {
  update({ sessionUpdate: "tool_call", toolCallId: id, title, kind, status, locations: locations.map((p) => ({ path: here(p) })) });
  return (patch) => update({ sessionUpdate: "tool_call_update", toolCallId: id, ...patch });
}

/** The permission question, in the shape ACP sends it and a card renders it.
 *
 *  The option `kind`s are the real ones — a screen maps `allow_*` and
 *  `reject_*` onto what an answer means, and a puppet that sent bare labels
 *  would leave that mapping untested. */
async function permission(toolCall: Record<string, unknown>): Promise<string | null> {
  const answer = await ask<{ outcome?: { outcome?: string; optionId?: string } }>("session/request_permission", {
    sessionId,
    toolCall,
    options: [
      { optionId: "allow_once", name: "allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "always allow", kind: "allow_always" },
      { optionId: "reject_once", name: "reject", kind: "reject_once" },
    ],
  });
  return answer.outcome?.outcome === "selected" ? (answer.outcome.optionId ?? null) : null;
}

// ---- the scenarios

async function edit(): Promise<void> {
  await say("Looking at `src/main.ts` — one moment.\n\n");
  const patch = tool("t1", "read src/main.ts", "read", ["src/main.ts"], "in_progress");
  await sleep(120);
  patch({ status: "completed", content: [{ type: "content", content: { type: "text", text: "export const a = 1;" } }] });

  await say("I want to change one line:\n\n```ts\n-export const a = 1;\n+export const a = 2;\n```\n\n");

  const chose = await permission({
    toolCallId: "t2",
    title: "Write src/main.ts",
    kind: "edit",
    locations: [{ path: here("src/main.ts") }],
    content: [{ type: "diff", path: here("src/main.ts") }],
  });

  if (chose && chose.startsWith("allow")) {
    const write = tool("t2", "write src/main.ts", "edit", ["src/main.ts"], "in_progress");
    await sleep(150);
    write({ status: "completed" });
    await say("Done — **one line** changed. Nothing was written to disk: this is a puppet.");
  } else {
    tool("t2", "write src/main.ts", "edit", ["src/main.ts"], "failed");
    await say("Left it alone.");
  }
}

async function markdown(): Promise<void> {
  await say(
    [
      "## What the renderer handles",
      "",
      "Inline `code`, **strong**, *em*, and a [link](https://example.test/210).",
      "",
      "- a flat bullet list",
      "- with a second item",
      "",
      "1. and an ordered one",
      "2. likewise",
      "",
      "> A blockquote, for the shape of it.",
      "",
      "```ts",
      'const where = (abs: string) => abs.replace(cwd, "");',
      "```",
      "",
      "---",
      "",
      "And one it must refuse: [not a link](javascript:alert(1)) stays text,",
      "as does <script>alert(1)</script> — both should read as characters.",
      "",
      "A soft line break",
      "is a line break here, not a space.",
    ].join("\n")
  );
}

async function many(): Promise<void> {
  await say("Three things, each needing a yes.\n\n");
  for (const [i, file] of ["src/one.ts", "src/two.ts", "src/three.ts"].entries()) {
    const chose = await permission({
      toolCallId: `m${i}`,
      title: `Write ${file}`,
      kind: "edit",
      locations: [{ path: here(file) }],
    });
    await say(`\n${file}: ${chose ?? "declined"}\n`);
  }
  await say("\nThat is all three.");
}

async function tools(): Promise<void> {
  await say("Four calls, one in each state.\n\n");
  tool("s1", "waiting to start", "other", [], "pending");
  tool("s2", "search for 'pewterPath'", "search", [], "in_progress");
  const done = tool("s3", "read two files", "read", ["src/a.ts", "src/b.ts"], "in_progress");
  await sleep(200);
  done({ status: "completed" });
  const bad = tool("s4", "run tests", "execute", [], "in_progress");
  await sleep(200);
  bad({
    status: "failed",
    content: [{ type: "content", content: { type: "text", text: "FAIL src/main.test.ts\n  ✕ it works (3 ms)\n\n  Expected: 1\n  Received: 2" } }],
  });
  await say("The failed one keeps an edge, which is the point of the state.");
}

async function slow(): Promise<void> {
  update({ sessionUpdate: "plan", entries: [{ content: "read", status: "completed" }, { content: "think", status: "in_progress" }, { content: "write", status: "pending" }] });
  await say("This turn takes a while on purpose. Type something while it runs — it should queue, show itself queued, and be sent when this ends.\n\n");
  for (let i = 1; i <= 6; i++) {
    await say(`step ${i} of 6…\n`);
    await sleep(700);
  }
  await say("\nFinished. Whatever you typed should be going out now.");
}

async function quiet(): Promise<void> {
  await say("Read three files, changed nothing, asked nobody. ");
  const t = tool("q1", "read src/", "read", ["src/main.ts"], "in_progress");
  await sleep(120);
  t({ status: "completed" });
  await say("This is what a turn with no consent moment looks like.");
}

const SCENARIOS: Record<string, () => Promise<void>> = { edit, markdown, many, tools, slow, quiet };

async function run(prompt: string): Promise<void> {
  const name = Object.keys(SCENARIOS).find((k) => prompt.toLowerCase().includes(k)) ?? "edit";
  await SCENARIOS[name]!();
}

// ---- the peer
//
// One message per line, and only the three methods a client sends. Anything
// else gets a JSON-RPC "method not found" rather than silence, because a
// puppet that ignored a message would look like a hang.

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c: string) => {
  buf += c;
  for (;;) {
    const at = buf.indexOf("\n");
    if (at === -1) break;
    const line = buf.slice(0, at).trim();
    buf = buf.slice(at + 1);
    if (!line) continue;
    let msg: Rpc;
    try {
      msg = JSON.parse(line) as Rpc;
    } catch {
      continue; // not ours; a real adapter's stdout has other things on it
    }
    void handle(msg);
  }
});

async function handle(msg: Rpc): Promise<void> {
  // An answer to something this peer asked — a permission verdict.
  if (msg.method === undefined && typeof msg.id === "number") {
    waiting.get(msg.id)?.(msg.result);
    waiting.delete(msg.id);
    return;
  }
  const id = msg.id;
  if (msg.method === "initialize") {
    out({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "puppet-acp", version: "0.0.1" },
        agentCapabilities: {},
      },
    });
    return;
  }
  if (msg.method === "session/new") {
    sessionId = "puppet-1";
    out({ jsonrpc: "2.0", id, result: { sessionId } });
    return;
  }
  if (msg.method === "session/prompt") {
    const blocks = (msg.params?.["prompt"] as { text?: string }[] | undefined) ?? [];
    const text = blocks.map((b) => b.text ?? "").join(" ");
    await run(text);
    out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }
  if (msg.method === "session/cancel") return; // a notification; nothing to answer
  if (id !== undefined) out({ jsonrpc: "2.0", id, error: { code: -32601, message: `puppet-acp has no ${msg.method}` } });
}

// stdin closing is the host taking the session away.
process.stdin.on("end", () => process.exit(0));
