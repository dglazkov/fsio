// The application reducer. Pure, so these are the cheapest tests in the
// package and the ones that say what the demo actually does.
import test from "node:test";
import assert from "node:assert/strict";
import {
  apply,
  AppError,
  initialState,
  MAX_FLING_BYTES,
  mimeFor,
  safeRelPath,
  viewerFor,
  type AppState,
  type ApplyOptions,
  type Tab,
} from "./model.js";

let n = 0;
let f = 0;
let clock = 0;
const opts: ApplyOptions = {
  makeId: () => `tab-${++n}`,
  makeFileId: () => `file-${++f}`,
  now: () => (clock += 1000),
};
const fresh = (): AppState => {
  n = 0;
  f = 0;
  clock = 0;
  return initialState();
};

/** What a tab is showing, as one string, so an assertion reads like the
 *  claim it is making. */
const showing = (tab: Tab): string =>
  tab.body.kind === "message" ? "message" : tab.body.kind === "local" ? `local:${tab.body.path}` : `held:${tab.body.fileId}`;

const flingOf = (name: string, from: string, data = "aGk="): Parameters<typeof apply>[1] => ({
  method: "files.fling",
  params: { name, from, type: mimeFor(name), size: 2, data },
});

test("a fresh page holds one tab, and it is active", () => {
  const state = fresh();
  assert.equal(state.tabs.length, 1);
  assert.equal(state.activeId, state.tabs[0]!.id);
  assert.deepEqual(state.held, [], "and no files, until something is flung");
});

test("add appends and activates; --no-activate leaves the active tab alone", () => {
  const start = fresh();
  const added = apply(start, { method: "tabs.add", params: { title: "Build", message: "running" } }, opts);
  assert.equal(added.state.tabs.length, 2);
  assert.equal(added.state.activeId, "tab-1");
  assert.deepEqual(added.result, { id: "tab-1", title: "Build", active: true });

  const quiet = apply(
    added.state,
    { method: "tabs.add", params: { title: "Deploy", message: "queued", activate: false } },
    opts
  );
  assert.equal(quiet.state.activeId, "tab-1", "the active tab did not move");
  assert.equal(quiet.state.tabs.length, 3);
});

test("apply does not mutate the state it was given", () => {
  const start = fresh();
  const before = JSON.stringify(start);
  apply(start, { method: "tabs.add", params: { title: "x", message: "y" } }, opts);
  apply(start, { method: "tabs.update", params: { id: "welcome", title: "changed" } }, opts);
  apply(start, flingOf("a.txt", "/tmp/a.txt"), opts);
  assert.equal(JSON.stringify(start), before);
});

test("removing the active tab hands focus to what is left; the last one leaves none", () => {
  const start = apply(fresh(), { method: "tabs.add", params: { title: "Build", message: "running" } }, opts).state;
  const removed = apply(start, { method: "tabs.remove", params: { id: "tab-1" } }, opts);
  assert.equal(removed.state.activeId, "welcome");
  assert.deepEqual(
    removed.state.tabs.map((t) => t.id),
    ["welcome"]
  );

  const empty = apply(removed.state, { method: "tabs.remove", params: { id: "welcome" } }, opts);
  assert.deepEqual(empty.state.tabs, []);
  assert.equal(empty.state.activeId, null);
});

test("removing an inactive tab leaves the active one alone", () => {
  const start = apply(fresh(), { method: "tabs.add", params: { title: "Build", message: "x" } }, opts).state;
  const removed = apply(start, { method: "tabs.remove", params: { id: "welcome" } }, opts);
  assert.equal(removed.state.activeId, "tab-1");
});

test("update changes only the fields it was given", () => {
  const start = fresh();
  const updated = apply(start, { method: "tabs.update", params: { id: "welcome", title: "Renamed" } }, opts);
  assert.equal(updated.state.tabs[0]!.title, "Renamed");
  assert.deepEqual(updated.state.tabs[0]!.body, start.tabs[0]!.body, "message untouched");
});

