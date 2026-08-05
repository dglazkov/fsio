// The project list: what is under repos/, and what a missing repos/ means.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pewterAt, type Pewter } from "./pewter.js";
import { listRepos } from "./repos.js";

function pewter(): Pewter {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pewt-repos-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", pewter: {} }));
  return pewterAt(root)!;
}

test("a pewter with no repos/ has no projects, and that is not an error", async () => {
  assert.deepEqual(await listRepos(pewter()), []);
});

test("projects are the directories under repos/, sorted, marked by whether they are git", async () => {
  const p = pewter();
  fs.mkdirSync(path.join(p.repos, "site", ".git"), { recursive: true });
  fs.mkdirSync(path.join(p.repos, "atlas"), { recursive: true });
  assert.deepEqual(await listRepos(p), [
    { name: "atlas", git: false },
    { name: "site", git: true },
  ]);
});

test("a .git file counts — a worktree and a submodule both carry one", async () => {
  const p = pewter();
  fs.mkdirSync(path.join(p.repos, "linked"), { recursive: true });
  fs.writeFileSync(path.join(p.repos, "linked", ".git"), "gitdir: /elsewhere/.git/worktrees/linked");
  assert.deepEqual(await listRepos(p), [{ name: "linked", git: true }]);
});

test("files and hidden entries under repos/ are not projects", async () => {
  const p = pewter();
  fs.mkdirSync(p.repos, { recursive: true });
  fs.writeFileSync(path.join(p.repos, "notes.md"), "hello");
  fs.writeFileSync(path.join(p.repos, ".DS_Store"), "");
  fs.mkdirSync(path.join(p.repos, ".cache"));
  assert.deepEqual(await listRepos(p), []);
});
