// The rules a returning page follows (resume.ts, #113/D32), tested in Node
// because they are the parts that decide whether a refresh is honest: where
// the human's turns go back in, which permission cards are still owed an
// answer, and whose JSON-RPC ids are whose.
import test from "node:test";
import assert from "node:assert/strict";
import { ID_SPACE, firstIdForEpoch, parseRecord, permissionVerdict, promptsBefore, type StickyPrompt, type StickyRecord } from "./resume.js";

// ---------------------------------------------------------------- the weave
//
// The page walks the replayed frames in order, calling promptsBefore() with
// the frame it is about to render. This helper does that whole walk, so the
// tests read as "where did each turn land".

function weave(prompts: StickyPrompt[], frameCount: number): string[] {
  const out: string[] = [];
  let cursor = 0;
  const flush = (next: number): void => {
    for (let i = cursor; i < next; i++) out.push(prompts[i]!.text);
    cursor = next;
  };
  for (let f = 0; f < frameCount; f++) {
    flush(promptsBefore(prompts, cursor, f));
    out.push(`frame ${f}`);
  }
  flush(promptsBefore(prompts, cursor, Number.POSITIVE_INFINITY));
  return out;
}

test("resume: a prompt goes back exactly where it was sent, not at the end", () => {
  // Two turns around three things the agent said: "hi" was typed before any
  // of them, "again" after the second.
  assert.deepEqual(weave([{ text: "hi", atFrame: 0 }, { text: "again", atFrame: 2 }], 3), [
    "hi",
    "frame 0",
    "frame 1",
    "again",
    "frame 2",
  ]);
});

test("resume: turns taken after the agent's last word land at the end", () => {
  assert.deepEqual(weave([{ text: "hello?", atFrame: 4 }], 2), ["frame 0", "frame 1", "hello?"]);
});

test("resume: two prompts at the same anchor keep the order they were typed", () => {
  assert.deepEqual(weave([{ text: "first", atFrame: 1 }, { text: "second", atFrame: 1 }], 2), [
    "frame 0",
    "first",
    "second",
    "frame 1",
  ]);
});

test("resume: an anchor past the replayed stream still shows up (#57 rotation)", () => {
  // After a rotation the replay is a suffix, so anchors recorded against the
  // longer stream overshoot. They land at the end — misplaced, not lost.
  assert.deepEqual(weave([{ text: "old", atFrame: 900 }], 1), ["frame 0", "old"]);
});

test("resume: nothing replayed at all still puts the human's turns back", () => {
  assert.deepEqual(weave([{ text: "only turn", atFrame: 0 }], 0), ["only turn"]);
});

test("resume: the cursor only ever moves forward", () => {
  const prompts = [{ text: "a", atFrame: 0 }, { text: "b", atFrame: 5 }];
  assert.equal(promptsBefore(prompts, 1, 0), 1, "an already-emitted turn is not emitted twice");
  assert.equal(promptsBefore(prompts, 2, 99), 2, "an exhausted list stays exhausted");
});

// -------------------------------------------------------- permission cards

test("resume: a card answered before the refresh replays as a verdict, not a question", () => {
  const answers = { "7": "allow-once", "9": null };
  assert.deepEqual(permissionVerdict(answers, 7), { state: "settled", option: "allow-once" });
  // A cancel is an answer too — the agent got it and moved on.
  assert.deepEqual(permissionVerdict(answers, 9), { state: "settled", option: null });
});

test("resume: a card the page never answered comes back open — the agent is still blocked on it", () => {
  assert.deepEqual(permissionVerdict({ "7": "allow-once" }, 8), { state: "open" });
  // String and number ids name the same request (JSON-RPC allows either).
  assert.deepEqual(permissionVerdict({ "7": "allow-once" }, "7"), { state: "settled", option: "allow-once" });
  // No id at all: nothing can be answered, so nothing may be claimed settled.
  assert.deepEqual(permissionVerdict({}, undefined), { state: "open" });
});

test("resume: an inherited `answers` key cannot forge a verdict", () => {
  // The record is JSON from IndexedDB; "constructor" is a key an object
  // carries whether anyone wrote it or not.
  assert.deepEqual(permissionVerdict({}, "constructor"), { state: "open" });
});

// ------------------------------------------------------------- the id space

test("resume: each writer epoch gets its own id range, so a late answer can't be mistaken", () => {
  assert.equal(firstIdForEpoch(0), 1);
  assert.equal(firstIdForEpoch(1), ID_SPACE + 1);
  // The claim that matters: an id from epoch 1 is never one epoch 2 will
  // issue, so a `session/prompt` response that arrives after the refresh is
  // recognizably the old page's.
  assert.ok(firstIdForEpoch(2) > firstIdForEpoch(1) + ID_SPACE - 1);
});

// ---------------------------------------------------------------- the record

const FULL: StickyRecord = {
  sessionId: "s-abc-123",
  acpSessionId: "sess_1",
  agent: "fake",
  agentName: "Fixture",
  agentVersion: "0.1.0",
  cwd: "/Users/x/project",
  gen: 0,
  prompts: [{ text: "hi", atFrame: 0 }],
  queued: ["and then this"],
  answers: { "3": "allow" },
  pendingPromptId: 42,
};

test("resume: a full record round-trips through JSON", () => {
  assert.deepEqual(parseRecord(JSON.parse(JSON.stringify(FULL))), FULL);
});

test("resume: a record missing what a reattach needs is no record at all", () => {
  // Without these three the page cannot attach, cannot address the
  // conversation, and cannot judge an fs/* path — so the wizard, which is
  // always correct, is the answer.
  for (const k of ["sessionId", "acpSessionId", "cwd"] as const) {
    const partial = { ...FULL, [k]: "" };
    assert.equal(parseRecord(partial), null, `${k} is load-bearing`);
  }
  assert.equal(parseRecord(null), null);
  assert.equal(parseRecord("s-abc"), null);
});

test("resume: junk inside a record is dropped, and the rest survives", () => {
  const r = parseRecord({
    ...FULL,
    prompts: [{ text: "kept", atFrame: 1 }, { text: "no anchor" }, "not an object", null],
    queued: ["kept", 7, null],
    answers: { "3": "allow", "4": 7, "5": null },
    pendingPromptId: "not a number",
  });
  assert.deepEqual(r?.prompts, [{ text: "kept", atFrame: 1 }]);
  assert.deepEqual(r?.queued, ["kept"]);
  assert.deepEqual(r?.answers, { "3": "allow", "5": null });
  assert.equal(r?.pendingPromptId, null);
});
