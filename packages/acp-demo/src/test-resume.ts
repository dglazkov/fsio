// The rules a returning page follows (resume.ts, #113/D32), tested in Node
// because they are the parts that decide whether a refresh is honest: where
// the human's turns go back in, which permission cards are still owed an
// answer, and whose JSON-RPC ids are whose.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ID_SPACE,
  KEEP_PAST,
  anchorsAlign,
  demote,
  firstIdForEpoch,
  parsePast,
  parseRecord,
  permissionVerdict,
  promptsBefore,
  prunablePast,
  type StickyPrompt,
  type StickyRecord,
} from "./resume.js";

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
  folder: "project",
  gen: 0,
  prompts: [{ text: "hi", atFrame: 0 }],
  queued: ["and then this"],
  answers: { "3": "allow" },
  pendingPromptId: 42,
  adopted: false,
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

// ------------------------------------------------- what outlives the session
//
// #123. The session ends, the record stops being state — and the human's
// half of the conversation becomes the only copy there has ever been of it,
// at exactly the moment someone might want to read it back.

test("past: demotion keeps the half the folder never had, and nothing that named the session", () => {
  const p = demote(FULL);
  assert.deepEqual(p, {
    sessionId: "s-abc-123",
    folder: "project",
    agentName: "Fixture",
    gen: 0,
    prompts: [{ text: "hi", atFrame: 0 }],
    answers: { "3": "allow" },
    adopted: false,
  });
  // Nothing attachable survives: no fsio session id to attach to beyond the
  // transcript's own name, no ACP session id, no cwd to judge a path
  // against, no turn in flight. A document cannot be mistaken for a session.
  for (const k of ["acpSessionId", "cwd", "pendingPromptId", "queued"]) {
    assert.equal(k in p, false, `${k} would name something that is gone`);
  }
  // A copy, not a view: editing the live record afterwards must not rewrite
  // history (the page holds the record in memory and writes through it).
  FULL.prompts.push({ text: "later", atFrame: 9 });
  assert.equal(p.prompts.length, 1);
  FULL.prompts.pop();
});

test("past: a demoted record round-trips, and one with nothing in it is not a record", () => {
  const p = demote(FULL);
  assert.deepEqual(parsePast(JSON.parse(JSON.stringify(p))), p);
  // Neither turns nor answers: it annotates nothing, and claiming a human
  // half exists would make the reader's banner lie about what they are
  // looking at.
  assert.equal(parsePast({ sessionId: "s-1", folder: "demo", prompts: [], answers: {} }), null);
  assert.equal(parsePast({ prompts: [{ text: "orphan", atFrame: 0 }] }), null, "no session id, nothing to join to");
  assert.equal(parsePast(null), null);
  // Answers alone are worth keeping: a conversation can be one long turn
  // with a permission card in the middle of it.
  assert.deepEqual(parsePast({ sessionId: "s-1", answers: { "3": null } })?.answers, { "3": null });
});

test("adopted: a conversation joined in progress says so, and keeps saying it (#117)", () => {
  // The picker rebuilds a record for a session it never started, so this
  // half begins where the page did rather than where the conversation did.
  // That fact outlives the session: a refresh writes a new record from the
  // old one, and a demotion turns it into a document someone reads later —
  // both would otherwise present a beginning-less transcript as a whole one.
  const joined: StickyRecord = { ...FULL, adopted: true };
  assert.equal(parseRecord(JSON.parse(JSON.stringify(joined)))?.adopted, true);
  assert.equal(demote(joined).adopted, true);
  assert.equal(parsePast(JSON.parse(JSON.stringify(demote(joined))))?.adopted, true);
  // The default is the one that cannot mislead: every record written before
  // #117 belonged to the page that started the conversation.
  const { adopted: _dropped, ...legacy } = joined;
  assert.equal(parseRecord(legacy)?.adopted, false);
  assert.equal(parsePast({ sessionId: "s-1", answers: { "3": null } })?.adopted, false);
});

