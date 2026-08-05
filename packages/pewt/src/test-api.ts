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
import { METHODS, type Bundle as ApiBundle, type Project as ApiProject } from "pewter";
import type { Bundle } from "./bundle.js";
import { OPERATIONS } from "./ops.js";
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
  assert.deepEqual([...METHODS].sort(), OPERATIONS.map((o) => o.method).sort());
});
