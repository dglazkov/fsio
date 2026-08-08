// The two copies of one list, checked against each other.
//
// The host's operation table (ops.ts) is the authority on what exists. The
// `pewter` package writes the same list out a second time as a typed
// interface, because that interface is what an editor completes and what
// `pewt check` fails on — the only feedback signal an agent writing an
// extension can run alone.
//
// Two copies of anything drift. This file is where they are not allowed to:
// a method added to the table and not to the API fails here, and so does the
// reverse. The result types are checked the same way, by assignment, so a
// field added on one side and not the other stops the build.
import assert from "node:assert/strict";
import test from "node:test";
import { METHODS, PAGE_METHODS, PROCESS_METHODS, type Bundle as ApiBundle, type Project as ApiProject } from "pewter";
import type { Bundle } from "./bundle.js";
import { hostAnswers, OPERATIONS, PROCESSES } from "./ops.js";
import type { Project } from "./repos.js";

// Compile-time, both directions: either side gaining a field the other lacks
// is an error here rather than a surprise in a tab.
const _projectToApi: ApiProject = {} as Project;
const _apiToProject: Project = {} as ApiProject;
const _bundleToApi: ApiBundle = {} as Bundle;
const _apiToBundle: Bundle = {} as ApiBundle;
void _projectToApi;
void _apiToProject;
void _bundleToApi;
void _apiToBundle;

test("the API package spells exactly the operations the host serves", () => {
  // Both families: a process is an operation an extension calls the same way
  // it calls any other, and one missing from either side is the drift this
  // file exists to stop.
  assert.deepEqual([...METHODS].sort(), [...OPERATIONS.map((o) => o.method), ...PROCESSES.map((o) => o.method)].sort());
});

test("every process the host serves is one the shell knows how to route", () => {
  // The bug this exists to stop, which it did not stop the first time: `exec`
  // was added to the host's table and to the API, and the shell's dispatch
  // was a hand-written condition listing `run`, `repos.clone` and
  // `repos.install`. So `pewt exec` worked from a terminal and every call
  // from a page came back "unknown method: exec" — the fallthrough treats an
  // unrouted method as a request, and the operation table has no entry for a
  // process.
  //
  // The shell routes a process one of three ways: the streaming shape that
  // `runOnHost` serves (`PROCESS_METHODS`, now a shared list rather than a
  // condition), and the two that hold a live stream open in both directions
  // and therefore have handlers of their own.
  const routed = [...PROCESS_METHODS, "shell", "agent"];
  assert.deepEqual(routed.sort(), PROCESSES.map((o) => o.method).sort());
});

test("the page's own list is exactly the operations the host does not answer", () => {
  // The shell reads `PAGE_METHODS` to decide which calls stop at the page
  // rather than travelling to the host (pewter-shell/web/bridge.ts), and the
  // host reads its table to decide which questions it forwards to the page. A
  // method in one list and not the other would make a tab operation take the
  // long way round the folder to reach the party that was already holding it.
  assert.deepEqual(
    [...PAGE_METHODS].sort(),
    OPERATIONS.filter((o) => !hostAnswers(o))
      .map((o) => o.method)
      .sort()
  );
});
