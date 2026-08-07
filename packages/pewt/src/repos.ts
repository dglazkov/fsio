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
    found.push({
      name: e.name,
      git: await isGitRepo(path.join(p.repos, e.name)),
    });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
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
  return { name, git: true };
}
