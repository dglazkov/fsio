// The projects in a pewter: the directories under `repos/`.
//
// `repos/` is git-ignored (NARRATIVE.md), which is what lets you push a
// pewter to a public repository without publishing anything you have worked
// on — and it is why a missing or empty `repos/` is a normal answer here
// rather than an error. A freshly cloned pewter has no projects, and the
// screen that says so is the same screen that offers to add one.
import fs from "node:fs/promises";
import path from "node:path";
import type { Pewter } from "./pewter.js";

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
