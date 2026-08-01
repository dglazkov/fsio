// Framing unit tests: the "one DATA frame = one ACP message" contract
// (framing.ts), tested where it is cheapest — no host, no child.
import test from "node:test";
import assert from "node:assert/strict";
import { classify, LineSplitter, MAX_LINE_BYTES, toAgentLine } from "./framing.js";

const collect = (max?: number) => {
  const lines: string[] = [];
  const overflows: number[] = [];
  const s = new LineSplitter({ line: (t) => lines.push(t), overflow: (b) => overflows.push(b) }, max);
  return { s, lines, overflows };
};

test("splitter: a message split across pipe writes is delivered once, whole", () => {
  const { s, lines } = collect();
  const msg = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  for (const ch of [msg.slice(0, 5), msg.slice(5, 11), msg.slice(11) + "\n"]) s.push(Buffer.from(ch));
  assert.deepEqual(lines, [msg]);
});

test("splitter: several messages in one read are delivered in order", () => {
  const { s, lines } = collect();
  s.push(Buffer.from('{"a":1}\n{"b":2}\n{"c":3}\n'));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("splitter: CRLF and blank lines do not become messages", () => {
  const { s, lines } = collect();
  s.push(Buffer.from('{"a":1}\r\n\n\r\n{"b":2}\n'));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("splitter: multibyte characters survive a split mid-codepoint", () => {
  const { s, lines } = collect();
  const msg = Buffer.from(JSON.stringify({ text: "héllo — ✅" }) + "\n");
  // cut inside the em-dash's UTF-8 bytes
  const cut = msg.indexOf(0xe2) + 1;
  s.push(msg.subarray(0, cut));
  s.push(msg.subarray(cut));
  assert.deepEqual(JSON.parse(lines[0]!), { text: "héllo — ✅" });
});

test("splitter: an over-long line is dropped and the stream resyncs at the next newline", () => {
  const { s, lines, overflows } = collect(64);
  s.push(Buffer.from("x".repeat(200)));
  s.push(Buffer.from('runaway\n{"after":true}\n'));
  assert.equal(overflows.length, 1);
  assert.ok(overflows[0]! > 64);
  assert.deepEqual(lines, ['{"after":true}'], "the tail of the dropped line must not be delivered as a message");
});

test("splitter: pending bytes are held, never delivered", () => {
  const { s, lines } = collect();
  s.push(Buffer.from('{"partial":'));
  assert.deepEqual(lines, []);
  assert.equal(s.pending, 11);
});

test("classify: junk sharing stdout is not a message; a JSON object is", () => {
  assert.equal(classify("Update available: v2").ok, false);
  assert.equal(classify("[1,2,3]").ok, false, "an array is not an ACP message envelope");
  assert.equal(classify("null").ok, false);
  assert.equal(classify('{"jsonrpc":"2.0","method":"session/update"}').ok, true);
});

test("toAgentLine: one message in, one line out (with the newline the pipe needs)", () => {
  const r = toAgentLine(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"initialize"}'));
  assert.ok(r.ok);
  assert.equal(r.line, '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
});

test("toAgentLine: refuses two messages in one frame (no smuggling a second)", () => {
  const r = toAgentLine(new TextEncoder().encode('{"a":1}\n{"b":2}'));
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /more than one line/);
});

test("toAgentLine: refuses non-JSON and invalid UTF-8", () => {
  assert.equal(toAgentLine(new TextEncoder().encode("hello")).ok, false);
  assert.equal(toAgentLine(new Uint8Array([0xff, 0xfe, 0x00])).ok, false);
});

test("MAX_LINE_BYTES stays clear of the ack window (#10: no backpressure hook)", () => {
  assert.ok(MAX_LINE_BYTES <= 4 << 20);
});
