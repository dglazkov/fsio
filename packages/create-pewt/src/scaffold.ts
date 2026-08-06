// What a new pewter is made of.
//
// Every file here is one you can read, change, or delete afterwards — that is
// the whole claim, so the scaffold stays small enough to read in a sitting.
// `extensions/repos/` is the worked example and the proof at once: the first
// screen you see is not part of the product, it is this file's output.
import fs from "node:fs";
import path from "node:path";

/** Where a pewter gets `pewt` and `pewter` from.
 *
 *  Both spellings are **declared dependencies**, which is the entire point.
 *  These two used to be bare symlinks that `package.json` deliberately did
 *  not mention, and npm prunes anything in `node_modules` that no dependency
 *  declares — so the first `npm install` of any kind deleted them and the
 *  pewter stopped working with no explanation
 *  (https://github.com/dglazkov/fsio/issues/181). npm has no reason to prune
 *  either of these. */
export type Source =
  /** the artifact branches CI builds on every push to main. The default, and
   *  what makes `git clone && npm i` on another machine restore a whole
   *  pewter: the lockfile pins a commit, and the `artifact` job keeps those
   *  commits reachable forever rather than orphaning them. */
  | { kind: "git" }
  /** an fsio checkout, as relative `file:` paths — for working on fsio
   *  itself. npm installs these as symlinks, so an edit in the checkout is
   *  live in the pewter with no reinstall, which is the property the old
   *  arrangement was reaching for and the reason this flag still exists.
   *
   *  Relative rather than absolute: a `file:` dependency is written into a
   *  `package.json` that is in a git repository, and an absolute one would
   *  carry a path to somebody's home directory. Relative costs nothing extra
   *  — it works while the checkout stays where the pewter expects it, which
   *  is exactly as long as a development arrangement is worth anything. */
  | { kind: "checkout"; path: string };

export interface ScaffoldOptions {
  /** where the pewter goes. Created if missing; must be empty if it exists. */
  root: string;
  /** where `pewt` and `pewter` come from. Default: the artifact branches. */
  source?: Source;
}

const REPO = "github:dglazkov/fsio";

/** The two dependency specs, spelled for this source.
 *
 *  The branch name IS the package directory name — `#pewt`, `#pewter` — which
 *  is the same convention `ci.yml`'s artifact job is built on. Note the key
 *  names the directory in `node_modules`, not the package: the artifact on
 *  `#pewt` may call itself anything and it still lands at
 *  `node_modules/pewt`, which is why an extension's `import … from "pewter"`
 *  keeps working with no registry name involved. */
export function dependencies(root: string, source: Source): Record<string, string> {
  if (source.kind === "git") {
    return { pewt: `${REPO}#pewt`, pewter: `${REPO}#pewter` };
  }
  const spec = (name: string): string => {
    const rel = path.relative(root, path.join(source.path, "packages", name));
    // npm wants a posix path in a spec even on Windows, and `path.relative`
    // hands back the platform separator.
    return `file:${rel.split(path.sep).join("/")}`;
  };
  return { pewt: spec("pewt"), pewter: spec("pewter") };
}

export class NotEmpty extends Error {
  constructor(readonly dir: string) {
    super(`${dir} is not empty`);
    this.name = "NotEmpty";
  }
}

/** Write a pewter. Returns the paths written, in the order a reader should
 *  meet them. */
