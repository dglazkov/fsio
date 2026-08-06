// The tabs, as rules rather than as a screen.
//
// `applyTabs` is a pure function of a state and a command, which is what makes
// this file possible: everything a tab does can be checked without a browser,
// a folder, or a host. What is left for the rig is that the page really does
// call this, and that a frame appears.
import assert from "node:assert/strict";
import test from "node:test";
import { applyTabs, asTabCommand, noTabs, TabError, type TabsState } from "./tabs.js";

/** Stable ids, so a test can say which tab it means. */
let n = 0;
const ids = { makeId: () => `tab-${++n}` };
const fresh = (): TabsState => {
  n = 0;
  return noTabs();
};

const add = (state: TabsState, name: string, params: Record<string, unknown> = {}): TabsState =>
  applyTabs(state, asTabCommand("tabs.add", { name, ...params })!, ids).state;

test("a fresh page holds nothing, and says so rather than inventing a tab", () => {
  assert.deepEqual(fresh(), { tabs: [], activeId: null });
});

test("adding an extension opens it and brings it forward", () => {
  const { state, result } = applyTabs(fresh(), asTabCommand("tabs.add", { name: "repos" })!, ids);
  assert.deepEqual(result, { id: "tab-1", name: "repos", title: "repos", active: true });
  assert.deepEqual(state, { tabs: [{ id: "tab-1", title: "repos", body: { kind: "extension", name: "repos" } }], activeId: "tab-1" });
});

test("the same extension twice is two tabs — `add` is a verb about the strip", () => {
  const state = add(add(fresh(), "repos"), "repos");
  assert.deepEqual(
    state.tabs.map((t) => t.body.name),
    ["repos", "repos"]
  );
  assert.equal(state.activeId, "tab-2");
});

test("a tab can be added without being brought forward", () => {
  const state = add(add(fresh(), "repos"), "chat", { activate: false });
  assert.equal(state.tabs.length, 2);
  assert.equal(state.activeId, "tab-1");
});

test("a title is the extension's name until somebody changes it", () => {
  const opened = add(fresh(), "repos");
  const { state, result } = applyTabs(opened, asTabCommand("tabs.update", { id: "tab-1", title: "Projects" })!);
  assert.deepEqual(result, { id: "tab-1", title: "Projects" });
  assert.equal(state.tabs[0]!.title, "Projects");
  // Renaming a tab does not change what is in it. The extension is not told
  // and has nothing to do about it.
  assert.equal(state.tabs[0]!.body.name, "repos");
});

test("focus moves the stage and nothing else", () => {
  const two = add(add(fresh(), "repos"), "chat");
  const { state, result } = applyTabs(two, asTabCommand("tabs.focus", { id: "tab-1" })!);
  assert.deepEqual(result, { id: "tab-1", title: "repos" });
  assert.equal(state.activeId, "tab-1");
  assert.equal(state.tabs.length, 2);
});

test("closing the tab on screen hands the stage to what is left", () => {
  const two = add(add(fresh(), "repos"), "chat");
  const { state, result } = applyTabs(two, asTabCommand("tabs.close", { id: "tab-2" })!);
  assert.deepEqual(result, { id: "tab-2", activeId: "tab-1" });
  assert.equal(state.activeId, "tab-1");
});

test("closing a tab nobody is looking at leaves the stage alone", () => {
  const two = add(add(fresh(), "repos"), "chat");
  const { state } = applyTabs(two, asTabCommand("tabs.close", { id: "tab-1" })!);
  assert.equal(state.activeId, "tab-2");
});

test("closing the last tab leaves a page holding nothing, not a page showing nothing", () => {
  const one = add(fresh(), "repos");
  const { state, result } = applyTabs(one, asTabCommand("tabs.close", { id: "tab-1" })!);
  assert.deepEqual(state, { tabs: [], activeId: null });
  assert.equal(result["activeId"], null);
});

test("a tab id nobody holds is a refusal that names how to find the right one", () => {
  const one = add(fresh(), "repos");
  for (const method of ["tabs.focus", "tabs.close"]) {
    assert.throws(
      () => applyTabs(one, asTabCommand(method, { id: "tab-9" })!),
      (e: unknown) => e instanceof TabError && e.code === "tab_not_found" && /pewt tabs/.test(e.hint ?? "")
    );
  }
});

test("the state a command is applied to is not the one it came from", () => {
  const before = add(fresh(), "repos");
  const snapshot = JSON.stringify(before);
  applyTabs(before, asTabCommand("tabs.update", { id: "tab-1", title: "Projects" })!);
  assert.equal(JSON.stringify(before), snapshot);
});

// ---- what arrives, checked
//
// Both ends run `asTabCommand`: the command line to turn what was typed into
// what travels, and the page to check what arrived. Anything that can write
// the folder can write anything (spec/PROTOCOL.md, threat model), so a
// command reaching the page is not evidence that it made sense.

test("a command with the wrong shape is not a command", () => {
  assert.equal(asTabCommand("tabs.add", {}), null);
  assert.equal(asTabCommand("tabs.add", { name: 42 }), null);
  assert.equal(asTabCommand("tabs.add", { name: "" }), null);
  assert.equal(asTabCommand("tabs.add", { name: "repos", activate: "yes" }), null);
  assert.equal(asTabCommand("tabs.update", { id: "tab-1" }), null);
  assert.equal(asTabCommand("tabs.close", {}), null);
  assert.equal(asTabCommand("tabs.list", null), null);
  assert.equal(asTabCommand("files.open", { path: "notes.md" }), null);
});

test("what a command carries is only what the operation names", () => {
  // A field nobody asked for does not travel onward, whoever put it there.
  assert.deepEqual(asTabCommand("tabs.add", { name: "repos", when: "later" }), { method: "tabs.add", params: { name: "repos" } });
});
