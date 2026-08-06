// What a terminal typed → the path the page reads.
//
// `pewt open` and `pewt fling` take a path *inside the pewter*, and the page
// resolves it against the folder it was granted. An extension already speaks
// that way: it has no working directory and nothing else would mean anything
// to it. A terminal does not — what your shell completed is relative to where
// you are standing, and half the time it is absolute.
//
// So this is the command line's own convention, the way `--repo site` is:
// resolve what was typed the way the shell meant it, and hand the wire the one
// spelling it knows. The spellings differ where each front end has its own
// conventions; the operation does not.
//
// A path that lands outside the pewter is refused here rather than after a
// round trip, and the refusal has both spellings in it — the page would refuse
// it too, but by then the absolute path is gone and the message can only say
// "not a path inside the folder" about a string that looked relative.
import path from "node:path";
import { safeRelPath } from "pewter";

export type Resolved = { path: string } | { outside: string };

/** Resolve one typed path against a pewter.
 *
 *  `cwd` is a parameter rather than `process.cwd()` so this is testable, and
 *  because it is genuinely variable: `--dir` acts on a pewter the working
 *  directory need not be anywhere near.
 *
 *  Three cases, and the third is the one worth knowing about:
 *
 *  - you are standing in the pewter → what you typed is resolved the way your
 *    shell meant it, and the answer is folder-relative.
 *  - you typed something outside it → refused, with where it landed.
 *  - you are standing outside the pewter and typed a relative path → it is
 *    taken as already folder-relative. That is `pewt --dir ../other open
 *    README.md`, where resolving against the working directory would reach
 *    for a file in the wrong project. */
export function inPewter(typed: string, root: string, cwd: string): Resolved {
  const landed = path.resolve(cwd, typed);
  const rel = path.relative(root, landed);
  if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return { path: rel.split(path.sep).join("/") };
  // Standing outside the pewter, with a relative path: it was never about the
  // working directory, so it is taken as folder-relative — but only if it is
  // one. `../escaped.md` cannot be inside the pewter from anywhere, so the
  // shared check refuses it here rather than after a round trip.
  const here = path.relative(root, path.resolve(cwd));
  const away = here.startsWith("..") || path.isAbsolute(here);
  if (away && !path.isAbsolute(typed) && safeRelPath(typed)) return { path: safeRelPath(typed)! };
  return { outside: landed };
}
