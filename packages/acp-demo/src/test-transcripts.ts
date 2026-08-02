// Reading an ended session's paperwork (transcripts.ts, #119/D26 rule 4).
//
// These are D20's posture as tests: a transcript is a file any co-tenant of
// the granted folder can write, with none of live replay's provenance, so
// the interesting cases are the malformed ones — and the rule they all
// check is that a bad file costs a row, never a lie.
import test from "node:test";
import assert from "node:assert/strict";
import { isTail, newestFirst, parseTranscript, segmentsOf, type PastConversation } from "./transcripts.js";

const META = { id: "s-1", kind: "acp", ended: 1_700_000_000_000, why: "closed", exitCode: null, gen: 0, total: 4096, bytes: 4096 };
const SPAWN = { jsonrpc: "2.0", id: 0, method: "spawn", params: { kind: "acp", agent: "pi-acp", client: "acp-demo" } };

test("a well-formed transcript reads back whole", () => {
  const p = parseTranscript("s-1", META, SPAWN, ["out.00000000.log", "meta.json", "spawn.json"]);
  assert.equal(p?.agent, "pi-acp", "the agent's name comes from the spawn request the page itself sent");
  assert.equal(p?.kind, "acp");
  assert.equal(p?.why, "closed");
  assert.deepEqual(p?.logs, ["out.00000000.log"]);
  assert.equal(isTail(p!), false, "one segment from gen 0 with every byte kept is the whole conversation");
});

test("a legacy bare spawn spec still names its agent", () => {
  // listSessions() tolerates the pre-JSON-RPC shape; so does this, for the
  // same reason — a transcript outlives the page that wrote its spawn.json.
  const p = parseTranscript("s-1", META, { kind: "acp", agent: "claude-code-acp" }, ["out.00000000.log"]);
  assert.equal(p?.agent, "claude-code-acp");
});

test("no segment means no transcript — an empty row is worse than no row", () => {
  assert.equal(parseTranscript("s-1", META, SPAWN, ["meta.json", "spawn.json"]), null);
  assert.equal(parseTranscript("s-1", META, SPAWN, []), null);
  assert.equal(parseTranscript("", META, SPAWN, ["out.00000000.log"]), null);
});

test("only segment names are segments", () => {
  // The transcript directory sits in the human's own project folder. What
  // else is in there is not this code's business to guess at.
  assert.deepEqual(
    segmentsOf(["out.00000002.log", "out.00000001.log", "meta.json", "out.log", "out.0.log", "notes.txt", ".DS_Store"]),
    ["out.00000001.log", "out.00000002.log"],
    "sorted oldest first, and nothing that merely looks log-shaped"
  );
});

test("a missing or hostile meta.json costs the fields it should have carried, not the row", () => {
  // Missing entirely (an older transcript, or a mid-sweep read).
  const none = parseTranscript("s-1", null, null, ["out.00000000.log"]);
  assert.equal(none?.ended, 0);
  assert.equal(none?.agent, "");
  assert.deepEqual(none?.logs, ["out.00000000.log"]);
  // Present and wrong: every field the wrong type, plus a negative size.
  const junk = parseTranscript("s-1", { ended: "yesterday", why: { a: 1 }, gen: "0", total: -5, bytes: [] }, "not an object", ["out.00000000.log"]);
  assert.equal(junk?.ended, 0);
  assert.equal(junk?.why, "");
  assert.equal(junk?.gen, 0);
  assert.equal(junk?.total, 0);
  assert.equal(junk?.bytes, 0);
});

test("a rotated stream is named as a tail rather than shown as a beginning (#57)", () => {
  // Two independent tells, because either can be true alone: the oldest
  // kept segment is above gen 0, or fewer bytes survived than were written.
  assert.equal(isTail({ gen: 1, total: 0, bytes: 0 }), true);
  assert.equal(isTail({ gen: 0, total: 9_000_000, bytes: 900_000 }), true);
  assert.equal(isTail({ gen: 0, total: 4096, bytes: 4096 }), false);
  assert.equal(isTail({ gen: 0, total: 0, bytes: 4096 }), false, "a meta that never said `total` is not evidence of loss");
});

const row = (id: string, ended: number): PastConversation => ({ id, agent: "", kind: "acp", ended, why: "", gen: 0, total: 0, bytes: 0, logs: ["out.00000000.log"] });

test("newest first, with a stable order when the meta gave no time", () => {
  const sorted = newestFirst([row("s-a", 0), row("s-c", 300), row("s-b", 0), row("s-d", 100)]);
  assert.deepEqual(
    sorted.map((p) => p.id),
    ["s-c", "s-d", "s-b", "s-a"],
    "timed rows lead; undated ones fall back to the id, whose ts36 prefix is itself a clock"
  );
});
