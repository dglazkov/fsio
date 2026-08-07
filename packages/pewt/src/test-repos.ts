// The project list: what is under repos/, and what a missing repos/ means.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pewterAt, type Pewter } from "./pewter.js";
import { createRepo, isProjectName, listRepos, ReposError } from "./repos.js";

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
    { name: "atlas", git: false, branch: null, scripts: [], installed: null },
    { name: "site", git: true, branch: null, scripts: [], installed: null },
  ]);
});

test("a row carries its branch and its scripts, in declaration order (#191)", async () => {
  const p = pewter();
  const dir = path.join(p.repos, "site");
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/trunk\n");
  // Declaration order is the author's, and the screen keeps it.
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite", build: "vite build", test: "node --test" } }));
  assert.deepEqual(await listRepos(p), [{ name: "site", git: true, branch: "trunk", scripts: ["dev", "build", "test"], installed: false }]);
});

test("a detached HEAD has no branch, and says so with null rather than a sha", async () => {
  const p = pewter();
  const dir = path.join(p.repos, "pinned");
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "aab61b1f0d7a0d0c2b4c8d0f3ef1a2b3c4d5e6f7\n");
  assert.deepEqual(await listRepos(p), [{ name: "pinned", git: true, branch: null, scripts: [], installed: null }]);
});

test("a .git file counts — a worktree and a submodule both carry one", async () => {
  const p = pewter();
  fs.mkdirSync(path.join(p.repos, "linked"), { recursive: true });
  fs.writeFileSync(path.join(p.repos, "linked", ".git"), "gitdir: /elsewhere/.git/worktrees/linked");
  assert.deepEqual(await listRepos(p), [{ name: "linked", git: true, branch: null, scripts: [], installed: null }]);
});

test("a worktree's .git file is followed to the real HEAD", async () => {
  const p = pewter();
  const real = path.join(p.root, "elsewhere", "worktrees", "linked");
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, "HEAD"), "ref: refs/heads/fix-42\n");
  const dir = path.join(p.repos, "linked");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${real}\n`);
  assert.deepEqual((await listRepos(p))[0]?.branch, "fix-42");
});

test("files and hidden entries under repos/ are not projects", async () => {
  const p = pewter();
  fs.mkdirSync(p.repos, { recursive: true });
  fs.writeFileSync(path.join(p.repos, "notes.md"), "hello");
  fs.writeFileSync(path.join(p.repos, ".DS_Store"), "");
  fs.mkdirSync(path.join(p.repos, ".cache"));
  assert.deepEqual(await listRepos(p), []);
});

// ---- repos.create (#189)

test("create makes a directory under repos/ that is a git repository", async () => {
  const p = pewter();
  const made = await createRepo(p, "atlas");
  // The same shape a listed row has — including the branch git init chose —
  // so the row a create becomes is never a special case.
  assert.deepEqual(made, { name: "atlas", git: true, branch: made.branch, scripts: [], installed: null });
  assert.ok(typeof made.branch === "string" && made.branch.length > 0, `a fresh repository is on a branch (got ${JSON.stringify(made.branch)})`);
  assert.ok(fs.existsSync(path.join(p.repos, "atlas", ".git")), "git init ran in it");
  // The branch is whatever this machine's git chose (init.defaultBranch), so
  // the pin is agreement with the create's answer, not a name.
  assert.deepEqual(await listRepos(p), [{ name: "atlas", git: true, branch: made.branch, scripts: [], installed: null }]);
});

test("create refuses a name that is taken, and touches nothing", async () => {
  const p = pewter();
  await createRepo(p, "site");
  await assert.rejects(createRepo(p, "site"), (e: unknown) => e instanceof ReposError && e.code === "exists");
  assert.equal((await listRepos(p)).length, 1);
});

test("create refuses what is not a project name — the same rule --repo lives by", async () => {
  const p = pewter();
  for (const bad of ["", ".hidden", "a/b", "a\\b"]) {
    assert.equal(isProjectName(bad), false, JSON.stringify(bad));
    await assert.rejects(createRepo(p, bad), (e: unknown) => e instanceof ReposError && e.code === "bad_name");
  }
  assert.deepEqual(await listRepos(p), []);
});

test("installed is a tri-state: no manifest, not installed, installed (#193)", async () => {
  const p = pewter();
  fs.mkdirSync(path.join(p.repos, "bare"), { recursive: true });
  const fresh = path.join(p.repos, "fresh");
  fs.mkdirSync(fresh, { recursive: true });
  fs.writeFileSync(path.join(fresh, "package.json"), "{}");
  const done = path.join(p.repos, "done");
  fs.mkdirSync(path.join(done, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(done, "package.json"), "{}");
  assert.deepEqual(
    (await listRepos(p)).map((r) => [r.name, r.installed]),
    [
      ["bare", null],
      ["done", true],
      ["fresh", false],
    ]
  );
});
