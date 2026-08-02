// The puppet agent (fixture-agent.ts), driven by a scripted client.
//
// What is under test is the *client role* the demo page plays: the page has
// to answer `session/request_permission` and serve `fs/*`, and until #100
// nothing had ever asked it to. This test plays that role in Node so the
// puppet's half of the contract is checked on every push, and the browser is
// left to prove only what a browser can (that the card renders, and that a
// human can answer it).
//
// Note what this file does NOT need: a tmpdir. The puppet never touches the
// filesystem — that is its defining property — so the "filesystem" here is a
// Map, and the folder it is pointed at deliberately does not exist. If the
// puppet ever grew hands, the last test in this file would catch it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

const FIXTURE = path.join(import.meta.dirname, "fixture-agent.js");
/** Deliberately absent: the puppet is handed a folder that is not there, and
 *  is expected never to notice, because it never looks. */
const CWD = "/fsio-puppet-does-not-exist/workspace";

interface Ask {
  toolCall: { toolCallId?: string; title?: string; locations?: { path?: string }[]; content?: unknown[] };
  options: { optionId: string; name: string; kind?: string }[];
}

/** The page, in Node: answers what the puppet asks, records what it did. */
class ScriptedClient {
  readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #buf = "";

  /** canned contents the client will serve for `fs/read_text_file`. */
  files = new Map<string, string>();
  /** paths the client refuses, with the message an agent would relay. */
  refusals = new Map<string, string>();

  /** everything the puppet asked permission for, in order. */
  asks: Ask[] = [];
  /** what the puppet wrote, through us. */
  writes: { path: string; content: string }[] = [];
  /** paths the puppet asked to read, in order. */
  reads: string[] = [];
  /** agent_message_chunk text, concatenated. */
  said = "";
  /** tool_call / tool_call_update payloads, in order. */
  tools: Record<string, unknown>[] = [];

  /** how to answer the next permission ask; default: allow once. */
  policy: (ask: Ask) => { outcome: { outcome: string; optionId?: string } } = (a) => ({
    outcome: { outcome: "selected", optionId: a.options[0]?.optionId ?? "allow-once" },
  });

  constructor() {
    this.child = spawn(process.execPath, [FIXTURE], { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessByStdio<
      Writable,
      Readable,
      Readable
    >;
    this.child.stdout.on("data", (c: Buffer) => this.#feed(c));
    this.child.stderr.on("data", () => {});
  }

  request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    this.child.kill("SIGKILL");
  }

  #send(msg: unknown): void {
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  #feed(chunk: Buffer): void {
    this.#buf += chunk.toString("utf8");
    let i: number;
    while ((i = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, i);
      this.#buf = this.#buf.slice(i + 1);
      if (line.trim()) this.#dispatch(line);
    }
  }

  #dispatch(line: string): void {
    const msg = JSON.parse(line) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message: string };
    };

    // A response to something we asked the puppet.
    if (msg.method === undefined) {
      if (msg.id === undefined) return;
      const w = this.#pending.get(msg.id);
      if (!w) return;
      this.#pending.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message));
      else w.resolve(msg.result);
      return;
    }

    // A notification: the transcript.
    if (msg.id === undefined) {
      if (msg.method === "session/update") {
        const u = (msg.params?.["update"] ?? {}) as Record<string, unknown>;
        const kind = String(u["sessionUpdate"] ?? "");
        if (kind === "agent_message_chunk") this.said += String((u["content"] as { text?: string })?.text ?? "");
        else if (kind === "tool_call" || kind === "tool_call_update") this.tools.push(u);
      }
      return;
    }

    // A request: this is the half that had never run.
    void this.#answer(msg.id, msg.method, msg.params ?? {});
  }

  async #answer(id: number, method: string, params: Record<string, unknown>): Promise<void> {
    const fail = (message: string): void => {
      this.#send({ jsonrpc: "2.0", id, error: { code: -32602, message } });
    };
    switch (method) {
      case "session/request_permission": {
        const ask = { toolCall: params["toolCall"], options: params["options"] } as Ask;
        this.asks.push(ask);
        this.#send({ jsonrpc: "2.0", id, result: this.policy(ask) });
        return;
      }
      case "fs/read_text_file": {
        const p = String(params["path"]);
        this.reads.push(p);
        const refusal = this.refusals.get(p);
        if (refusal) return fail(refusal);
        const content = this.files.get(p);
        if (content === undefined) return fail(`refused: no such file ${p}`);
        this.#send({ jsonrpc: "2.0", id, result: { content } });
        return;
      }
      case "fs/write_text_file": {
        const p = String(params["path"]);
        const refusal = this.refusals.get(p);
        if (refusal) return fail(refusal);
        this.writes.push({ path: p, content: String(params["content"] ?? "") });
        this.files.set(p, String(params["content"] ?? ""));
        this.#send({ jsonrpc: "2.0", id, result: null });
        return;
      }
      default:
        return fail(`this scripted client does not implement ${method}`);
    }
  }
}

