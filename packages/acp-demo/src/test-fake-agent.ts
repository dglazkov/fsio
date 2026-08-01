#!/usr/bin/env node
// A fake ACP agent: NDJSON on stdio, with knobs the real ones don't have.
//
// The kind under test (acp-kind.ts) makes exactly one promise about the
// payload channel — one DATA frame is one complete ACP message — and the
// interesting cases are the ones a well-behaved agent never produces: a
// message split across pipe writes, junk sharing stdout, a line with no
// newline in sight. So the fixture produces them on request.
//
// Methods (all JSON-RPC 2.0 requests unless noted):
//   initialize      → a plausible ACP initialize result
//   echo            → { echo: params }
//   count           → { messages } — how many lines it has received
//   split           → the response, written in three pipe writes
//   junk (notify)   → writes a non-JSON line and a JSON array to stdout
//   noise (notify)  → writes to stderr
//   flood (notify)  → a very long line with no newline, then a real message
//   quit (notify)   → exits with params.code
import process from "node:process";

const out = (obj: unknown): void => {
  process.stdout.write(JSON.stringify(obj) + "\n");
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let received = 0;
let buf = "";

process.stdin.on("data", (chunk: Buffer) => {
  buf += chunk.toString("utf8");
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) void handle(line);
  }
});

async function handle(line: string): Promise<void> {
  received++;
  let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch {
    process.stderr.write(`fake-agent: unparseable input: ${line.slice(0, 80)}\n`);
    return;
  }
  const id = msg.id;
  const reply = (result: unknown): void => out({ jsonrpc: "2.0", id, result });
  switch (msg.method) {
    case "initialize":
      reply({ protocolVersion: 1, agentInfo: { name: "fake-agent", version: "0.0.1" }, agentCapabilities: {} });
      return;
    case "echo":
      reply({ echo: msg.params ?? null });
      return;
    case "count":
      reply({ messages: received });
      return;
    case "split": {
      // One message, three pipe writes: the reassembly case.
      const text = JSON.stringify({ jsonrpc: "2.0", id, result: { split: true, filler: "x".repeat(200) } });
      const a = text.slice(0, 10);
      const b = text.slice(10, 40);
      const c = text.slice(40);
      process.stdout.write(a);
      await sleep(15);
      process.stdout.write(b);
      await sleep(15);
      process.stdout.write(c + "\n");
      return;
    }
    case "junk":
      process.stdout.write("Update available: run npm i -g fake-agent\n");
      process.stdout.write("[1, 2, 3]\n"); // valid JSON, not a message
      out({ jsonrpc: "2.0", method: "still/here", params: {} });
      return;
    case "noise":
      process.stderr.write(`fake-agent: EPERM writing /Users/nobody/.fake/state.json\n`);
      return;
    case "flood":
      process.stdout.write("z".repeat(1_500_000));
      process.stdout.write("\n");
      out({ jsonrpc: "2.0", method: "after/flood", params: {} });
      return;
    case "quit":
      process.exit(Number(msg.params?.["code"] ?? 0));
      return;
    default:
      if (id !== undefined) out({ jsonrpc: "2.0", id, error: { code: -32601, message: `no such method: ${String(msg.method)}` } });
  }
}
