import assert from "node:assert/strict";
import test from "node:test";
import { AppError, applyOperation, initialState } from "./model.js";

test("tab operations mutate page state and return identifiers (#152)", () => {
  const added = applyOperation(initialState(), { method: "tabs.add", params: { title: "Build", message: "Running" } }, () => "tab-build");
  assert.equal(added.state.activeId, "tab-build");
  const updated = applyOperation(added.state, { method: "tabs.update", params: { id: "tab-build", message: "Done" } });
  assert.equal(updated.state.tabs[1]?.message, "Done");
  const removed = applyOperation(updated.state, { method: "tabs.remove", params: { id: "tab-build" } });
  assert.equal(removed.state.activeId, "welcome");
});

test("unknown tabs fail with a stable application code (#152)", () => {
  assert.throws(() => applyOperation(initialState(), { method: "tabs.activate", params: { id: "missing" } }), (error) => error instanceof AppError && error.code === "tab_not_found");
});
