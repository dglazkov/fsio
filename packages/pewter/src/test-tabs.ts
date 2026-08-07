// The tabs, as rules rather than as a screen.
//
// `applyTabs` is a pure function of a state and a command, which is what makes
// this file possible: everything a tab does can be checked without a browser,
// a folder, or a host. What is left for the rig is that the page really does
// call this, and that a frame appears.
import assert from "node:assert/strict";
import test from "node:test";
import { bodyLabel, applyTabs, asTabCommand, noTabs, TabError, type ApplyOptions, type TabsState } from "./tabs.js";

/** Stable ids and a stable clock, so a test can say which tab it means. */
let n = 0;
let f = 0;
const ids: ApplyOptions = { makeId: () => `tab-${++n}`, makeFileId: () => `file-${++f}`, now: () => 1700000000000 };
const fresh = (): TabsState => {
  n = 0;
  f = 0;
  return noTabs();
};

const add = (state: TabsState, name: string, params: Record<string, unknown> = {}): TabsState =>
  applyTabs(state, asTabCommand("tabs.add", { name, ...params })!, ids).state;

/** A fling, with the two facts only a page that opened the file could know. */
const fling = (state: TabsState, path: string, flung = { type: "text/markdown", size: 12 }, params: Record<string, unknown> = {}) =>
  applyTabs(state, asTabCommand("files.fling", { path, ...params })!, { ...ids, flung });

test("a fresh page holds nothing, and says so rather than inventing a tab", () => {
  assert.deepEqual(fresh(), { tabs: [], activeId: null, held: [] });
});

test("adding an extension opens it and brings it forward", () => {
  const { state, result } = applyTabs(fresh(), asTabCommand("tabs.add", { name: "repos" })!, ids);
  assert.deepEqual(result, { id: "tab-1", name: "repos", title: "repos", active: true });
  assert.deepEqual(state, { tabs: [{ id: "tab-1", title: "repos", body: { kind: "extension", name: "repos" } }], activeId: "tab-1", held: [] });
});

test("what a tab opens with rides through the check untouched (#198)", () => {
  // Any JSON value, unread: the page is not a party to the contract between
  // the screen that sent it and the screen that reads it.
  const pointed = asTabCommand("tabs.add", { name: "terminal", args: { repo: "site" } })!;
  assert.deepEqual(pointed.params, { name: "terminal", args: { repo: "site" } });
  assert.deepEqual(asTabCommand("tabs.add", { name: "t", args: 3 })!.params, { name: "t", args: 3 });
  // Opened bare stays bare — absence is a meaning (`args` resolves to
  // undefined in the extension), not a default to fill in.
  assert.equal("args" in asTabCommand("tabs.add", { name: "terminal" })!.params, false);
  // The tab it makes is the same tab either way: launch arguments are not
  // state, and the strip does not remember them.
  const { state } = applyTabs(fresh(), asTabCommand("tabs.add", { name: "terminal", args: { repo: "site" } })!, ids);
  assert.deepEqual(state.tabs, [{ id: "tab-1", title: "terminal", body: { kind: "extension", name: "terminal" } }]);
});

