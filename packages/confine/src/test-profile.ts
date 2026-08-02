// The emitted text: escaping, refusal, ordering, and the shape of a hole.
// No sandbox-exec here — test-posture.ts runs the wall for real. These run
// everywhere, including CI's ubuntu leg.
import test from "node:test";
import assert from "node:assert/strict";
import { sandboxProfile, profileSummary } from "./index.js";

const base = { subject: "test subject.", posture: "test posture." };

test("profile: the skeleton's order is the policy (SBPL is last-match-wins)", () => {
  const text = sandboxProfile(base);
  const at = (needle: string): number => {
    const i = text.indexOf(needle);
    assert.notEqual(i, -1, `missing: ${needle}`);
    return i;
  };
  // Each of these is load-bearing in one direction: the clampdown must come
  // after `allow default` or it never applies, the re-allows after the
  // clampdown or they are erased, and the .fsio deny last or ROOT's allow
  // wins and the transport is writable by its own payload (D6).
  assert.ok(at("(allow default)") < at("(deny file-write*)\n"), "the wall comes after the broad allow");
  assert.ok(at("(deny file-write*)\n") < at('(param "ROOT")'), "ROOT is re-allowed after the wall");
  assert.ok(at('(param "ROOT")') < at('(deny file-write* (subpath (param "FSIO")))'), ".fsio's deny must be the final word");
});

test("profile: a carve cannot reach past the final .fsio deny", () => {
  // Not a caller-facing option: whatever a caller passes, the protocol area
  // is denied after it. This is the one thing the skeleton refuses to
  // negotiate, so it gets a test rather than a comment.
  const text = sandboxProfile({ ...base, carves: [{ why: "trying", dirs: ["/anything"] }] });
  assert.ok(text.indexOf('(subpath "/anything")') < text.indexOf('(subpath (param "FSIO"))'));
  assert.ok(text.trimEnd().endsWith('(deny file-write* (subpath (param "FSIO")))'));
});

test("profile: subject and posture reach the file as comments a human reads", () => {
  const text = sandboxProfile({ subject: "who this confines.", posture: "line one\nline two" });
  assert.match(text, /^\(version 1\)\n\n;; who this confines\./);
  assert.match(text, /;; line one\n;; line two/);
});

test("profile: no carves means no path rules at all", () => {
  const text = sandboxProfile(base);
  assert.ok(!text.includes('(allow file-write* (subpath "'), "nothing but the params should be writable");
  assert.ok(!text.includes("(regex"), "and no patterns either");
});

test("profile: a carve with a reason and no rules is a comment — how you say 'and nothing else'", () => {
  const text = sandboxProfile({ ...base, carves: [{ why: "...and nothing else: this child's state is placed by env." }] });
  assert.match(text, /;; \.\.\.and nothing else: this child's state is placed by env\./);
  assert.ok(!text.includes('(allow file-write* (subpath "'));
});

test("profile: every carve's reason sits directly above its rules", () => {
  // The claim the file makes to whoever opens it: no hole without an account
  // of it. `why` being required is the type-level half; this is the other.
  const text = sandboxProfile({
    ...base,
    carves: [
      { why: "the first reason", dirs: ["/one"] },
      { why: "the second reason", dirs: ["/two"], patterns: ["^/two-[0-9]+$"] },
    ],
  });
  assert.match(text, /;; the first reason\n\(allow file-write\* \(subpath "\/one"\)\)/);
  assert.match(text, /;; the second reason\n\(allow file-write\* \(subpath "\/two"\)\)\n\(allow file-write\* \(regex #"\^\/two-\[0-9\]\+\$"\)\)/);
});

test("profile: embedded paths are escaped (a path with a quote is not an injection)", () => {
  const text = sandboxProfile({ ...base, carves: [{ why: "w", dirs: ['/tmp/we"ird\\dir'] }] });
  assert.match(text, /\(subpath "\/tmp\/we\\"ird\\\\dir"\)/);
});

test("profile: a pattern carrying a quote or backslash is refused, not escaped", () => {
  // A path that lost a character to escaping fails closed — it matches
  // nothing. A regex that lost one can match MORE than it was meant to, so
  // there is no safe mangling and the only answer is to stop.
  assert.throws(() => sandboxProfile({ ...base, carves: [{ why: "w", patterns: ['^/private/tmp/a"b$'] }] }), /refusing a pattern/);
  assert.throws(() => sandboxProfile({ ...base, carves: [{ why: "w", patterns: ["^/private/tmp/a\\\\b$"] }] }), /refusing a pattern/);
});

test("summary: names the holes and says what the wall does not bound", () => {
  const s = profileSummary("my-project", ["/Users/x/.claude", "/private/tmp/claude-501/-Users-x-proj"]);
  assert.match(s, /writes: my-project\/ \(not \.fsio\)/);
  assert.match(s, /\/Users\/x\/\.claude/);
  assert.match(s, /\/private\/tmp\/claude-501\/-Users-x-proj/, "a hole outside the folder is spelled out, never summarised");
  assert.match(s, /reads: everything you can read/);
  assert.match(s, /network: on/);
});

test("summary: with no extra holes it still says reads and network are open", () => {
  const s = profileSummary("proj");
  assert.match(s, /writes: proj\/ \(not \.fsio\), a scratch dir — nothing else\./);
  assert.match(s, /reads: everything you can read\. network: on\./);
});
