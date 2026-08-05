// What a pewter is, as far as the code is concerned.
//
// A pewter is three things at once (NARRATIVE.md): a git repository, an npm
// project, and the folder the transport rides. Only the middle one is
// checkable without guessing, so that is the check — a `package.json` with a
// `pewter` field. A directory that merely has an `extensions/` folder is
// somebody else's project, and a git repository is not evidence of anything.
//
// `pewt` only runs inside a pewter, so every command starts by finding one:
// walk up from the working directory until a package.json says so. That is
// how npm itself behaves, and it is why `pewt run build --repo fsio` works
// from anywhere under the folder rather than only at its root.
import fs from "node:fs";
import path from "node:path";

/** The directories a pewter is made of, resolved once so nothing downstream
 *  does string surgery on paths.
 *
 *  Two of them are regenerated and two are not, and the difference is the
 *  whole reason they are separate directories:
 *
 *    .fsio    the channel — frames and transcripts. The host owns its
 *             cleanup (D6), and this package never writes into it directly.
 *    .pewter  this pewter's own state: bundled extensions, and (later)
 *             grants. Delete either and the next `pewt serve` rebuilds it. */
export interface Pewter {
  /** absolute path to the pewter itself. */
  root: string;
  /** its directory name — what a human calls it, and what the page shows. */
  name: string;
  /** `.fsio` — the channel. */
  fsio: string;
  /** `.pewter` — state this host regenerates. */
  state: string;
  /** `.pewter/build` — one self-contained HTML file per extension. */
  build: string;
  /** `repos/` — the projects. Git-ignored: a cloned pewter has none. */
  repos: string;
  /** `extensions/` — the screens, including the ones agents wrote. */
  extensions: string;
}

/** Why a directory is not a pewter, in the words the CLI prints. */
export class NotAPewter extends Error {
  constructor(
    readonly dir: string,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "NotAPewter";
  }
}

const paths = (root: string): Pewter => ({
  root,
  name: path.basename(root),
  fsio: path.join(root, ".fsio"),
  state: path.join(root, ".pewter"),
  build: path.join(root, ".pewter", "build"),
  repos: path.join(root, "repos"),
  extensions: path.join(root, "extensions"),
});

/** Is this exact directory a pewter? Returns null rather than throwing:
 *  the walk below calls it once per ancestor, and "no" is the normal answer
 *  for all but one of them. */
export function pewterAt(dir: string): Pewter | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, "package.json"), "utf8");
  } catch {
    return null;
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    // A package.json this process cannot parse is npm's problem to report,
    // not a reason to claim the directory above is the pewter.
    return null;
  }
  if (!pkg || typeof pkg !== "object" || !("pewter" in pkg)) return null;
  return paths(path.resolve(dir));
}

/** The pewter containing `from`, or the reason there is none.
 *
 *  Stops at the filesystem root. It deliberately does not stop at a git
 *  boundary: a pewter is a git repository, so every directory inside one is
 *  inside a repository too, and treating that as a fence would make the walk
 *  fail exactly where it is most needed. */
export function findPewter(from: string = process.cwd()): Pewter {
  let dir = path.resolve(from);
  for (;;) {
    const found = pewterAt(dir);
    if (found) return found;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new NotAPewter(
    path.resolve(from),
    "this is not a pewter",
    "`pewt` runs inside a pewter and nowhere else. Make one: npm create pewt@latest ~/dev/tinkering"
  );
}

/** Make the directories a running host needs. `.fsio` is not among them —
 *  that one is the host's, and creating it here would leave a folder looking
 *  like it had a host in it when it does not (the page and the CLI both
 *  probe for `.fsio` without creating it, for exactly that reason). */
export function ensureState(p: Pewter): void {
  fs.mkdirSync(p.build, { recursive: true });
}
