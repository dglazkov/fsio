// The pure half of the library, which is the half a node test can reach.
// The components are covered by the two demos' type-checks and by the
// cooperative browser loop (TESTING.md); nothing here pretends otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ago, friendlyName, sinceLabel, sizeOf } from "./text.js";

test("friendlyName is stable and id-derived", () => {
  // The whole point: two pages, two browsers, no coordination, same word.
  assert.equal(friendlyName("s-ms6nbc5y-2jyn3j"), friendlyName("s-ms6nbc5y-2jyn3j"));
  assert.match(friendlyName("s-ms6nbc5y-2jyn3j"), /^[a-z]+-[a-z]+$/);
  assert.notEqual(friendlyName("s-aaa"), friendlyName("s-bbb"));
  assert.equal(friendlyName(""), friendlyName(""));
});

test("friendlyName spreads across the name space", () => {
  // 1024 names; 200 ids should not be piling into a handful of them.
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(friendlyName(`s-${i.toString(36)}-${(i * 7).toString(36)}`));
  assert.ok(seen.size > 150, `only ${seen.size} distinct names from 200 ids`);
});

test("sinceLabel", () => {
  const t = 1_700_000_000_000;
  assert.equal(sinceLabel(t, t + 10_000), "started just now");
  assert.equal(sinceLabel(t, t + 60_000), "started 1 minute ago");
  assert.equal(sinceLabel(t, t + 28 * 60_000), "started 28 minutes ago");
  assert.equal(sinceLabel(t, t + 3 * 3_600_000), "started 3 hours ago");
  assert.equal(sinceLabel(t, t + 4 * 86_400_000), "started 4 days ago");
  assert.equal(sinceLabel(null, t), "start time unknown");
  // A clock that went backwards reads as "just now", never as a negative age.
  assert.equal(sinceLabel(t, t - 60_000), "started just now");
});

test("ago", () => {
  assert.equal(ago(0), "0s");
  assert.equal(ago(12_000), "12s");
  assert.equal(ago(4 * 60_000), "4m");
  assert.equal(ago(3 * 3_600_000), "3h");
  assert.equal(ago(5 * 86_400_000), "5d");
  assert.equal(ago(-1000), "0s");
});

test("sizeOf", () => {
  assert.equal(sizeOf(0), "0 B");
  assert.equal(sizeOf(512), "512 B");
  assert.equal(sizeOf(2048), "2 KB");
  assert.equal(sizeOf(3 * 1048576), "3.0 MB");
});
