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
        // The two packages a pewter is made of, declared like anything else.
        // `pewt` puts the command line on `node_modules/.bin`, which is what
        // `npm start` above finds; `pewter` is what an extension imports and
        // what typechecks it. Being declared is what makes them survive
        // `npm install` — see `Source` for the whole of that story.
        //
        // The xterm pair is the terminal extension's emulator. NARRATIVE.md's
        // claim is that nothing about the terminal is built into the shell —
        // what draws it is an emulator you chose — and this is where the
        // choosing happens: an ordinary dependency of your pewter, like an
        // ACP adapter. `npm rm` both and put another in their place.
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
  single file when a tab opens it. There is no plugin API to learn. Two are
  scaffolded: \`repos/\` is the first tab, and \`terminal/\` is a shell on
  this machine — \`pewt tabs add terminal\` opens one.
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
  <section id="verbs">
    <form id="create">
      <input id="create-name" placeholder="a name" autocomplete="off" spellcheck="false" />
      <button>New project</button>
    </form>
    <form id="clone">
      <input id="clone-url" placeholder="https://… or git@… or a path" autocomplete="off" spellcheck="false" />
      <button>Clone</button>
    </form>
  </section>
  <p id="error" hidden></p>
  <pre id="progress" hidden></pre>
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
li .branch { font-style: normal; opacity: 0.5; font-size: 0.8rem; margin-left: 0.5rem; }
li .verbs { display: flex; gap: 0.35rem; flex-wrap: wrap; justify-content: flex-end; }
li .verbs button {
  font: inherit; font-size: 0.75rem; padding: 0.15rem 0.55rem; cursor: pointer;
  border-radius: 5px; border: 1px solid light-dark(#0003, #fff3);
  background: transparent; color: inherit;
}
li .verbs button:disabled { opacity: 0.5; cursor: default; }
li .verbs button.install { border-style: dashed; }
.empty { opacity: 0.7; }
#verbs { display: flex; flex-wrap: wrap; gap: 0.8rem; margin-top: 1.6rem; }
#verbs form { display: flex; gap: 0.4rem; flex: 1; min-width: 14rem; }
#verbs input {
  flex: 1; min-width: 0; font: inherit; padding: 0.35rem 0.6rem;
  border-radius: 6px; border: 1px solid light-dark(#0003, #fff3);
  background: transparent; color: inherit;
}
#verbs button {
  font: inherit; font-size: 0.85rem; padding: 0.35rem 0.8rem; cursor: pointer;
  border-radius: 6px; border: 1px solid light-dark(#0004, #fff4);
  background: light-dark(#fff, #222228); color: inherit; white-space: nowrap;
}
#verbs button:disabled, #verbs input:disabled { opacity: 0.5; cursor: default; }
#error { color: light-dark(#a3372e, #ff8f85); font-size: 0.85rem; white-space: pre-wrap; }
#progress {
  margin-top: 1rem; padding: 0.8rem 1rem; max-height: 14rem; overflow-y: auto;
  font-size: 0.8rem; line-height: 1.5; white-space: pre-wrap; word-break: break-all;
  border-radius: 8px; background: light-dark(#0000000d, #ffffff0d);
}
`
  );

  write(
    "extensions/repos/main.ts",
    `// The project list — the first screen a pewter shows.
//
// It is not part of the product. It is this file, in your pewter, and you can
// read it, change it, or delete it. Nothing it uses is private to it: every
// call below has a spelling on the command line too — \`pewt repos\`,
// \`pewt repos create <name>\`, \`pewt repos clone <url>\`.
import { pewt, PewtError } from "pewter";

const list = document.getElementById("list")!;
const note = document.getElementById("note")!;
const error = document.getElementById("error")!;
const progress = document.getElementById("progress")!;
const createForm = document.getElementById("create") as HTMLFormElement;
const createName = document.getElementById("create-name") as HTMLInputElement;
const cloneForm = document.getElementById("clone") as HTMLFormElement;
const cloneUrl = document.getElementById("clone-url") as HTMLInputElement;

async function refresh(): Promise<void> {
  const { repos } = await pewt.repos.list();
  list.replaceChildren();
  if (repos.length === 0) {
    note.textContent = "nothing in repos/ yet";
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No projects yet — start one, or clone one, below.";
    list.append(empty);
    return;
  }
  note.textContent = \`\${repos.length} in repos/, read through the folder you granted\`;
  for (const repo of repos) {
    const row = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = repo.name;
    if (repo.branch) {
      const branch = document.createElement("em");
      branch.className = "branch";
      branch.textContent = repo.branch;
      name.append(branch);
    }
    row.append(name);
    // The row's verbs: this project's own scripts, each one click from
    // running. The set is the project's package.json, not anything this
    // screen invents — an extension cannot make a script runnable by
    // drawing a button for it. \`install\` leads when node_modules is
    // missing (every fresh clone), because the scripts will not run
    // without it — and unlike clone, install is asked about (#193).
    if (repo.scripts.length > 0 || repo.installed === false) {
      const verbs = document.createElement("span");
      verbs.className = "verbs";
      if (repo.installed === false) {
        const install = document.createElement("button");
        install.className = "install";
        install.textContent = "install";
        install.addEventListener("click", () => installRepo(repo.name));
        verbs.append(install);
      }
      for (const script of repo.scripts) {
        const verb = document.createElement("button");
        verb.textContent = script;
        verb.addEventListener("click", () => runScript(repo.name, script));
        verbs.append(verb);
      }
      row.append(verbs);
    } else {
      const kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = repo.git ? "no scripts" : "not a git repository";
      row.append(kind);
    }
    list.append(row);
  }
}

/** \`npm install\`, asked first: it runs lifecycle scripts, which makes it
 *  the first execution of what a clone fetched. The question rides the run
 *  rung, so \`--allow-runs\` or a standing \`run/<project>\` grant covers it. */
function installRepo(repo: string): void {
  error.hidden = true;
  progress.textContent = \`npm install — in \${repo}\\n\`;
  progress.hidden = false;
  busy(true);
  const waiting = setTimeout(() => {
    progress.append("(waiting — the host asks on its own terminal before it starts anything)\\n");
  }, 1200);
  pewt.repos
    .install(repo, {
      onOutput: (line) => {
        clearTimeout(waiting);
        progress.append(line + "\\n");
        progress.scrollTop = progress.scrollHeight;
      },
    })
    .then(async ({ exitCode }) => {
      progress.append(\`\\nexit \${exitCode ?? "?"}\\n\`);
      if (exitCode === 0) await refresh();
    })
    .catch(complain)
    .finally(() => {
      clearTimeout(waiting);
      busy(false);
    });
}

/** Run one script, output streaming into the shared pane. The host asks a
 *  human at its own terminal before starting anything, so the call can sit
 *  a while — the pane says so rather than looking hung — and a refusal is a
 *  normal outcome that arrives in the operation's own words. */
function runScript(repo: string, script: string): void {
  error.hidden = true;
  progress.textContent = \`npm run \${script} — in \${repo}\\n\`;
  progress.hidden = false;
  busy(true);
  const waiting = setTimeout(() => {
    progress.append("(waiting — the host asks on its own terminal before it starts anything)\\n");
  }, 1200);
  pewt
    .run(script, {
      repo,
      onOutput: (line) => {
        clearTimeout(waiting);
        progress.append(line + "\\n");
        progress.scrollTop = progress.scrollHeight;
      },
    })
    .then(({ exitCode }) => progress.append(\`\\nexit \${exitCode ?? "?"}\\n\`))
    .catch(complain)
    .finally(() => {
      clearTimeout(waiting);
      busy(false);
    });
}

/** A refusal, in the operation's own words — the code and hint travel with
 *  the error, so this screen never has to guess what went wrong. */
function complain(e: unknown): void {
  const known = e instanceof PewtError ? e : null;
  error.textContent = known ? known.message + (known.hint ? \`\\n\${known.hint}\` : "") : String(e);
  error.hidden = false;
}

/** One thing runs at a time on this screen, and the screen says so: every
 *  button and field on it, including the row verbs, goes quiet together. */
const busy = (on: boolean): void => {
  for (const el of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")) el.disabled = on;
};

createForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = createName.value.trim();
  if (!name) return;
  error.hidden = true;
  busy(true);
  pewt.repos
    .create({ name })
    .then(async () => {
      createName.value = "";
      await refresh();
    })
    .catch(complain)
    .finally(() => busy(false));
});

cloneForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const url = cloneUrl.value.trim();
  if (!url) return;
  error.hidden = true;
  progress.textContent = \`git clone \${url}\\n\`;
  progress.hidden = false;
  busy(true);
  pewt.repos
    // git's own lines, throttled by the host. Everything it says — progress
    // included — arrives on "err", which is git's convention, not a failure.
    .clone(url, {
      onOutput: (line) => {
        progress.append(line + "\\n");
        progress.scrollTop = progress.scrollHeight;
      },
    })
    .then(async ({ exitCode }) => {
      if (exitCode === 0) {
        cloneUrl.value = "";
        progress.hidden = true;
        await refresh();
      } else {
        // The reason is already on screen in git's words; this line says how
        // it ended. A failed clone leaves nothing behind.
        progress.append(\`\\nclone failed (exit \${exitCode ?? "?"})\\n\`);
      }
    })
    .catch(complain)
    .finally(() => busy(false));
});

await refresh();
`
  );

  write(
    "extensions/env.d.ts",
    `// Imported stylesheets are real to the build and unknown to the checker.
//
// The terminal extension writes \`import "@xterm/xterm/css/xterm.css"\`:
// esbuild collects the CSS and the host inlines it into the tab's one file,
// but tsc has no idea what importing a stylesheet means. This line tells
// \`pewt check\` and your editor what the build already knows, for every
// extension in this folder.
declare module "*.css";
`
  );

  write(
    "extensions/terminal/index.html",
    `<!doctype html>
<meta charset="utf-8" />
<title>Terminal</title>
<link rel="stylesheet" href="./style.css" />
<p id="status" hidden><span id="said"></span><button id="again" hidden>new shell</button></p>
<section id="picker">
  <h1>Terminal</h1>
  <p id="note">asking the host…</p>
  <ul id="places"></ul>
</section>
<div id="term" hidden></div>
<script type="module" src="./main.ts"></script>
`
  );

  write(
    "extensions/terminal/style.css",
    `:root { color-scheme: light dark; }
html, body { height: 100%; }
body {
  margin: 0; display: flex; flex-direction: column;
  font: 15px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
  background: light-dark(#f7f5f2, #16161a);
  color: light-dark(#1b1b1f, #e8e6e3);
}
#status { margin: 0; padding: 0.5rem 1rem; font-size: 0.85rem; opacity: 0.75; white-space: pre-wrap; }
#status button {
  font: inherit; font-size: 0.8rem; margin-left: 0.6rem; padding: 0.1rem 0.6rem; cursor: pointer;
  border-radius: 5px; border: 1px solid light-dark(#0003, #fff3);
  background: transparent; color: inherit;
}
#picker { width: 100%; max-width: 40rem; margin: 0 auto; padding: 2.5rem 2rem; box-sizing: border-box; }
#picker h1 { font-size: 1.6rem; margin: 0 0 0.2rem; }
#note { margin: 0 0 1.6rem; opacity: 0.6; font-size: 0.85rem; }
#places { list-style: none; margin: 0; padding: 0; }
#places li { border-bottom: 1px solid light-dark(#0001, #fff2); }
#places button {
  font: inherit; width: 100%; text-align: left; padding: 0.6rem 0.2rem; cursor: pointer;
  border: none; background: transparent; color: inherit;
}
#places button:hover { background: light-dark(#0000000d, #ffffff0d); }
/* The terminal takes everything under the status line, on the same slab the
   theme in main.ts is set against — it does not invert with the page,
   because a terminal that flips colours under running output is worse than
   one that commits. The padding goes on .xterm rather than on this box: the
   fit addon measures the box and reads the padding off .xterm itself, so
   this is the arrangement it sizes correctly. */
#term { flex: 1; min-height: 0; background: #17191c; }
#term .xterm { padding: 0.65rem 0.8rem; }
`
  );

  write(
    "extensions/terminal/main.ts",
    `// A shell on this machine, in a tab.
//
// What \`pewt.shell()\` hands over is live and raw: the pty's own bytes,
// escape sequences included, with keystrokes and window sizes going back the
// other way. The host holds no opinion about what draws them — the emulator
// here is xterm, an ordinary dependency of this pewter, and swapping it for
// another touches nothing outside this directory.
//
// One tab is one shell. For a second one, open another tab:
// \`pewt tabs add terminal\`.
import { pewt, PewtError } from "pewter";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const status = document.getElementById("status")!;
const said = document.getElementById("said")!;
const again = document.getElementById("again") as HTMLButtonElement;
const picker = document.getElementById("picker")!;
const note = document.getElementById("note")!;
const places = document.getElementById("places")!;
const host = document.getElementById("term")!;

/** xterm takes concrete colours, not custom properties, so the palette is
 *  spelled out — and it is yours: this file is in your pewter. The sixteen
 *  ANSI colours are muted rather than the VGA defaults, which arrive as
 *  saturated primaries the moment anything colours its output. */
const THEME = {
  background: "#17191c",
  foreground: "#d6dbdf",
  cursor: "#d6dbdf",
  cursorAccent: "#17191c",
  selectionBackground: "#3f6f7859",

  black: "#1f2328",
  red: "#c97d79",
  green: "#93b899",
  yellow: "#dcba76",
  blue: "#8098ab",
  magenta: "#b294bb",
  cyan: "#8fbfc7",
  white: "#d6dbdf",

  brightBlack: "#5b656d",
  brightRed: "#e79a96",
  brightGreen: "#aecfb3",
  brightYellow: "#ecd49b",
  brightBlue: "#a2b6c6",
  brightMagenta: "#c9aed1",
  brightCyan: "#aed6dc",
  brightWhite: "#eceff1",
};

/** Where a shell can start: the pewter itself, or a project under \`repos/\`.
 *  Asked fresh every time the picker shows, so a project cloned since the
 *  last shell is on the list. */
async function offer(): Promise<void> {
  host.hidden = true;
  picker.hidden = false;
  places.replaceChildren();
  note.textContent = "asking the host…";
  try {
    const { repos } = await pewt.repos.list();
    note.textContent = "a shell is your own account on this machine — the host asks before it opens one";
    for (const where of [null, ...repos.map((r) => r.name)]) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.textContent = where ?? "this pewter";
      button.addEventListener("click", () => void open(where));
      row.append(button);
      places.append(row);
    }
  } catch (e) {
    note.textContent = words(e);
  }
}

/** One shell, for as long as it runs. The tab is the terminal while it does,
 *  and the picker comes back when it ends, under the code it ended on. */
async function open(repo: string | null): Promise<void> {
  picker.hidden = true;
  host.hidden = false;
  again.hidden = true;
  // The emulator first and fitted first, so the pty is born at the size the
  // tab actually has rather than resized into it a moment later.
  const term = new Terminal({
    fontSize: 13,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    theme: THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host as HTMLElement);
  fit.fit();
  say("waiting — the host asks on its own terminal before it opens a shell");
  try {
    const shell = await pewt.shell({
      ...(repo ? { repo } : {}),
      cols: term.cols,
      rows: term.rows,
      onData: (bytes) => term.write(bytes),
    });
    status.hidden = true;
    term.onData((keys) => shell.write(keys));
    // The tab's size is the pty's size. A 0×0 box is skipped — a tab that is
    // not on screen has one, and the fit addon would propose garbage for it.
    const watch = new ResizeObserver(() => {
      if (host.offsetWidth === 0 || host.offsetHeight === 0) return;
      fit.fit();
      shell.resize(term.cols, term.rows);
    });
    watch.observe(host);
    term.focus();
    const code = await shell.exit;
    watch.disconnect();
    // What the shell printed before it ended is often the reason it ended,
    // so the terminal stays on screen — dead but readable — until you ask
    // for the next one.
    say(code === null ? "the shell ended without an exit code — a signal, or the host went away" : \`the shell ended — exit \${code}\`);
    again.hidden = false;
    again.onclick = () => {
      again.hidden = true;
      term.dispose();
      void offer();
    };
  } catch (e) {
    // A refusal is a normal ending: the human at the host's terminal said
    // no, or there is no host. It arrives in the operation's own words —
    // and a shell that never started leaves nothing on screen worth
    // keeping, so the picker comes straight back under the reason.
    say(words(e));
    term.dispose();
    await offer();
  }
}

function say(text: string): void {
  said.textContent = text;
  status.hidden = false;
}

const words = (e: unknown): string =>
  e instanceof PewtError ? e.message + (e.hint ? \`\\n\${e.hint}\` : "") : String(e);

await offer();
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
