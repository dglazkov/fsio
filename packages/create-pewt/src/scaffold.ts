// What a new pewter is made of.
//
// Every file here is one you can read, change, or delete afterwards — that is
// the whole claim, so the scaffold stays small enough to read in a sitting.
// `extensions/repos/` is the worked example and the proof at once: the first
// screen you see is not part of the product, it is this file's output.
import fs from "node:fs";
import path from "node:path";

export interface ScaffoldOptions {
  /** where the pewter goes. Created if missing; must be empty if it exists. */
  root: string;
  /** the fsio checkout `pewt` and `pewter` are linked from.
   *
   *  A pewter is supposed to depend on two ordinary packages, and one day it
   *  will: `npm i pewt pewter`, pinned in the lockfile, restored by `git
   *  clone && npm i` on another machine. Neither is published yet, and a
   *  `file:` dependency on a workspace package does not work either — npm
   *  would go looking for that package's own `@fsio/*` siblings, which are
   *  private and unpublished too.
   *
   *  So `link()` below puts them in `node_modules` directly. That is a
   *  development arrangement, it is stated in the pewter's own AGENTS.md,
   *  and it is deliberately not written into `package.json`: a dependency
   *  npm cannot install is worse than no dependency, and this file is in
   *  somebody's git history. */
  link: string;
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
  const { root } = opts;
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

## Two things that are not finished

\`pewt\` and \`pewter\` are linked into \`node_modules\` from an fsio checkout
rather than installed from a registry, because neither has published yet.
That means this pewter does not restore with \`git clone && npm i\` the way
the documentation describes — it needs the checkout too. When those packages
publish, \`npm i pewt pewter\` replaces the links and nothing else changes.

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

/** Put `pewt` and `pewter` where a pewter expects to find them.
 *
 *  Symlinks rather than copies, so editing the checkout changes the pewter
 *  immediately — which is the point of a development arrangement. Node
 *  resolves a module's own imports from its real path, so `pewt` finds its
 *  `@fsio/*` siblings in the checkout's `node_modules` exactly as it does
 *  when run from there.
 *
 *  Returns what it linked, or throws if the checkout has not been built:
 *  linking a `dist/` that does not exist yet produces a pewter whose
 *  `npm start` fails with a module-not-found, which is a confusing first
 *  five minutes. */
export function link(root: string, checkout: string): string[] {
  const modules = path.join(root, "node_modules");
  const bin = path.join(modules, ".bin");
  fs.mkdirSync(bin, { recursive: true });

  const cli = path.join(checkout, "packages/pewt/dist/cli.js");
  if (!fs.existsSync(cli)) {
    throw new Error(`${checkout} has not been built (no packages/pewt/dist) — run \`npm run build\` there first`);
  }

  const linked: string[] = [];
  for (const name of ["pewt", "pewter"]) {
    const at = path.join(modules, name);
    fs.rmSync(at, { recursive: true, force: true });
    fs.symlinkSync(path.join(checkout, "packages", name), at, "dir");
    linked.push(`node_modules/${name}`);
  }
  const shim = path.join(bin, "pewt");
  fs.rmSync(shim, { force: true });
  fs.symlinkSync(path.join("..", "pewt", "dist", "cli.js"), shim);
  fs.chmodSync(cli, 0o755);
  linked.push("node_modules/.bin/pewt");
  return linked;
}