test("activate moves the active id and reports the tab", () => {
  const start = apply(fresh(), { method: "tabs.add", params: { title: "Build", message: "x", activate: false } }, opts).state;
  const activated = apply(start, { method: "tabs.activate", params: { id: "tab-1" } }, opts);
  assert.equal(activated.state.activeId, "tab-1");
  assert.deepEqual(activated.result, { id: "tab-1", title: "Build" });
});

test("list reports the state without changing it", () => {
  const start = fresh();
  const listed = apply(start, { method: "tabs.list", params: {} }, opts);
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
      () => apply(start, op, opts),
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

// ------------------------------------------------------- opening a file

test("open makes a tab that holds a path, and no contents", () => {
  const opened = apply(fresh(), { method: "files.open", params: { path: "notes/plan.md" } }, opts);
  const tab = opened.state.tabs.at(-1)!;
  assert.equal(tab.title, "plan.md", "titled by basename");
  assert.equal(showing(tab), "local:notes/plan.md");
  assert.equal(opened.state.activeId, tab.id);
  assert.deepEqual(opened.result, { id: "tab-1", path: "notes/plan.md", reused: false });
  assert.equal(
    JSON.stringify(opened.state).includes("contents"),
    false,
    "a local tab is a reference; the bytes stay on disk"
  );
});

test("opening the same file twice brings the tab forward instead of collecting tabs", () => {
  const once = apply(fresh(), { method: "files.open", params: { path: "a.md" } }, opts).state;
  const other = apply(once, { method: "tabs.add", params: { title: "x", message: "y" } }, opts).state;
  const again = apply(other, { method: "files.open", params: { path: "a.md" } }, opts);
  assert.equal(again.state.tabs.length, 3);
  assert.deepEqual(again.result, { id: "tab-1", path: "a.md", reused: true });
  assert.equal(again.state.activeId, "tab-1");
});

test("a path that leaves the granted folder is refused, and the refusal names the other verb", () => {
  for (const path of ["../secrets", "/etc/passwd", "a/../../b", "", "C:/x"]) {
    assert.throws(
      () => apply(fresh(), { method: "files.open", params: { path } }, opts),
      (e: unknown) => {
        assert.ok(e instanceof AppError);
        assert.equal(e.code, "bad_path");
        assert.match(e.hint ?? "", /fling/);
        return true;
      },
      path
    );
  }
});

test("safeRelPath normalizes what it does accept", () => {
  assert.equal(safeRelPath("./a//b.txt"), "a/b.txt");
  assert.equal(safeRelPath("a/b.txt"), "a/b.txt");
  assert.equal(safeRelPath("a\\b.txt"), null, "a backslash is not a separator here");
});

test("a file tab's text is the file's — a command cannot rewrite it", () => {
  const opened = apply(fresh(), { method: "files.open", params: { path: "a.md" } }, opts).state;
  assert.throws(
    () => apply(opened, { method: "tabs.update", params: { id: "tab-1", message: "not what the file says" } }, opts),
    (e: unknown) => {
      assert.ok(e instanceof AppError);
      assert.equal(e.code, "not_a_message_tab");
      return true;
    }
  );
  // Renaming is fine: the title is the page's, the contents are not.
  const renamed = apply(opened, { method: "tabs.update", params: { id: "tab-1", title: "Plan" } }, opts);
  assert.equal(renamed.state.tabs.at(-1)!.title, "Plan");
  assert.equal(showing(renamed.state.tabs.at(-1)!), "local:a.md");
});

// ------------------------------------------------------- flinging a file

test("fling puts a file in the catalog, opens it, and keeps the bytes out of state", () => {
  const flung = apply(fresh(), flingOf("graph.png", "/home/me/graph.png", "AAEC"), opts);
  assert.deepEqual(flung.state.held, [
    { id: "file-1", name: "graph.png", from: "/home/me/graph.png", type: "image/png", size: 2, at: 1000 },
  ]);
  const tab = flung.state.tabs.at(-1)!;
  assert.equal(showing(tab), "held:file-1");
  assert.equal(flung.state.activeId, tab.id);
  assert.deepEqual(flung.result, {
    fileId: "file-1",
    id: "tab-1",
    name: "graph.png",
    size: 2,
    type: "image/png",
    superseded: null,
    opened: true,
  });
  assert.equal(JSON.stringify(flung.state).includes("AAEC"), false, "the bytes are the caller's to store, not the state's");
});

test("--no-open holds the file without a tab, and `files show` opens it later", () => {
  const held = apply(
    fresh(),
    { method: "files.fling", params: { name: "a.txt", from: "/tmp/a.txt", type: "text/plain", size: 2, data: "aGk=", open: false } },
    opts
  );
  assert.equal(held.state.tabs.length, 1, "no tab was opened");
  assert.equal(held.state.held.length, 1);
  assert.equal(held.result["id"], null);

  const shown = apply(held.state, { method: "files.show", params: { id: "file-1" } }, opts);
  assert.equal(showing(shown.state.tabs.at(-1)!), "held:file-1");
  assert.deepEqual(shown.result, { id: "tab-1", name: "a.txt", reused: false });

  const again = apply(shown.state, { method: "files.show", params: { id: "file-1" } }, opts);
  assert.equal(again.state.tabs.length, 2, "showing it twice does not make a second tab");
  assert.equal(again.result["reused"], true);
});

test("flinging the same source again supersedes the copy, and the open tab follows it", () => {
  const first = apply(fresh(), flingOf("a.txt", "/tmp/a.txt"), opts).state;
  const second = apply(first, flingOf("a.txt", "/tmp/a.txt"), opts);
  assert.deepEqual(
    second.state.held.map((h) => h.id),
    ["file-2"],
    "one copy of a source, and it is the newest"
  );
  assert.equal(second.state.tabs.length, 2, "no second tab for the same file");
  assert.equal(showing(second.state.tabs.at(-1)!), "held:file-2");
  assert.equal(second.result["superseded"], "file-1", "the caller is told which blob to drop");
});

test("a file too big to carry is refused with the number in it", () => {
  assert.throws(
    () =>
      apply(
        fresh(),
        { method: "files.fling", params: { name: "big.bin", from: "/big.bin", type: "application/octet-stream", size: MAX_FLING_BYTES + 1, data: "" } },
        opts
      ),
    (e: unknown) => {
      assert.ok(e instanceof AppError);
      assert.equal(e.code, "too_big");
      assert.match(e.message, new RegExp(String(MAX_FLING_BYTES)));
      return true;
    }
  );
});

test("files list reports the catalog; drop lets go and closes what was showing it", () => {
  const held = apply(fresh(), flingOf("a.txt", "/tmp/a.txt"), opts).state;
  const listed = apply(held, { method: "files.list", params: {} }, opts);
  assert.deepEqual(listed.result, { files: held.held });
  assert.deepEqual(listed.state, held, "listing changes nothing");

  const dropped = apply(held, { method: "files.drop", params: { id: "file-1" } }, opts);
  assert.deepEqual(dropped.state.held, []);
  assert.deepEqual(
    dropped.state.tabs.map((t) => t.id),
    ["welcome"],
    "the window onto those bytes closed with them"
  );
  assert.equal(dropped.state.activeId, "welcome", "and focus went to what is left");
  assert.equal(dropped.result["closedTabs"], 1);
});

test("dropping or showing a file this page does not hold is an AppError with the way to look", () => {
  for (const method of ["files.drop", "files.show"] as const) {
    assert.throws(
      () => apply(fresh(), { method, params: { id: "file-nope" } }, opts),
      (e: unknown) => {
        assert.ok(e instanceof AppError);
        assert.equal(e.code, "file_not_held");
        assert.match(e.hint ?? "", /actuator files list/);
        return true;
      },
      method
    );
  }
});

test("the viewer follows the type, and unknown types get told so rather than shown", () => {
  assert.equal(viewerFor(mimeFor("notes.md")), "text");
  assert.equal(viewerFor(mimeFor("data.json")), "text");
  assert.equal(viewerFor(mimeFor("shot.png")), "image");
  assert.equal(viewerFor(mimeFor("drawing.svg")), "text", "svg is markup a text view can show honestly");
  assert.equal(viewerFor(mimeFor("archive.tar.gz")), "none");
  assert.equal(viewerFor(mimeFor("Makefile")), "none");
});
