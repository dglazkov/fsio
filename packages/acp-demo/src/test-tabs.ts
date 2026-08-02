// The open set (#120): the URL that carries N conversations, and the two
// sources that can disagree about which ones are open.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EMPTY, formatHash, normalizeOpen, parseHash, parseOpenSet, wantedOpen } from "./tabs.js";

const A = "s-abc123-def";
const B = "s-abc124-xyz";

test("normalizeOpen dedupes and keeps tab order", () => {
  assert.deepEqual(normalizeOpen([A, B, A], B), { ids: [A, B], active: B });
});

test("normalizeOpen pulls a stray active back into the set", () => {
  // A tab closed underneath a stale pointer: the page must land on a tab
  // that exists rather than rendering nothing with N conversations open.
  assert.deepEqual(normalizeOpen([A, B], "s-gone-1"), { ids: [A, B], active: A });
  assert.deepEqual(normalizeOpen([], A), EMPTY);
});

test("normalizeOpen refuses ids that are not id-shaped", () => {
  // Everything here reaches attachSession() and a directory lookup, and the
  // URL is the one input to this page a stranger writes.
  for (const bad of ["../etc", "a/b", "", "  ", "x".repeat(200), 7, null, {}]) {
    assert.deepEqual(normalizeOpen([bad], null), EMPTY, `accepted ${JSON.stringify(bad)}`);
  }
});

test("the hash round-trips", () => {
  const open = { ids: [A, B], active: B };
  assert.equal(formatHash(open), `#s=${A},${B}&a=${B}`);
  assert.deepEqual(parseHash(formatHash(open)), open);
});

test("an empty set formats to nothing, so the page drops the fragment", () => {
  assert.equal(formatHash(EMPTY), "");
  assert.equal(formatHash({ ids: [], active: A }), "");
});

test("a mangled hash reads as no instruction, never as an error", () => {
  assert.deepEqual(parseHash(""), EMPTY);
  assert.deepEqual(parseHash("#"), EMPTY);
  assert.deepEqual(parseHash("#s=&a="), EMPTY);
  assert.deepEqual(parseHash("#s=,,,"), EMPTY);
  assert.deepEqual(parseHash("#nonsense"), EMPTY);
  // A shared link with no active pointer still names its conversations.
  assert.deepEqual(parseHash(`#s=${A},${B}`), { ids: [A, B], active: A });
});

test("a stored set is read as defensively as a URL", () => {
  assert.deepEqual(parseOpenSet(null), EMPTY);
  assert.deepEqual(parseOpenSet("session"), EMPTY);
  assert.deepEqual(parseOpenSet({ ids: A, active: A }), EMPTY);
  assert.deepEqual(parseOpenSet({ ids: [A, 3, A, B], active: B }), { ids: [A, B], active: B });
});

test("a URL that names anything wins over what this browser remembers", () => {
  const url = { ids: [A], active: A };
  const store = { ids: [A, B], active: B };
  // Sharing one of three tabs means one tab, not three.
  assert.deepEqual(wantedOpen(url, store), url);
  assert.deepEqual(wantedOpen(EMPTY, store), store);
  assert.deepEqual(wantedOpen(EMPTY, EMPTY), EMPTY);
});
