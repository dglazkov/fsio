// What a new pewter is made of.
//
// Every file in a new pewter is one you can read, change, or delete
// afterwards — that is the whole claim. The files with logic in them
// (package.json, tsconfig.json, .gitignore, AGENTS.md) are written below;
// the extensions are real files under `templates/`, copied verbatim. They
// used to live here as template-literal strings — TypeScript inside
// TypeScript, escaped — which meant the only code a user actually runs was
// the only code no compiler ever saw. As files, CI typechecks them in the
// same shape `pewt check` compiles them in a pewter.
//
// `extensions/repos/` is still the worked example and the proof at once: the
// first screen you see is not part of the product, it is a file in this
// repository, copied.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/** The dependency specs, spelled for this source: `pewt`, `pewter`, and
 *  `pewter-ui` — the shared look the scaffolded extensions import, on the
 *  same rails as the other two.
 *
 *  The branch name IS the package directory name — `#pewt`, `#pewter` — which
 *  is the same convention `ci.yml`'s artifact job is built on. Note the key
 *  names the directory in `node_modules`, not the package: the artifact on
 *  `#pewt` may call itself anything and it still lands at
 *  `node_modules/pewt`, which is why an extension's `import … from "pewter"`
 *  keeps working with no registry name involved. */
export function dependencies(root: string, source: Source): Record<string, string> {
  if (source.kind === "git") {
    return { pewt: `${REPO}#pewt`, pewter: `${REPO}#pewter`, "pewter-ui": `${REPO}#pewter-ui` };
  }
  const spec = (name: string): string => {
    const rel = path.relative(root, path.join(source.path, "packages", name));
    // npm wants a posix path in a spec even on Windows, and `path.relative`
    // hands back the platform separator.
    return `file:${rel.split(path.sep).join("/")}`;
  };
  return { pewt: spec("pewt"), pewter: spec("pewter"), "pewter-ui": spec("pewter-ui") };
}

/** Where the verbatim files live. Two homes, one per shape this package
 *  ships in: `../templates` beside `dist/` in the checkout, `./templates`
 *  beside the bundled `cli.js` on the artifact branch — `make-artifact.mjs`
 *  copies the directory there for exactly this lookup. */
function templatesDir(): string {
  for (const rel of ["../templates", "./templates"]) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (fs.existsSync(path.join(dir, "extensions"))) return dir;
  }
  throw new Error("create-pewt cannot find its templates/ directory — the installed package is broken");
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
        scripts: {
          start: "pewt serve",
          check: "pewt check",
        },
        // The compiler `pewt check` runs, and the one your editor picks up
        // from this folder. It is a real dependency rather than something
        // `pewt` carries, so `git clone && npm i` restores the checker along
        // with everything else and there is only ever one of it.
        devDependencies: {
          typescript: "^7.0.2",
        },
        // The packages a pewter is made of, declared like anything else.
        // `pewt` puts the command line on `node_modules/.bin`, which is what
        // `npm start` above finds; `pewter` is what an extension imports and
        // what typechecks it; `pewter-ui` is the look the scaffolded screens
        // share, which each extension imports as a stylesheet. Being declared
        // is what makes them survive `npm install` — see `Source` for the
        // whole of that story.
        //
        // The xterm pair is the terminal extension's emulator. NARRATIVE.md's
        // claim is that nothing about the terminal is built into the shell —
        // what draws it is an emulator you chose — and this is where the
        // choosing happens: an ordinary dependency of your pewter, like an
        // ACP adapter. `npm rm` both and put another in their place — and
        // `pewter-ui` is swappable the same way.
        dependencies: {
          "@xterm/addon-fit": "^0.10.0",
          "@xterm/xterm": "^5.5.0",
          ...dependencies(root, source),
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
  single file when a tab opens it. There is no plugin API to learn. Three
  are scaffolded: \`repos/\` is the first tab, \`terminal/\` is a shell on
  this machine, and \`agent/\` is a conversation with a coding agent —
  \`pewt tabs add terminal\` or \`pewt tabs add agent\` opens one. Their
  shared look is \`pewter-ui/style.css\`, an ordinary dependency each
  screen imports — restyle a screen by overriding it, or drop the import
  and start from nothing.
- Projects live in \`repos/\`, each its own git repository, and none of them
  are committed here. \`pewt repos create <name>\` starts one, \`pewt repos
  clone <url>\` fetches one, and the Projects screen offers both.
- \`npm run check\` compiles \`extensions/\` and says what is wrong. It needs no
  host and no browser, so it is the signal to use while writing — open a tab
  to see whether a screen is *right*, run this to know whether it *compiles*.

## What is worth committing

This pewter is yours and its history is the record of how it changed. An
extension you wrote, a template you adjusted, a script you added: all of it
is code somebody can read, including you in six months.
`
  );

  // The extensions, copied verbatim from templates/. Real files in the fsio
  // repository — typechecked by CI in the same shape `pewt check` compiles
  // them in a pewter — and real files here, which is the claim: what you are
  // reading in your pewter is exactly what is in that repository, with
  // nothing escaped and nothing generated.
  const templates = templatesDir();
  const copy = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(templates, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) copy(rel);
      else write(rel, fs.readFileSync(path.join(templates, rel), "utf8"));
    }
  };
  copy("extensions");

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