test("past: anchors are only trustworthy against the generation they were counted in", () => {
  // Both counting from the same segment: the turns land where they were typed.
  assert.equal(anchorsAlign({ gen: 0 }, 0), true);
  // The folder kept a tail that starts later than the page was counting
  // from. The turns are all still shown — losing them is the one outcome
  // worse than misplacing them — but the view says so (#57, D32's ceiling).
  assert.equal(anchorsAlign({ gen: 0 }, 3), false);
  assert.equal(anchorsAlign({ gen: 3 }, 0), false);
});

// ------------------------------------------------------------ the bound
//
// The folder is the authority: a browser-side half cannot outlive the
// transcript it annotates. What makes that decidable is that the folder
// archives in end-order, so a *newer* transcript is proof the older one had
// its chance.

const inFolder = (...ids: string[]): { id: string; folder: string }[] => ids.map((id) => ({ id, folder: "demo" }));

test("past: a record the folder has moved past is dropped", () => {
  // s-2 is absent from a folder that kept s-3, which ended later: s-2 either
  // never got archived or has rotated out of the folder's N.
  assert.deepEqual(prunablePast(inFolder("s-3", "s-2", "s-1"), ["s-3"], "demo"), ["s-2", "s-1"]);
  assert.deepEqual(prunablePast(inFolder("s-2"), ["s-2"], "demo"), [], "the transcript is right there");
});

test("past: a record the folder has not caught up with yet survives", () => {
  // The archive happens when the host sweeps the session, which lags the
  // end of it. Between those two moments the newest record is absent from
  // the folder and must NOT be read as stale — that window is exactly when
  // someone reloads the page.
  assert.deepEqual(prunablePast(inFolder("s-9"), ["s-3", "s-1"], "demo"), [], "nothing newer was kept, so nothing has been outlived");
  assert.deepEqual(prunablePast(inFolder("s-9", "s-2"), ["s-3"], "demo"), ["s-2"], "the lagging one waits; the outlived one goes");
});

test("past: a folder that keeps no transcripts prunes nothing", () => {
  // Transcripts are off by default (D26 rule 4). With nothing kept there is
  // no verdict to read, so the count bound is the only one that applies —
  // and the day the folder does keep one, everything older than it goes.
  assert.deepEqual(prunablePast(inFolder("s-2", "s-1"), [], "demo"), []);
  assert.ok(KEEP_PAST > 0);
});

test("past: one folder does not get to answer for another", () => {
  // Two folders, one origin. Opening `other` lists only its own
  // transcripts, and reading that absence as a verdict on `demo`'s records
  // would delete the human's turns for every conversation that happened
  // somewhere else.
  const index = [
    { id: "s-2", folder: "demo" },
    { id: "s-1", folder: "other" },
  ];
  assert.deepEqual(prunablePast(index, ["s-3"], "other"), ["s-1"]);
  assert.deepEqual(prunablePast(index, ["s-3"], "demo"), ["s-2"]);
  // A record from before folders were tagged belongs to nobody, so nobody
  // may prune it; the count bound is what eventually retires it.
  assert.deepEqual(prunablePast([{ id: "s-0", folder: "" }], ["s-3"], "demo"), []);
});

test("past: junk inside a demoted record is dropped, and the rest survives", () => {
  // Same defensive read as the live record's, and it matters more here: this
  // one has been sitting in IndexedDB since the session ended rather than
  // since the last refresh.
  const p = parsePast({
    sessionId: "s-abc-123",
    agentName: 7,
    gen: "later",
    prompts: [{ text: "kept", atFrame: 1 }, { text: "no anchor" }, "not an object", null],
    answers: { "3": "allow", "4": 7, "5": null },
  });
  assert.deepEqual(p?.prompts, [{ text: "kept", atFrame: 1 }]);
  assert.deepEqual(p?.answers, { "3": "allow", "5": null });
  assert.equal(p?.agentName, "agent");
  assert.equal(p?.gen, 0);
});
