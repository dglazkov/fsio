// The helper's URL hints (#124).
//
// The property under test is the one the design rests on: **a hint is never
// load-bearing.** Every test here is either "a malformed hint becomes
// nothing" or "the bare URL is a supported way to arrive" — because the
// moment a param can put the page somewhere the bare URL cannot reach, the
// helper has opened a side channel (P2) rather than saved a gesture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PAGE, launchUrl, noHelperHint, NO_LAUNCH, parseLaunch } from "./launch.js";

test("a bare URL is a launch with nothing in it — arriving by hand is supported", () => {
  assert.deepEqual(parseLaunch(""), NO_LAUNCH);
  assert.deepEqual(parseLaunch("?"), NO_LAUNCH);
  // The hash belongs to tabs.ts (#120) and must not leak in here.
  assert.deepEqual(parseLaunch("?#s=s-abc,s-def&a=s-abc"), NO_LAUNCH);
});

test("the round trip the helper and the page actually make", () => {
  const url = launchUrl(DEFAULT_PAGE, { dir: "myproject", agent: "claude-agent-acp" });
  assert.equal(url, "https://agent-demo.pewter.town/?dir=myproject&agent=claude-agent-acp");
  assert.deepEqual(parseLaunch(new URL(url).search), { dir: "myproject", agent: "claude-agent-acp" });
});

test("a dev server's port and path survive, and so do awkward folder names", () => {
  const url = launchUrl("http://localhost:5173/", { dir: "my project & co", agent: null });
  const u = new URL(url);
  assert.equal(u.port, "5173");
  assert.equal(parseLaunch(u.search).dir, "my project & co", "the picker's own .name is what this is compared against");
  assert.equal(parseLaunch(u.search).agent, null);
});

test("a malformed hint is nothing, never an error and never a panel", () => {
  // Long enough to stop being a button label.
  assert.equal(parseLaunch(`?dir=${"x".repeat(65)}`).dir, null);
  assert.equal(parseLaunch("?dir=").dir, null);
  // Separators: this is a basename for display, and a page that rendered a
  // path here would be showing the helper's filesystem to whoever loaded it.
  assert.equal(parseLaunch("?dir=%2FUsers%2Fdg%2Fsecret").dir, null);
  assert.equal(parseLaunch("?dir=a%5Cb").dir, null);
  assert.equal(parseLaunch("?dir=a%00b").dir, null, "control characters are not folder names anyone should see");
  assert.equal(parseLaunch("?dir=a%0Ab").dir, null);
  // The agent name goes back to the helper on a spawn, where the allow-list
  // judges it again — this is only the cheap refusal that keeps a
  // path-shaped string from ever being rendered as one.
  assert.equal(parseLaunch("?agent=..%2F..%2Fbin%2Fsh").agent, null);
  assert.equal(parseLaunch("?agent=-rf").agent, null, "a name starts with a letter or a digit, never a flag");
});

test("the helper does not send a hint the page would drop", () => {
  // Both ends share one shape check, so a folder the page cannot render is a
  // folder the helper leaves out of the URL entirely — the alternative is a
  // link that silently loses a param between the two.
  const url = launchUrl(DEFAULT_PAGE, { dir: "a/b", agent: "not a name" });
  assert.equal(url, DEFAULT_PAGE, "nothing sendable, so nothing sent");
  assert.deepEqual(parseLaunch(new URL(url).search), NO_LAUNCH);
});

// The dead end the folder hint exists to kill. #124's headline win, so it is
// verified here rather than trusted: before this, picking the wrong directory
// produced a page that waited forever and looked exactly like "the helper was
// never started" — no message, no way out, one mis-navigation away.
test("a mispick names both folders instead of hanging silently", () => {
  const h = noHelperHint("Documents", "myproject");
  assert.match(h, /You picked Documents\//);
  assert.match(h, /running in myproject\//, "the whole point: say which folder it should have been");
});

test("with no hint, or the right folder, it is the generic message and never accuses", () => {
  // A page opened by hand has no hint, and must not imply a mismatch it
  // cannot see. Same for the folder that matches: the helper simply is not
  // running any more, which is a different problem with a different fix.
  for (const h of [noHelperHint("myproject", null), noHelperHint("myproject", "myproject")]) {
    assert.match(h, /Is the helper still running/);
    assert.doesNotMatch(h, /You picked/, "nothing to compare means nothing to accuse");
  }
});

test("every branch says what was and was not written to the folder", () => {
  // The sentence people actually need after clicking Allow twice on a folder
  // that turned out to be wrong: we did not put anything in it.
  for (const h of [noHelperHint("a", "b"), noHelperHint("a", null), noHelperHint("a", "a")]) {
    assert.match(h, /Nothing was written to the folder you just picked/);
  }
});

test("an unknown param is ignored rather than inherited", () => {
  // Guards the rule from the other side: someone adding `?sandbox=1` to a
  // shared link must not be able to make the page say anything about
  // confinement. Safety facts are read from the spawn result, never here.
  const l = parseLaunch("?dir=myproject&sandbox=1&trusted=yes");
  assert.deepEqual(l, { dir: "myproject", agent: null });
});