/** Boot a puppet through initialize + session/new. */
async function start(): Promise<ScriptedClient> {
  const c = new ScriptedClient();
  await c.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
  await c.request("session/new", { cwd: CWD, mcpServers: [] });
  return c;
}

// ---------------------------------------------------------------- handshake

test("puppet: initialize names itself a fixture, so no page can mistake it for an agent", async () => {
  const c = new ScriptedClient();
  try {
    const init = (await c.request("initialize", { protocolVersion: 1 })) as { agentInfo?: { name?: string } };
    assert.match(init.agentInfo?.name ?? "", /not a real agent/i);
  } finally {
    c.close();
  }
});

test("puppet: session/new refuses without a cwd — it has no hands and cannot guess one (D22)", async () => {
  const c = new ScriptedClient();
  try {
    await c.request("initialize", { protocolVersion: 1 });
    await assert.rejects(() => c.request("session/new", { mcpServers: [] }), /absolute cwd/);
  } finally {
    c.close();
  }
});

// ----------------------------------------------------------------- the demo

test("puppet: asks permission BEFORE writing, and the write matches the diff it showed", async () => {
  const c = await start();
  try {
    c.files.set(path.posix.join(CWD, "NOTES.md"), "existing\n");
    await c.request("session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "go" }] });

    assert.equal(c.asks.length, 1, "exactly one permission ask");
    const ask = c.asks[0]!;
    // The card has to carry enough to decide on: which file, and what change.
    assert.equal(ask.toolCall.locations?.[0]?.path, path.posix.join(CWD, "NOTES.md"));
    const diff = (ask.toolCall.content as { type?: string; newText?: string }[])[0]!;
    assert.equal(diff.type, "diff", "the ask carries a diff, not just a title");

    assert.equal(c.writes.length, 1, "exactly one write");
    assert.equal(c.writes[0]!.content, diff.newText, "wrote exactly what the human approved");
    assert.match(c.writes[0]!.content, /puppet edit #1/);
    assert.deepEqual(
      c.tools.filter((t) => t["sessionUpdate"] === "tool_call_update").map((t) => t["status"]),
      ["completed"]
    );
  } finally {
    c.close();
  }
});

test("puppet: a rejected ask writes nothing at all (P5 — the asker is not the decider)", async () => {
  const c = await start();
  try {
    c.files.set(path.posix.join(CWD, "NOTES.md"), "existing\n");
    c.policy = () => ({ outcome: { outcome: "selected", optionId: "reject" } });
    await c.request("session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "go" }] });

    assert.equal(c.asks.length, 1);
    assert.equal(c.writes.length, 0, "rejection means no write");
    assert.deepEqual(
      c.tools.filter((t) => t["sessionUpdate"] === "tool_call_update").map((t) => t["status"]),
      ["failed"]
    );
    assert.match(c.said, /left the file alone/);
  } finally {
    c.close();
  }
});

test("puppet: a cancelled ask also writes nothing", async () => {
  const c = await start();
  try {
    c.files.set(path.posix.join(CWD, "NOTES.md"), "");
    c.policy = () => ({ outcome: { outcome: "cancelled" } });
    await c.request("session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "go" }] });
    assert.equal(c.writes.length, 0);
    assert.match(c.said, /Cancelled/);
  } finally {
    c.close();
  }
});

test("puppet: a missing file becomes a proposal to create it, not a crash", async () => {
  const c = await start();
  try {
    // No canned file: the client refuses the read the way a real page would.
    await c.request("session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "go" }] });
    assert.equal(c.asks.length, 1, "still asks before creating");
    assert.equal(c.writes.length, 1);
    assert.match(c.said, /isn't there yet/);
  } finally {
    c.close();
  }
});

// ----------------------------------------------------------- the refusals

test("puppet: relays the client's refusal TEXT verbatim — the point of writing it to be relayed", async () => {
  const c = await start();
  try {
    const outside = "/etc/passwd";
    const fsioFile = path.posix.join(CWD, ".fsio/host.json");
    c.refusals.set(outside, "refused: /etc/passwd is outside the folder you granted (workspace)");
    c.refusals.set(fsioFile, "refused: .fsio is the protocol's own area, not payload");
    // Deliberately NOT path.join'd: the puppet sends the traversal unnormalized
    // (`<cwd>/../secrets.txt`), which is the spelling a containment check has
    // to catch. Normalizing it here would test a case nobody sends.
    c.refusals.set(`${CWD}/../secrets.txt`, "refused: that path escapes the folder");
    c.refusals.set("NOTES.md", "refused: expected an absolute path");

    await c.request("session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "refuse" }] });

    assert.equal(c.reads.length, 4, "probed all four places");
    assert.equal(c.writes.length, 0, "a refusal scenario writes nothing");
    // The exact strings the client produced are in the transcript a human reads.
    assert.match(c.said, /outside the folder you granted/);
    assert.match(c.said, /protocol's own area/);
    assert.match(c.said, /escapes the folder/);
    assert.match(c.said, /expected an absolute path/);
    assert.doesNotMatch(c.said, /⚠/, "nothing was allowed that should have been refused");
  } finally {
    c.close();
  }
});

test("puppet: consecutive message chunks are newline-terminated, so a client that concatenates them reads correctly", async () => {
  // Measured in the browser 2026-08-01: a client is right to append
  // consecutive `agent_message_chunk`s into one flowing block (they are
  // fragments of one message), so an agent that omits its own line breaks
  // gets a transcript with every line welded to the next. The agent owns its
  // terminators. This asserts the four `refuse` findings stay four lines.
  const c = await start();
  try {
    c.refusals.set("/etc/passwd", "refused: outside the folder");
    await c.request("session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "refuse" }] });
    assert.doesNotMatch(c.said, /[^\n]✓/, "every finding starts on its own line");
    // 1 preamble + 4 findings + 1 closing line, each terminated.
    assert.equal(c.said.split("\n").filter((l) => l.trim()).length >= 6, true, `expected >= 6 lines, got:\n${c.said}`);
    assert.equal(c.said.endsWith("\n"), true, "the last line is terminated too");
  } finally {
    c.close();
  }
});

test("puppet: an allowed out-of-bounds read is flagged loudly, not passed over", async () => {
  const c = await start();
  try {
    // A client that wrongly serves /etc/passwd — the shape of the bug this
    // scenario exists to catch.
    c.files.set("/etc/passwd", "root:x:0:0:...");
    await c.request("session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "refuse" }] });
    assert.match(c.said, /⚠.*ALLOWED/s, "a hole is reported as a hole");
  } finally {
    c.close();
  }
});

// ------------------------------------------------------------ other scenarios

test("puppet: a read needs no permission card — the folder grant already covers it", async () => {
  const c = await start();
  try {
    c.files.set(path.posix.join(CWD, "NOTES.md"), "hello\n");
    await c.request("session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "just read it" }] });
    assert.equal(c.asks.length, 0, "no card for a read");
    assert.equal(c.writes.length, 0);
    assert.deepEqual(c.reads, [path.posix.join(CWD, "NOTES.md")]);
  } finally {
    c.close();
  }
});

test("puppet: 'many' asks three times, and each answer is honoured independently", async () => {
  const c = await start();
  try {
    let n = 0;
    c.policy = () => {
      n++;
      return { outcome: { outcome: "selected", optionId: n === 2 ? "reject" : "allow-once" } };
    };
    await c.request("session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "many" }] });

    assert.equal(c.asks.length, 3, "three separate asks");
    assert.deepEqual(
      c.writes.map((w) => path.posix.basename(w.path)),
      ["puppet-1.txt", "puppet-3.txt"],
      "the rejected one is the only one not written"
    );
  } finally {
    c.close();
  }
});

test("puppet: session/cancel stops the turn mid-scenario", async () => {
  const c = await start();
  try {
    c.policy = () => {
      c.notify("session/cancel", { sessionId: "s" });
      return { outcome: { outcome: "cancelled" } };
    };
    const r = (await c.request("session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "many" }] })) as {
      stopReason?: string;
    };
    assert.equal(r.stopReason, "cancelled");
    assert.ok(c.asks.length < 3, `stopped early (asked ${c.asks.length} of 3)`);
  } finally {
    c.close();
  }
});

// ------------------------------------------------------------- the invariant

test("puppet: has no hands — it never touches the filesystem it was pointed at", async () => {
  const c = await start();
  try {
    assert.equal(fs.existsSync(CWD), false, "precondition: the folder does not exist");
    for (const prompt of ["go", "refuse", "many", "read"]) {
      await c.request("session/prompt", { sessionId: "s", prompt: [{ type: "text", text: prompt }] });
    }
    assert.equal(c.writes.length > 0, true, "it did write — through the client");
    // Every byte went through the client. Nothing reached the disk, which is
    // the property that makes this fixture exercise the page at all.
    assert.equal(fs.existsSync(CWD), false, "the puppet created nothing on disk");
    assert.equal(fs.existsSync("/fsio-puppet-does-not-exist"), false);
  } finally {
    c.close();
  }
});
