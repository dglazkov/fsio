#!/usr/bin/env node
// create-pewt — generated bundle; source: packages/create-pewt (github.com/dglazkov/fsio)

// dist/cli.js
import { spawnSync } from "node:child_process";
import fs2 from "node:fs";
import path2 from "node:path";

// dist/scaffold.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
var REPO = "github:dglazkov/fsio";
function dependencies(root2, source2) {
  if (source2.kind === "git") {
    return { pewt: `${REPO}#pewt`, pewter: `${REPO}#pewter`, "pewter-ui": `${REPO}#pewter-ui` };
  }
  const spec = (name) => {
    const rel = path.relative(root2, path.join(source2.path, "packages", name));
    return `file:${rel.split(path.sep).join("/")}`;
  };
  return { pewt: spec("pewt"), pewter: spec("pewter"), "pewter-ui": spec("pewter-ui") };
}
function templatesDir() {
  for (const rel of ["../templates", "./templates"]) {
    const dir2 = fileURLToPath(new URL(rel, import.meta.url));
    if (fs.existsSync(path.join(dir2, "extensions")))
      return dir2;
  }
  throw new Error("create-pewt cannot find its templates/ directory \u2014 the installed package is broken");
}
var NotEmpty = class extends Error {
  dir;
  constructor(dir2) {
    super(`${dir2} is not empty`);
    this.dir = dir2;
    this.name = "NotEmpty";
  }
};
function scaffold(opts) {
  const { root: root2, source: source2 = { kind: "git" } } = opts;
  if (fs.existsSync(root2) && fs.readdirSync(root2).length > 0)
    throw new NotEmpty(root2);
  const written2 = [];
  const write = (rel, body) => {
    const file = path.join(root2, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    written2.push(rel);
  };
  const name = path.basename(root2);
  write("package.json", JSON.stringify({
    name,
    private: true,
    type: "module",
    // The field that makes this a pewter. `pewt` walks up from the
    // working directory looking for it, which is how a command typed
    // inside a project still knows which pewter it is in.
    pewter: { version: 1 },
    scripts: {
      start: "pewt serve",
      check: "pewt check"
    },
    // The compiler `pewt check` runs, and the one your editor picks up
    // from this folder. It is a real dependency rather than something
    // `pewt` carries, so `git clone && npm i` restores the checker along
    // with everything else and there is only ever one of it.
    devDependencies: {
      typescript: "^7.0.2"
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
      ...dependencies(root2, source2)
    }
  }, null, 2) + "\n");
  write("tsconfig.json", JSON.stringify({
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
      useDefineForClassFields: false
    },
    include: ["extensions"]
  }, null, 2) + "\n");
  write(".gitignore", `# Your work. The pewter holds no opinion about it, and this line is why
# you can push a pewter to a public repository without publishing anything
# you have worked on.
repos/

# The channel and this pewter's own state. \`.pewter/\` also holds the answers
# the host remembers (grants.json), which is a second reason it is here: what
# you allowed on your machine is not something a clone of this should inherit.
.fsio/
.pewter/

node_modules/
`);
  write("AGENTS.md", `# ${name}

This is a pewter: one folder that is a git repository, an npm project, and
the channel between this machine and the Pewter page at once.

## How to work here

- \`pewt\` is the command line, installed in this pewter and not globally.
  Everything the page can do, it does by calling the same operations \u2014
  \`pewt --help\` lists them.
- Screens live in \`extensions/\`. One is a directory with an \`index.html\`
  and a \`main.ts\`; it imports \`pewter\` for the API and is bundled into a
  single file when a tab opens it. There is no plugin API to learn. Three
  are scaffolded: \`repos/\` is the first tab, \`terminal/\` is a shell on
  this machine, and \`agent/\` is a conversation with a coding agent \u2014
  \`pewt tabs add terminal\` or \`pewt tabs add agent\` opens one. Their
  shared look is \`pewter-ui\`, an ordinary dependency with two imports:
  \`import "pewter-ui"\` registers its typed elements \u2014 \`<pewter-status>\`,
  \`<pewter-menu>\` \u2014 and \`import "pewter-ui/style.css"\` is the styles.
  The elements are the kit's API: the package's \`.d.ts\` names its tags,
  so your editor completes them and \`pewt check\` fails a misuse. Before
  styling or building a screen, read \`node_modules/pewter-ui\` \u2014 one
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
  components with shadow roots \u2014 restyle those through the
  \`--pewter-*\` properties or their \`part\` names, both listed at the top
  of \`node_modules/pewter-ui/style.css\`.
- Projects live in \`repos/\`, each its own git repository, and none of them
  are committed here. \`pewt repos create <name>\` starts one, \`pewt repos
  clone <url>\` fetches one, and the Projects screen offers both.
- \`npm run check\` compiles \`extensions/\` and says what is wrong. It needs no
  host and no browser, so it is the signal to use while writing \u2014 open a tab
  to see whether a screen is *right*, run this to know whether it *compiles*.

## What is worth committing

This pewter is yours and its history is the record of how it changed. An
extension you wrote, a template you adjusted, a script you added: all of it
is code somebody can read, including you in six months.
`);
  const templates = templatesDir();
  const copy = (dir2) => {
    for (const entry of fs.readdirSync(path.join(templates, dir2), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = `${dir2}/${entry.name}`;
      if (entry.isDirectory())
        copy(rel);
      else
        write(rel, fs.readFileSync(path.join(templates, rel), "utf8"));
    }
  };
  copy("extensions");
  fs.mkdirSync(path.join(root2, "repos"), { recursive: true });
  return written2;
}

// dist/cli.js
var USAGE = `usage: create-pewt <dir> [--no-install] [--no-git] [--link <path>]

  <dir>          where the pewter goes. Created if missing; must be empty.
  --no-install   write the files and stop, without running npm install
  --no-git       do not make it a git repository
  --link <path>  depend on an fsio checkout instead of the published
                 artifacts, for working on fsio itself`;
var argv = process.argv.slice(2);
var dir = null;
var install = true;
var git = true;
var source = { kind: "git" };
var fail = (msg) => {
  console.error(`create-pewt: ${msg}

${USAGE}`);
  process.exit(2);
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--help" || a === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else if (a === "--no-install")
    install = false;
  else if (a === "--no-git")
    git = false;
  else if (a === "--link")
    source = { kind: "checkout", path: path2.resolve(argv[++i] ?? fail("--link needs a path")) };
  else if (a.startsWith("--link="))
    source = { kind: "checkout", path: path2.resolve(a.slice("--link=".length)) };
  else if (a.startsWith("-"))
    fail(`unknown flag ${a}`);
  else if (dir)
    fail("one directory, please");
  else
    dir = a;
}
if (!dir)
  fail("which directory should the pewter go in?");
var root = path2.resolve(dir);
if (source.kind === "checkout" && !fs2.existsSync(path2.join(source.path, "packages/pewt"))) {
  fail(`--link ${source.path} does not look like an fsio checkout (no packages/pewt in it)`);
}
var written;
try {
  written = scaffold({ root, source });
} catch (e) {
  if (e instanceof NotEmpty) {
    fail(`${e.dir} already has things in it. A pewter starts empty, so this would be a merge rather than a start.`);
  }
  throw e;
}
console.log(`
pewter \xB7 ${root}
`);
for (const file of written)
  console.log(`  ${file}`);
console.log("  repos/");
if (git) {
  const r = spawnSync("git", ["init", "--quiet"], { cwd: root, stdio: "inherit" });
  console.log(r.status === 0 ? "\n  git initialized \u2014 nothing committed yet" : "\n  git init failed; the pewter is fine without it");
}
if (install) {
  const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`
create-pewt: npm install failed in ${root}.`);
    console.error("The files are written and they are correct \u2014 run `npm install` there yourself when you know why.");
    process.exit(1);
  }
}
console.log(`
Next:

  cd ${root}
  ${install ? "npm start" : "npm install && npm start"}

That runs \`pewt serve\`, which opens the page and waits. The last step is
yours: pick this folder in the browser and allow it. Picking and allowing are
gestures only Chrome can offer, and they are what stops the page from
reaching anything you did not choose.
`);
