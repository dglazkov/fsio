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
        //
        // `lit` and its signals are what the scaffolded screens are written
        // in, and they are declared here rather than inside `pewter-ui` on
        // purpose: the kit lists them as *peers*, so there is exactly one
        // copy of lit in a pewter and therefore one in each bundle. Two
        // copies would each register their own custom elements and neither
        // half would react to the other. Declared here, they are also
        // ordinarily yours — a screen imports `lit` directly, and lit's own
        // documentation is about the thing you are actually holding.
        dependencies: {
          "@lit-labs/signals": "^0.1.3",
          "@xterm/addon-fit": "^0.10.0",
          "@xterm/xterm": "^5.5.0",
          lit: "^3.3.0",
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
          // Lit's `static properties` installs accessors on the prototype,
          // and an ES2022 class field would define an own property over the
          // top of them — an element that silently stops reacting. Nothing
          // scaffolded here declares a component, so this is a door held
          // open rather than a door in use: the first one you write works.
          useDefineForClassFields: false,
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
#
# Anchored with a leading slash, and that slash is load-bearing: a bare
# \`repos/\` matches a directory of that name at any depth, which silently
# swallowed \`extensions/repos/\` — the first screen a pewter shows. A clone
# came back with no Projects screen, which is the one thing NARRATIVE.md
# promises a clone does not do.
/repos/

# The channel and this pewter's own state. \`.pewter/\` also holds the answers
# the host remembers (grants.json), which is a second reason it is here: what
# you allowed on your machine is not something a clone of this should inherit.
/.fsio/
/.pewter/

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
  shared look is \`pewter-ui\`, an ordinary dependency with two imports:
  \`import "pewter-ui"\` registers its typed elements — \`<pewter-status>\`,
  \`<pewter-menu>\`, \`<pewter-markdown>\`, \`<pewter-ask>\`,
  \`<pewter-step>\` — and \`import "pewter-ui/style.css"\` is the styles.
  The elements are the kit's API: the package's \`.d.ts\` names its tags,
  so your editor completes them and \`pewt check\` fails a misuse. Before
  styling or building a screen, read \`node_modules/pewter-ui\` — one
  stylesheet and a handful of short modules. Restyle a screen by
  overriding (its own \`style.css\` wins by specificity), or drop the
  imports and start from nothing.
- **Screens are written in lit, and their state is signals.** Both are
  this pewter's own dependencies, so lit's documentation is about the
  thing you are holding. The shape is one description of the screen and
  one place each fact lives:

  \`\`\`ts
  import { html } from "lit";
  import { signal } from "@lit-labs/signals";
  import { screen } from "pewter-ui";

  const repos = signal<Repo[] | null>(null);

  screen(document.body, () => html\`
    <h1>Projects</h1>
    <ul>\${repos.get()?.map((r) => html\`<li>\${r.name}</li>\`)}</ul>
  \`);

  repos.set((await pewt.repos.list()).repos);   // the screen follows
  \`\`\`

  \`screen()\` renders into the light DOM, so \`style.css\` beside it styles
  what you see with ordinary selectors. The kit's own elements are lit
  components with shadow roots — restyle those through the
  \`--pewter-*\` properties or their \`part\` names, both listed at the top
  of \`node_modules/pewter-ui/style.css\`.
- **Text a model wrote goes in \`<pewter-markdown>\`, not in
  \`textContent\`.** An agent answers in markdown, so text put on the page
  as-is reads as \`**the file**\` and a fenced block arrives as three
  backticks. One property, and it is safe to set repeatedly while a turn
  streams:

  \`\`\`ts
  const md = document.createElement("pewter-markdown");
  said.append(md);
  md.text = whatTheAgentHasSaidSoFar;   // again on every chunk
  \`\`\`

  It re-parses each time, and a code fence that has not closed yet renders
  as code rather than as backticks — which is what makes it right for
  streaming rather than only for finished messages.

  **Never build HTML from model output.** This element turns the text into a
  token tree and renders the tree; it never makes an HTML string, and
  \`innerHTML\` on anything an agent wrote would hand a capability to
  whatever the model was quoting. The port your extension holds is the
  capability, and a file an agent summarizes can contain anything.
- **A question goes in \`<pewter-ask>\`, a task in \`<pewter-step>\`.** Both
  take a list of files and a callback for when one is clicked, and that
  callback is where a screen does something no terminal can:

  \`\`\`ts
  ask.paths = ["/Users/you/pewters/dev/repos/site/src/main.ts"];
  ask.onpath = (abs) => void pewt.open(insideThePewter(abs));
  \`\`\`

  The kit deliberately does not do that step for you: \`pewter-ui\` never
  imports \`pewt\`, and a path is not a URL. An agent names files
  **absolutely**, rooted at the directory the host started it in
  (\`agent.info.cwd\`), while \`pewt.open\` takes a path relative to the
  pewter — so strip the one and prepend where it sits, which is
  \`repos/<project>\` or the root. \`extensions/agent/\` does this in
  \`pewterPath()\`; a path that is not under the cwd has no tab to open and
  the honest answer is to leave it as text.

  **The first draw is synchronous.** \`screen()\` renders once before it
  returns, so anything your view calls must already exist — write helpers
  as \`function\` declarations, which hoist, rather than \`const\` arrows,
  which do not. Getting this wrong is a \`TypeError\` on the first draw and
  \`pewt check\` cannot see it, because the ordering is a runtime fact.
  The screen shows the error where it would have drawn, so you are not
  reading a blank pane trying to guess.
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
