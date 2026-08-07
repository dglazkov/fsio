// The projects in a pewter: the directories under `repos/`.
//
// `repos/` is git-ignored (NARRATIVE.md), which is what lets you push a
// pewter to a public repository without publishing anything you have worked
// on — and it is why a missing or empty `repos/` is a normal answer here
// rather than an error. A freshly cloned pewter has no projects, and the
// screen that says so is the same screen that offers to add one.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Pewter } from "./pewter.js";

const run = promisify(execFile);

export interface Project {
  /** the directory name under `repos/`, which is the project's whole name. */
  name: string;
  /** whether it is a git repository. A directory under `repos/` that is not
   *  one is still listed: the folder is the user's, and a screen that hides
   *  what is actually there would be lying about their own disk. */
  git: boolean;
  /** the branch it is on, or null — detached, not a repository, or a HEAD
   *  this build cannot read. Read from `.git/HEAD` directly rather than by
   *  spawning git: a list is painted on every screen refresh, and the file
   *  is the format git itself documents. */
  branch: string | null;
  /** the script names its `package.json` declares, in declaration order —
   *  the set of runnable things is a file (NARRATIVE.md), and this is that
   *  file's table of contents. Empty when there is no manifest. */
  scripts: string[];
}

/** Every project, by name. Sorted, so two calls a second apart do not
 *  reorder a list somebody is looking at — `readdir` order is the
 *  filesystem's business and APFS does not promise one. */
export async function listRepos(p: Pewter): Promise<Project[]> {
  let entries;
  try {
    entries = await fs.readdir(p.repos, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: Project[] = [];
  for (const e of entries) {
    // Not a directory, or hidden: `repos/` holds projects, and a stray
    // `.DS_Store` is not one.
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    found.push(await projectAt(p, e.name));
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** One project's facts, read fresh. The same shape whether it is being
 *  listed or was just made, so a new row is never a special case. */
export async function projectAt(p: Pewter, name: string): Promise<Project> {
  const dir = path.join(p.repos, name);
  const git = await isGitRepo(dir);
  return {
    name,
    git,
    branch: git ? await branchOf(dir) : null,
    scripts: await scriptsOf(dir),
  };
}

/** The branch `.git/HEAD` names, following a worktree's `.git` *file* to the
 *  real directory first. A detached HEAD is a sha, not a ref, and answers
 *  null — "which branch" has no true answer there and a made-up one would be
 *  worse than none. */
async function branchOf(dir: string): Promise<string | null> {
  try {
    let gitDir = path.join(dir, ".git");
    if ((await fs.stat(gitDir)).isFile()) {
      // A worktree or a submodule: `gitdir: <path>`, possibly relative.
      const pointer = (await fs.readFile(gitDir, "utf8")).trim();
      if (!pointer.startsWith("gitdir:")) return null;
      gitDir = path.resolve(dir, pointer.slice("gitdir:".length).trim());
    }
    const head = (await fs.readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : null;
  } catch {
    return null;
  }
}

/** The scripts a manifest declares, in declaration order — a screen showing
 *  them out of order would un-say what the author put first on purpose. */
async function scriptsOf(dir: string): Promise<string[]> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    return Object.keys(pkg.scripts ?? {});
  } catch {
    return []; // no manifest, or one that does not parse: nothing runnable either way
  }
}

/** `.git` present, as a file or a directory: a worktree and a submodule both
 *  carry a `.git` *file*, and both are git repositories. */
async function isGitRepo(dir: string): Promise<boolean> {
  return await fs
    .stat(path.join(dir, ".git"))
    .then(() => true)
    .catch(() => false);
}

/** What a project may be called: one path segment, not hidden. The same rule
 *  `run` applies to `--repo`, owned here because this module owns what a
 *  project is. */
export const isProjectName = (name: string): boolean => name !== "" && !name.startsWith(".") && !/[\\/]/.test(name);

/** Creating or cloning a project cannot go ahead, and this is the sentence
 *  saying why. ops.ts translates it into the table's vocabulary, the same
 *  arrangement `bundle.ts` and `grants.ts` have. */
export class ReposError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "ReposError";
  }
}

/** A new project: a directory under `repos/` that is a git repository.
 *
 *  `git init` and nothing else — no README, no manifest, no license. What a
 *  project starts as is the user's decision, and a scaffold here would be
 *  this table deciding it. A machine with no git gets a refusal rather than
 *  a half-project: the directory is removed again, because a "project" that
 *  silently is not a repository would surface as a surprise much later,
 *  in someone's push. */
export async function createRepo(p: Pewter, name: string): Promise<Project> {
  if (!isProjectName(name)) {
    throw new ReposError("bad_name", `${JSON.stringify(name)} is not a project name`, "a project is a directory under repos/ — one path segment, not hidden");
  }
  await fs.mkdir(p.repos, { recursive: true });
  const dest = path.join(p.repos, name);
  try {
    // mkdir without recursive is the existence check: atomic, so two calls
    // racing cannot both believe they made it.
    await fs.mkdir(dest);
  } catch {
    throw new ReposError("exists", `there is already a project named ${name} in this pewter`, "`pewt repos` lists them");
  }
  try {
    await run("git", ["init", "--quiet"], { cwd: dest });
  } catch (e) {
    await fs.rm(dest, { recursive: true, force: true });
    const why = e instanceof Error ? e.message.split("\n")[0] : String(e);
    throw new ReposError("git_failed", `git init failed — ${why}`, "is git installed on this machine?");
  }
  return projectAt(p, name);
}
