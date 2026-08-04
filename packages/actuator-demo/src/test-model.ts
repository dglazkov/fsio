// The application reducer. Pure, so these are the cheapest tests in the
// package and the ones that say what the demo actually does.
import test from "node:test";
import assert from "node:assert/strict";
import { apply, AppError, initialState, type AppState } from "./model.js";

let n = 0;
const ids = (): string => `tab-${++n}`;
const fresh = (): AppState => {
  n = 0;
  return initialState();
};

test("a fresh page holds one tab, and it is active", () => {
  const state = fresh();
  assert.equal(state.tabs.length, 1);
  assert.equal(state.activeId, state.tabs[0]!.id);
});

test("add appends and activates; --no-activate leaves the active tab alone", () => {
  const start = fresh();
  const added = apply(start, { method: "tabs.add", params: { title: "Build", message: "running" } }, ids);
  assert.equal(added.state.tabs.length, 2);
  assert.equal(added.state.activeId, "tab-1");
  assert.deepEqual(added.result, { id: "tab-1", title: "Build", active: true });

  const quiet = apply(
    added.state,
    { method: "tabs.add", params: { title: "Deploy", message: "queued", activate: false } },
    ids
  );
  assert.equal(quiet.state.activeId, "tab-1", "the active tab did not move");
  assert.equal(quiet.state.tabs.length, 3);
});

test("apply does not mutate the state it was given", () => {
  const start = fresh();
  const before = JSON.stringify(start);
  apply(start, { method: "tabs.add", params: { title: "x", message: "y" } }, ids);
  apply(start, { method: "tabs.update", params: { id: "welcome", title: "changed" } }, ids);
  assert.equal(JSON.stringify(start), before);
});

test("removing the active tab hands focus to what is left; the last one leaves none", () => {
  const start = apply(fresh(), { method: "tabs.add", params: { title: "Build", message: "running" } }, ids).state;
  const removed = apply(start, { method: "tabs.remove", params: { id: "tab-1" } }, ids);
  assert.equal(removed.state.activeId, "welcome");
  assert.deepEqual(
    removed.state.tabs.map((t) => t.id),
    ["welcome"]
  );

  const empty = apply(removed.state, { method: "tabs.remove", params: { id: "welcome" } }, ids);
  assert.deepEqual(empty.state.tabs, []);
  assert.equal(empty.state.activeId, null);
});

test("removing an inactive tab leaves the active one alone", () => {
  const start = apply(fresh(), { method: "tabs.add", params: { title: "Build", message: "x" } }, ids).state;
  const removed = apply(start, { method: "tabs.remove", params: { id: "welcome" } }, ids);
  assert.equal(removed.state.activeId, "tab-1");
});

test("update changes only the fields it was given", () => {
  const start = fresh();
  const updated = apply(start, { method: "tabs.update", params: { id: "welcome", title: "Renamed" } }, ids);
  assert.equal(updated.state.tabs[0]!.title, "Renamed");
  assert.equal(updated.state.tabs[0]!.message, start.tabs[0]!.message, "message untouched");
});

test("activate moves the active id and reports the tab", () => {
  const start = apply(fresh(), { method: "tabs.add", params: { title: "Build", message: "x", activate: false } }, ids).state;
  const activated = apply(start, { method: "tabs.activate", params: { id: "tab-1" } }, ids);
  assert.equal(activated.state.activeId, "tab-1");
  assert.deepEqual(activated.result, { id: "tab-1", title: "Build" });
});

test("list reports the state without changing it", () => {
  const start = fresh();
  const listed = apply(start, { method: "tabs.list", params: {} }, ids);
  assert.deepEqual(listed.state, start);
  assert.deepEqual(listed.result, { tabs: start.tabs, activeId: "welcome" });
});

test("an unknown tab is an AppError carrying a hint, not a crash", () => {
  const start = fresh();
  for (const op of [
    { method: "tabs.remove", params: { id: "nope" } },
    { method: "tabs.activate", params: { id: "nope" } },
    { method: "tabs.update", params: { id: "nope", title: "x" } },
  ] as const) {
    assert.throws(
      () => apply(start, op, ids),
      (e: unknown) => {
        assert.ok(e instanceof AppError);
        assert.equal(e.code, "tab_not_found");
        assert.match(e.hint ?? "", /actuator tabs list/);
        return true;
      },
      `${op.method} on a missing tab`
    );
  }
});
