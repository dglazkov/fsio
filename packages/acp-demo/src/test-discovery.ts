// What the folder can say about a running conversation nobody has a record
// of (discovery.ts, #117). These are the reads that decide whether the
// picker is a recovery path or a list of hashes: the ACP session id (without
// it a rejoined page can watch but never speak — #115 dug this out of the
// same file by hand), the line to choose by, and the birthday encoded in the
// session id.
import test from "node:test";
import assert from "node:assert/strict";
import { FrameType, encodeFrame, jsonFrame } from "@fsio/common";
import { adoptableIds, peekConversation, startedAt, type SessionRow } from "./discovery.js";

// ---------------------------------------------------------------- fixtures

const frame = (msg: unknown): Uint8Array => jsonFrame(FrameType.DATA, msg);
const update = (sessionId: string, update: unknown): Uint8Array => frame({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
const say = (sessionId: string, text: string): Uint8Array => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ------------------------------------------------------------ the ACP id

test("discovery: the conversation id comes back from a session/update", () => {
  // The case that matters most: a long conversation whose handshake has
  // rotated out of the retained stream. Every update carries the id, so the
  // folder can still answer.
  const seg = concat([say("sess-abc", "hello"), say("sess-abc", " there")]);
  assert.equal(peekConversation([seg]).acpSessionId, "sess-abc");
});

test("discovery: the conversation id also comes back from session/new's reply", () => {
  // A session that has done nothing but hand shake: no updates at all, but
  // the two responses are still there in generation 0.
  const seg = concat([
    frame({ jsonrpc: "2.0", id: 1, result: { agentInfo: { name: "pi-acp", version: "0.4.2" } } }),
    frame({ jsonrpc: "2.0", id: 2, result: { sessionId: "sess-fresh" } }),
  ]);
  const peek = peekConversation([seg]);
  assert.equal(peek.acpSessionId, "sess-fresh");
  assert.equal(peek.agentName, "pi-acp");
  assert.equal(peek.agentVersion, "0.4.2");
});

test("discovery: a stream that names no conversation is seen but not rejoinable", () => {
  // Not an error — a caller renders the row and disables the button. The
  // honest failure is "this page cannot rejoin it", never a rejoin that
  // cannot then send a prompt.
  const peek = peekConversation([concat([frame({ jsonrpc: "2.0", method: "something/else", params: {} })])]);
  assert.equal(peek.acpSessionId, null);
  assert.equal(peek.frames, 1);
});

// ------------------------------------------------------------ the last line

test("discovery: the last line is the tail of what the agent was saying", () => {
  const seg = concat([say("s", "thinking about it\n"), say("s", "here is the plan:\nstep one")]);
  assert.equal(peekConversation([seg]).lastLine, "step one");
});

test("discovery: segments are read oldest-first, so a message split across a rotation is one message", () => {
  // Rotation is a file boundary, not a conversational one (D26): the agent
  // was mid-sentence when the host started a new segment.
  assert.equal(peekConversation([concat([say("s", "still ")]), concat([say("s", "typing")])]).lastLine, "still typing");
  // And when there is a line between them, the newest line is the one shown.
  assert.equal(peekConversation([concat([say("s", "old news\n")]), concat([say("s", "fresh news")])]).lastLine, "fresh news");
});

test("discovery: a tool call ends the run and becomes the line when nothing followed it", () => {
  // Mirrors what the chat itself renders: a tool call breaks the streaming
  // message, so the last thing on screen is the tool call, not the sentence
  // before it.
  const seg = concat([say("s", "let me look"), update("s", { sessionUpdate: "tool_call", toolCallId: "t1", title: "read src/main.ts" })]);
  assert.equal(peekConversation([seg]).lastLine, "read src/main.ts");
});

test("discovery: a line is a glance — long output is truncated", () => {
  const long = "x".repeat(400);
  const line = peekConversation([concat([say("s", long)])]).lastLine;
  assert.ok(line.length <= 160, `line was ${line.length} chars`);
  assert.ok(line.endsWith("…"));
});

test("discovery: whitespace-only output leaves the line empty rather than blank-looking", () => {
  assert.equal(peekConversation([concat([say("s", "   \n\n  ")])]).lastLine, "");
});

// -------------------------------------------------- reading like a stranger

test("discovery: junk in the stream is skipped, not fatal", () => {
  // Everything here rode a file in the granted folder, which a co-tenant can
  // write (D20). A payload that is not JSON, and a frame type that is not
  // DATA, must not stop the scan finding the frame that matters.
  const seg = concat([
    encodeFrame(FrameType.DATA, new TextEncoder().encode("not json at all")),
    encodeFrame(FrameType.RPC, new TextEncoder().encode(JSON.stringify({ method: "ignored" }))),
    say("sess-ok", "still here"),
  ]);
  const peek = peekConversation([seg]);
  assert.equal(peek.acpSessionId, "sess-ok");
  assert.equal(peek.lastLine, "still here");
});

test("discovery: a half-written trailing frame is ignored, and what preceded it stands", () => {
  // The host is appending while this reads (invariant 3, F11).
  const whole = concat([say("sess-ok", "complete")]);
  const torn = concat([whole, say("sess-ok", "never finished").slice(0, 7)]);
  assert.equal(peekConversation([torn]).lastLine, "complete");
});

test("discovery: nothing to read is a peek with nothing in it, not a throw", () => {
  assert.deepEqual(peekConversation([]), { acpSessionId: null, agentName: "", agentVersion: "", lastLine: "", frames: 0 });
});

// ------------------------------------------------------------- the birthday

test("discovery: a session id carries the time it was minted", () => {
  const t = 1_754_000_000_000;
  assert.equal(startedAt(`s-${t.toString(36)}-ab12cd`), t);
});

test("discovery: a directory name this library did not mint has no birthday", () => {
  // The sessions directory is in the folder the human granted; a name in it
  // is a claim, not a fact.
  assert.equal(startedAt("s-notbase36!-x"), null);
  assert.equal(startedAt("s-1-x"), null); // decodes to 1970, which is a coincidence
  assert.equal(startedAt("whatever"), null);
});

// The age's wording — "started 28 minutes ago" — moved to @fsio/ui with
// `sinceLabel`, and its assertions went along: packages/ui/src/test-text.ts.

// ---------------------------------------------------------------- the filter

test("discovery: only running ACP sessions this page is not already holding", () => {
  const rows: SessionRow[] = [
    { id: "s-a-1", kind: "acp", status: { state: "running" } },
    { id: "s-b-2", kind: "shell", status: { state: "running" } }, // the terminal demo's, in the same folder
    { id: "s-c-3", kind: "acp", status: { state: "exited" } },
    { id: "s-d-4", kind: "acp", status: null }, // mid-creation
    { id: "s-e-5", kind: "acp", status: { state: "running" } },
  ];
  assert.deepEqual(adoptableIds(rows, new Set(["s-e-5"])), ["s-a-1"]);
});

test("discovery: newest first, because ids sort by when the session started", () => {
  const at = (ms: number, tag: string): SessionRow => ({ id: `s-${ms.toString(36)}-${tag}`, kind: "acp", status: { state: "running" } });
  const rows = [at(1_754_000_000_000, "old"), at(1_754_000_900_000, "new"), at(1_754_000_500_000, "mid")];
  assert.deepEqual(
    adoptableIds(rows, new Set()).map((id) => id.split("-")[2]),
    ["new", "mid", "old"]
  );
});