export function scaffold(opts: ScaffoldOptions): string[] {
  const { root, source = { kind: "git" } } = opts;
  if (fs.existsSync(root) && fs.readdirSync(root).length > 0) throw new NotEmpty(root);

  const written: string[] = [];
  const write = (rel: string, body: string): void => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    written.push(rel);
  };

  const name = path.basename(root);

  write(
    "package.json",
    JSON.stringify(
      {
        name,
        private: true,
        type: "module",
        // The field that makes this a pewter. `pewt` walks up from the
        // working directory looking for it, which is how a command typed
        // inside a project still knows which pewter it is in.
        pewter: { version: 1 },
        // `check` is deliberately absent until `pewt check` exists. A
        // scaffold that writes a script for an unbuilt command hands
        // everyone who runs it a usage error as their second experience.
        scripts: {
          start: "pewt serve",
        },
        // The two packages a pewter is made of, declared like anything else.
        // `pewt` puts the command line on `node_modules/.bin`, which is what
        // `npm start` above finds; `pewter` is what an extension imports and
        // what typechecks it. Being declared is what makes them survive
        // `npm install` — see `Source` for the whole of that story.
        dependencies: dependencies(root, source),
      },
      null,
      2
    ) + "\n"
  );

  write(
    "tsconfig.json",
    JSON.stringify(
      {
        // Covers extensions/. Your editor and `pewt check` both use it, so
        // what an agent sees when it compiles is what you see as you type.
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          strict: true,
          noUncheckedIndexedAccess: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["extensions"],
      },
      null,
      2
    ) + "\n"
  );

  write(
    ".gitignore",
    `# Your work. The pewter holds no opinion about it, and this line is why
# you can push a pewter to a public repository without publishing anything
# you have worked on.
repos/

# The channel and this pewter's own state. \`.pewter/\` also holds the answers
# the host remembers (grants.json), which is a second reason it is here: what
# you allowed on your machine is not something a clone of this should inherit.
.fsio/
.pewter/

node_modules/
`
  );

  write(
    "AGENTS.md",
    `# ${name}

This is a pewter: one folder that is a git repository, an npm project, and
the channel between this machine and the Pewter page at once.

## How to work here

- \`pewt\` is the command line, installed in this pewter and not globally.
  Everything the page can do, it does by calling the same operations —
  \`pewt --help\` lists them.
- Screens live in \`extensions/\`. One is a directory with an \`index.html\`
  and a \`main.ts\`; it imports \`pewter\` for the API and is bundled into a
  single file when a tab opens it. There is no plugin API to learn.
- Projects live in \`repos/\`, each its own git repository, and none of them
  are committed here.

## One thing that is not finished

\`pewt check\` — which compiles \`extensions/\` and reports what is wrong before
anything reaches a screen — does not exist yet. It is the feedback signal an
agent writing an extension can run alone, so until it lands the only way to
know a screen works is to open it and look.

## What is worth committing

This pewter is yours and its history is the record of how it changed. An
extension you wrote, a template you adjusted, a script you added: all of it
is code somebody can read, including you in six months.
`
  );

  write(
    "extensions/repos/index.html",
    `<!doctype html>
<meta charset="utf-8" />
<title>Projects</title>
<link rel="stylesheet" href="./style.css" />
<main>
  <header>
    <h1>Projects</h1>
    <p id="note">asking the host…</p>
  </header>
  <ul id="list"></ul>
</main>
<script type="module" src="./main.ts"></script>
`
  );

  write(
    "extensions/repos/style.css",
    `:root { color-scheme: light dark; }
body {
  margin: 0; padding: 2.5rem 2rem;
  font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
  background: light-dark(#f7f5f2, #16161a);
  color: light-dark(#1b1b1f, #e8e6e3);
}
main { max-width: 40rem; margin: 0 auto; }
h1 { font-size: 1.6rem; margin: 0 0 0.2rem; }
#note { margin: 0 0 1.6rem; opacity: 0.6; font-size: 0.85rem; }
ul { list-style: none; margin: 0; padding: 0; }
li {
  display: flex; justify-content: space-between; gap: 1rem;
  padding: 0.6rem 0.2rem;
  border-bottom: 1px solid light-dark(#0001, #fff2);
}
li .kind { opacity: 0.5; font-size: 0.8rem; }
.empty { opacity: 0.7; }
`
  );

  write(
    "extensions/repos/main.ts",
    `// The project list — the first screen a pewter shows.
//
// It is not part of the product. It is this file, in your pewter, and you can
// read it, change it, or delete it. Nothing it uses is private to it: every
// call below has a spelling on the command line too.
import { pewt } from "pewter";

const list = document.getElementById("list")!;
const note = document.getElementById("note")!;

const { repos } = await pewt.repos.list();

if (repos.length === 0) {
  note.textContent = "nothing in repos/ yet";
  const empty = document.createElement("li");
  empty.className = "empty";
  empty.textContent = "A cloned pewter starts this way: your extensions come back, your work does not.";
  list.append(empty);
} else {
  note.textContent = \`\${repos.length} in repos/, read through the folder you granted\`;
  for (const repo of repos) {
    const row = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = repo.name;
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = repo.git ? "git" : "not a git repository";
    row.append(name, kind);
    list.append(row);
  }
}
`
  );

  // `repos/` is git-ignored, so it exists on disk and never in history. The
  // host is happy without it — a pewter with no projects is a normal pewter —
  // but a folder that is not there reads as a mistake to a human looking.
  fs.mkdirSync(path.join(root, "repos"), { recursive: true });

  return written;
}

// `link()` used to live here: it made `node_modules/{pewt,pewter}` and a
// `.bin/pewt` shim by hand, because neither package had published and the
// comment above `ScaffoldOptions` argued a `file:` dependency could not work.
// That argument was wrong — measured in #181 — and the hand-made symlinks
// were the bug: npm prunes what nothing declares, so any `npm install` in a
// pewter deleted both and left no trace of why. Both spellings are ordinary
// declared dependencies now, npm makes the same symlinks for `file:` itself,
// and there is nothing here to keep.