test("the same extension twice is two tabs — `add` is a verb about the strip", () => {
  const state = add(add(fresh(), "repos"), "repos");
  assert.deepEqual(
    state.tabs.map((t) => bodyLabel(t.body)),
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
  assert.equal(bodyLabel(state.tabs[0]!.body), "repos");
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
  assert.deepEqual(state, { tabs: [], activeId: null, held: [] });
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

// ---- the two file verbs
//
// `open` is a window and `fling` is a copy, and every difference between them
// is in here. What is not in here is bytes: a page reads them through the
// grant before it gets this far, so what these rules see is a path and, for a
// fling, the two facts that reading it produced.

test("opening a file makes a window on it, named after the file", () => {
  const { state, result } = applyTabs(fresh(), asTabCommand("files.open", { path: "repos/site/README.md" })!, ids);
  assert.deepEqual(result, { id: "tab-1", path: "repos/site/README.md", title: "README.md", active: true, reused: false });
  assert.deepEqual(state.tabs[0]!.body, { kind: "file", path: "repos/site/README.md" });
  // Nothing was taken into custody: a window is not a copy, and the catalog is
  // where custody is recorded.
  assert.deepEqual(state.held, []);
});

test("opening the same file twice is one window, brought forward", () => {
  const one = applyTabs(fresh(), asTabCommand("files.open", { path: "notes.md" })!, ids).state;
  const two = add(one, "chat");
  const { state, result } = applyTabs(two, asTabCommand("files.open", { path: "notes.md" })!, ids);
  assert.equal(result["reused"], true);
  assert.equal(state.tabs.length, 2);
  assert.equal(state.activeId, "tab-1");
});

test("flinging a file takes a copy into the catalog and shows it", () => {
  const { state, result } = fling(fresh(), "dist/report.html", { type: "text/html", size: 4096 });
  assert.deepEqual(result, {
    fileId: "file-1",
    id: "tab-1",
    name: "report.html",
    from: "dist/report.html",
    size: 4096,
    type: "text/html",
    superseded: null,
    active: true,
  });
  assert.deepEqual(state.tabs[0]!.body, { kind: "held", fileId: "file-1" });
  assert.deepEqual(state.held, [{ id: "file-1", name: "report.html", from: "dist/report.html", type: "text/html", size: 4096, at: 1700000000000 }]);
});

test("a file with no type of its own is typed by its name", () => {
  // Chrome reports an empty `type` on a `File` more often than not, so the
  // extension is the answer rather than the fallback nobody reaches.
  const { state } = fling(fresh(), "notes.md", { type: "", size: 3 });
  assert.equal(state.held[0]!.type, "text/markdown");
});

test("flinging the same path again supersedes the copy, and the tab follows", () => {
  const first = fling(fresh(), "dist/report.html").state;
  const { state, result } = fling(first, "dist/report.html", { type: "text/html", size: 9 });
  assert.equal(result["superseded"], "file-1");
  // One copy, not two: a second snapshot of one path with no way to tell them
  // apart is worse than one that is current.
  assert.deepEqual(state.held.map((h) => h.id), ["file-2"]);
  // And one tab, whose reference moved under it.
  assert.equal(state.tabs.length, 1);
  assert.deepEqual(state.tabs[0]!.body, { kind: "held", fileId: "file-2" });
});

test("a fling that reached the rules with no bytes behind it is refused, not guessed at", () => {
  assert.throws(
    () => applyTabs(fresh(), asTabCommand("files.fling", { path: "notes.md" })!),
    (e: unknown) => e instanceof TabError && e.code === "internal"
  );
});

test("the catalog outlives the tabs — closing a held tab keeps the copy", () => {
  const flung = fling(fresh(), "dist/report.html").state;
  const { state } = applyTabs(flung, asTabCommand("tabs.close", { id: "tab-1" })!, ids);
  assert.deepEqual(state.tabs, []);
  assert.equal(state.held.length, 1);
  // Which is what `files.show` is for: the copy is still the page's.
  const back = applyTabs(state, asTabCommand("files.show", { id: "file-1" })!, ids);
  assert.equal(back.result["reused"], false);
  assert.deepEqual(back.state.tabs[0]!.body, { kind: "held", fileId: "file-1" });
});

test("showing a copy a tab is already on brings that tab forward", () => {
  const flung = fling(fresh(), "dist/report.html").state;
  const two = add(flung, "chat");
  const { state, result } = applyTabs(two, asTabCommand("files.show", { id: "file-1" })!, ids);
  assert.equal(result["reused"], true);
  assert.equal(state.tabs.length, 2);
  assert.equal(state.activeId, "tab-1");
});

test("dropping a copy closes the windows onto it", () => {
  const flung = fling(fresh(), "dist/report.html").state;
  const two = add(flung, "chat");
  const { state, result } = applyTabs(two, asTabCommand("files.drop", { id: "file-1" })!, ids);
  assert.deepEqual(result, { id: "file-1", name: "report.html", closedTabs: 1, activeId: "tab-2" });
  assert.deepEqual(state.held, []);
  assert.deepEqual(state.tabs.map((t) => t.id), ["tab-2"]);
});

test("a file id nobody holds is a refusal that names how to find the right one", () => {
  const flung = fling(fresh(), "dist/report.html").state;
  for (const method of ["files.show", "files.drop"]) {
    assert.throws(
      () => applyTabs(flung, asTabCommand(method, { id: "file-9" })!, ids),
      (e: unknown) => e instanceof TabError && e.code === "file_not_held" && /pewt files/.test(e.hint ?? "")
    );
  }
});

test("files.list answers the catalog, and tabs.list does not", () => {
  const flung = fling(fresh(), "dist/report.html").state;
  assert.deepEqual(applyTabs(flung, asTabCommand("files.list", {})!, ids).result["files"], flung.held);
  // Two questions, two answers. An operation answering both would make the
  // strip impossible to ask about on its own.
  assert.deepEqual(Object.keys(applyTabs(flung, asTabCommand("tabs.list", {})!, ids).result).sort(), ["activeId", "tabs"]);
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
  assert.equal(asTabCommand("files.show", {}), null);
  assert.equal(asTabCommand("files.drop", { id: 7 }), null);
  assert.equal(asTabCommand("files.rm", { id: "file-1" }), null);
});

test("a path that climbs out of the pewter is not a command at all", () => {
  // The page's reach is exactly the folder it was granted, and this is the
  // check — on both ends, because the host forwarding a command is not a
  // promise that it made sense of it.
  for (const path of ["../secrets", "/etc/passwd", "C:\\keys", "notes\\md", "", ".", "a/../../b"]) {
    assert.equal(asTabCommand("files.open", { path }), null, `open accepted ${JSON.stringify(path)}`);
    assert.equal(asTabCommand("files.fling", { path }), null, `fling accepted ${JSON.stringify(path)}`);
  }
});

test("a path is normalized once, so both ends apply the same string", () => {
  assert.deepEqual(asTabCommand("files.open", { path: "./repos//site/README.md" }), {
    method: "files.open",
    params: { path: "repos/site/README.md" },
  });
});

test("what a command carries is only what the operation names", () => {
  // A field nobody asked for does not travel onward, whoever put it there.
  assert.deepEqual(asTabCommand("tabs.add", { name: "repos", when: "later" }), { method: "tabs.add", params: { name: "repos" } });
});
