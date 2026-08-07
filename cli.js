#!/usr/bin/env node
// create-pewt — generated bundle; source: packages/create-pewt (github.com/dglazkov/fsio)

// dist/cli.js
import { spawnSync } from "node:child_process";
import fs2 from "node:fs";
import path2 from "node:path";

// dist/scaffold.js
import fs from "node:fs";
import path from "node:path";
var REPO = "github:dglazkov/fsio";
function dependencies(root2, source2) {
  if (source2.kind === "git") {
    return { pewt: `${REPO}#pewt`, pewter: `${REPO}#pewter` };
  }
  const spec = (name) => {
    const rel = path.relative(root2, path.join(source2.path, "packages", name));
    return `file:${rel.split(path.sep).join("/")}`;
  };
  return { pewt: spec("pewt"), pewter: spec("pewter") };
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
      skipLibCheck: true
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
  this machine, and \`chat/\` is a conversation with a coding agent \u2014
  \`pewt tabs add terminal\` or \`pewt tabs add chat\` opens one.
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
  write("extensions/repos/index.html", `<!doctype html>
<meta charset="utf-8" />
<title>Projects</title>
<link rel="stylesheet" href="./style.css" />
<main>
  <header>
    <h1>Projects</h1>
    <p id="note">asking the host\u2026</p>
  </header>
  <ul id="list"></ul>
  <section id="verbs">
    <form id="create">
      <input id="create-name" placeholder="a name" autocomplete="off" spellcheck="false" />
      <button>New project</button>
    </form>
    <form id="clone">
      <input id="clone-url" placeholder="https://\u2026 or git@\u2026 or a path" autocomplete="off" spellcheck="false" />
      <button>Clone</button>
    </form>
  </section>
  <p id="error" hidden></p>
  <pre id="progress" hidden></pre>
</main>
<script type="module" src="./main.ts"></script>
`);
  write("extensions/repos/style.css", `:root { color-scheme: light dark; }
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
`);
  write("extensions/repos/main.ts", `// The project list \u2014 the first screen a pewter shows.
//
// It is not part of the product. It is this file, in your pewter, and you can
// read it, change it, or delete it. Nothing it uses is private to it: every
// call below has a spelling on the command line too \u2014 \`pewt repos\`,
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
    empty.textContent = "No projects yet \u2014 start one, or clone one, below.";
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
    if (!repo.git) {
      const kind = document.createElement("em");
      kind.className = "branch";
      kind.textContent = "not a git repository";
      name.append(kind);
    }
    row.append(name);
    // The row's verbs. \`shell\` and \`agent\` are on every row (#198): each
    // opens its extension pointed here, and the host asks before the shell
    // or agent itself exists \u2014 the argument opens a screen, not a process. The
    // scripts are this project's own \`package.json\`, not anything this
    // screen invents \u2014 an extension cannot make a script runnable by
    // drawing a button for it. \`install\` leads when node_modules is
    // missing (every fresh clone), because the scripts will not run
    // without it \u2014 and unlike clone, install is asked about (#193).
    const verbs = document.createElement("span");
    verbs.className = "verbs";
    if (repo.installed === false) {
      const install = document.createElement("button");
      install.className = "install";
      install.textContent = "install";
      install.addEventListener("click", () => installRepo(repo.name));
      verbs.append(install);
    }
    const shell = document.createElement("button");
    shell.textContent = "shell";
    shell.addEventListener("click", () => openShell(repo.name));
    verbs.append(shell);
    const agent = document.createElement("button");
    agent.textContent = "agent";
    agent.addEventListener("click", () => openAgent(repo.name));
    verbs.append(agent);
    for (const script of repo.scripts) {
      const verb = document.createElement("button");
      verb.textContent = script;
      verb.addEventListener("click", () => runScript(repo.name, script));
      verbs.append(verb);
    }
    row.append(verbs);
    list.append(row);
  }
}

/** Open the terminal extension in a new tab, pointed at this project. The
 *  tab opens with \`{repo}\` (#198) \u2014 an argument to a screen, not a grant:
 *  the host still asks before the shell itself starts. */
function openShell(repo: string): void {
  error.hidden = true;
  pewt.tabs.add({ name: "terminal", title: repo, args: { repo } }).catch(complain);
}

/** Open the chat extension in a new tab, pointed at this project. The same
 *  arrangement as the shell verb: the argument opens a screen, not a
 *  process \u2014 the host asks before the agent itself starts. */
function openAgent(repo: string): void {
  error.hidden = true;
  pewt.tabs.add({ name: "chat", title: repo, args: { repo } }).catch(complain);
}

/** \`npm install\`, asked first: it runs lifecycle scripts, which makes it
 *  the first execution of what a clone fetched. The question rides the run
 *  rung, so \`--allow-runs\` or a standing \`run/<project>\` grant covers it. */
function installRepo(repo: string): void {
  error.hidden = true;
  progress.textContent = \`npm install \u2014 in \${repo}\\n\`;
  progress.hidden = false;
  busy(true);
  const waiting = setTimeout(() => {
    progress.append("(waiting \u2014 the host asks on its own terminal before it starts anything)\\n");
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
 *  a while \u2014 the pane says so rather than looking hung \u2014 and a refusal is a
 *  normal outcome that arrives in the operation's own words. */
function runScript(repo: string, script: string): void {
  error.hidden = true;
  progress.textContent = \`npm run \${script} \u2014 in \${repo}\\n\`;
  progress.hidden = false;
  busy(true);
  const waiting = setTimeout(() => {
    progress.append("(waiting \u2014 the host asks on its own terminal before it starts anything)\\n");
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

/** A refusal, in the operation's own words \u2014 the code and hint travel with
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
    // git's own lines, throttled by the host. Everything it says \u2014 progress
    // included \u2014 arrives on "err", which is git's convention, not a failure.
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
`);
  write("extensions/env.d.ts", `// Imported stylesheets are real to the build and unknown to the checker.
//
// The terminal extension writes \`import "@xterm/xterm/css/xterm.css"\`:
// esbuild collects the CSS and the host inlines it into the tab's one file,
// but tsc has no idea what importing a stylesheet means. This line tells
// \`pewt check\` and your editor what the build already knows, for every
// extension in this folder.
declare module "*.css";
`);
  write("extensions/terminal/index.html", `<!doctype html>
<meta charset="utf-8" />
<title>Terminal</title>
<link rel="stylesheet" href="./style.css" />
<p id="status" hidden><span id="said"></span><button id="again" hidden>new shell</button></p>
<section id="picker">
  <h1>Terminal</h1>
  <p id="note">asking the host\u2026</p>
  <ul id="places"></ul>
</section>
<div id="term" hidden></div>
<script type="module" src="./main.ts"></script>
`);
  write("extensions/terminal/style.css", `:root { color-scheme: light dark; }
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
   theme in main.ts is set against \u2014 it does not invert with the page,
   because a terminal that flips colours under running output is worse than
   one that commits. The padding goes on .xterm rather than on this box: the
   fit addon measures the box and reads the padding off .xterm itself, so
   this is the arrangement it sizes correctly. */
#term { flex: 1; min-height: 0; background: #17191c; }
#term .xterm { padding: 0.65rem 0.8rem; }
`);
  write("extensions/terminal/main.ts", `// A shell on this machine, in a tab.
//
// What \`pewt.shell()\` hands over is live and raw: the pty's own bytes,
// escape sequences included, with keystrokes and window sizes going back the
// other way. The host holds no opinion about what draws them \u2014 the emulator
// here is xterm, an ordinary dependency of this pewter, and swapping it for
// another touches nothing outside this directory.
//
// One tab is one shell. For a second one, open another tab:
// \`pewt tabs add terminal\`.
import { pewt, args, PewtError } from "pewter";
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
 *  spelled out \u2014 and it is yours: this file is in your pewter. The sixteen
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
  note.textContent = "asking the host\u2026";
  try {
    const { repos } = await pewt.repos.list();
    note.textContent = "a shell is your own account on this machine \u2014 the host asks before it opens one";
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
  say("waiting \u2014 the host asks on its own terminal before it opens a shell");
  try {
    const shell = await pewt.shell({
      ...(repo ? { repo } : {}),
      cols: term.cols,
      rows: term.rows,
      onData: (bytes) => term.write(bytes),
    });
    status.hidden = true;
    term.onData((keys) => shell.write(keys));
    // The tab's size is the pty's size. A 0\xD70 box is skipped \u2014 a tab that is
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
    // so the terminal stays on screen \u2014 dead but readable \u2014 until you ask
    // for the next one.
    say(code === null ? "the shell ended without an exit code \u2014 a signal, or the host went away" : \`the shell ended \u2014 exit \${code}\`);
    again.hidden = false;
    again.onclick = () => {
      again.hidden = true;
      term.dispose();
      void offer();
    };
  } catch (e) {
    // A refusal is a normal ending: the human at the host's terminal said
    // no, or there is no host. It arrives in the operation's own words \u2014
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

// Opened with \`{repo}\` \u2014 the repos row's shell verb (#198) \u2014 this screen
// skips its picker and goes straight there. Opened bare, it offers the
// choice. Either way the host asks before anything starts: the argument
// opened a screen, not a process.
const openedWith = (await args) as { repo?: unknown } | undefined;
if (openedWith && typeof openedWith.repo === "string") {
  await open(openedWith.repo);
} else {
  await offer();
}
`);
  write("extensions/chat/index.html", `<!doctype html>
<meta charset="utf-8" />
<title>Chat</title>
<link rel="stylesheet" href="./style.css" />
<p id="status" hidden><span id="said"></span><button id="again" hidden>new conversation</button></p>
<section id="picker">
  <h1>Chat</h1>
  <p id="note">asking the host\u2026</p>
  <ul id="places"></ul>
</section>
<section id="chat" hidden>
  <p id="who"></p>
  <div id="log"></div>
  <form id="composer">
    <textarea id="say" rows="2" placeholder="ask for something" disabled></textarea>
    <button id="send" disabled>send</button>
    <button id="stop" type="button" hidden>stop</button>
  </form>
</section>
<script type="module" src="./main.ts"></script>
`);
  write("extensions/chat/style.css", `:root { color-scheme: light dark; }
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
#note { margin: 0 0 1.6rem; opacity: 0.6; font-size: 0.85rem; white-space: pre-wrap; }
#places { list-style: none; margin: 0; padding: 0; }
#places li { border-bottom: 1px solid light-dark(#0001, #fff2); }
#places li.hint { padding: 0.6rem 0.2rem; font-size: 0.85rem; opacity: 0.8; border-bottom: none; }
#places button {
  font: inherit; width: 100%; text-align: left; padding: 0.6rem 0.2rem; cursor: pointer;
  border: none; background: transparent; color: inherit;
}
#places button:hover { background: light-dark(#0000000d, #ffffff0d); }
#chat {
  flex: 1; min-height: 0; display: flex; flex-direction: column;
  width: 100%; max-width: 44rem; margin: 0 auto; padding: 0 1rem 1rem; box-sizing: border-box;
}
#who { margin: 0.6rem 0.2rem; font-size: 0.85rem; opacity: 0.6; }
#log { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 0.6rem; padding: 0.4rem 0.2rem; }
.entry { white-space: pre-wrap; word-break: break-word; }
.entry.user { align-self: flex-end; max-width: 85%; padding: 0.45rem 0.7rem; border-radius: 10px; background: light-dark(#e4e0da, #24242b); }
.entry.thought { opacity: 0.55; font-size: 0.85rem; }
.entry.note { opacity: 0.65; font-size: 0.85rem; }
.entry.error { color: light-dark(#a3372e, #ff8f85); font-size: 0.9rem; }
.entry.tool { font-size: 0.85rem; opacity: 0.85; padding: 0.35rem 0.6rem; border-left: 2px solid light-dark(#0003, #fff3); }
.tool-status { margin-left: 0.6rem; opacity: 0.6; font-style: italic; }
.tool-detail { opacity: 0.7; font-size: 0.8rem; white-space: pre-wrap; }
.entry.permission { padding: 0.7rem 0.9rem; border: 1px solid light-dark(#0004, #fff4); border-radius: 8px; }
.entry.permission p { margin: 0 0 0.4rem; }
.entry.permission pre {
  margin: 0 0 0.6rem; font-size: 0.8rem; white-space: pre-wrap;
  opacity: 0.8; max-height: 10rem; overflow-y: auto;
}
.choices { display: flex; gap: 0.4rem; flex-wrap: wrap; }
.choices button {
  font: inherit; font-size: 0.85rem; padding: 0.25rem 0.8rem; cursor: pointer;
  border-radius: 6px; border: 1px solid light-dark(#0004, #fff4);
  background: light-dark(#fff, #222228); color: inherit;
}
.choices em { font-size: 0.85rem; opacity: 0.7; }
#composer { display: flex; gap: 0.4rem; margin-top: 0.6rem; }
#composer textarea {
  flex: 1; min-width: 0; resize: none; font: inherit; padding: 0.45rem 0.6rem;
  border-radius: 6px; border: 1px solid light-dark(#0003, #fff3);
  background: transparent; color: inherit;
}
#composer button {
  font: inherit; font-size: 0.85rem; padding: 0.35rem 0.9rem; cursor: pointer;
  border-radius: 6px; border: 1px solid light-dark(#0004, #fff4);
  background: light-dark(#fff, #222228); color: inherit; align-self: flex-end;
}
#composer button:disabled, #composer textarea:disabled { opacity: 0.5; cursor: default; }
`);
  write("extensions/chat/main.ts", `// Where you talk to an agent \u2014 and this tab, not the host, is the ACP client.
//
// \`pewt.agent()\` hands over a live wire carrying whole ACP messages, and no
// opinion about them. Everything that makes it a conversation is this file:
// correlating ids, streaming the agent's words into a transcript, and turning
// \`session/request_permission\` into buttons somebody designed. That is the
// point of the arrangement: the agent's questions are answered by the party
// with you and the screen in front of it, so what a question looks like is
// yours to change \u2014 it is this file, in your pewter.
//
// One tab is one conversation with one agent. For a second one, open another
// tab: \`pewt tabs add chat\`.
import { pewt, args, PewtError, type Agent } from "pewter";

const status = document.getElementById("status")!;
const said = document.getElementById("said")!;
const again = document.getElementById("again") as HTMLButtonElement;
const picker = document.getElementById("picker")!;
const note = document.getElementById("note")!;
const places = document.getElementById("places")!;
const chat = document.getElementById("chat")!;
const who = document.getElementById("who")!;
const log = document.getElementById("log")!;
const composer = document.getElementById("composer") as HTMLFormElement;
const say = document.getElementById("say") as HTMLTextAreaElement;
const send = document.getElementById("send") as HTMLButtonElement;
const stop = document.getElementById("stop") as HTMLButtonElement;

// ---- the JSON-RPC peer ACP needs, over the wire \`pewt.agent()\` holds
//
// A peer rather than a client, because the interesting direction is the one
// coming at us: \`session/request_permission\` is a request FROM the agent.
// The host promised one message arrives whole in each direction, so there is
// no buffer here and no half-message state.

type Params = Record<string, unknown> | undefined;

class Rpc {
  #send: (message: unknown) => void;
  #next = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #requests = new Map<string, (params: Params) => Promise<unknown> | unknown>();
  #notifications = new Map<string, (params: Params) => void>();

  constructor(send: (message: unknown) => void) {
    this.#send = send;
  }

  request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.#send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  onRequest(method: string, fn: (params: Params) => Promise<unknown> | unknown): void {
    this.#requests.set(method, fn);
  }

  onNotification(method: string, fn: (params: Params) => void): void {
    this.#notifications.set(method, fn);
  }

  /** One whole message from the agent: a request, a notification, or the
   *  answer to something this tab sent. */
  deliver(message: unknown): void {
    const msg = message as {
      id?: number | string;
      method?: string;
      params?: Params;
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    if (typeof msg.method === "string") {
      if (msg.id === undefined) {
        this.#notifications.get(msg.method)?.(msg.params);
        return;
      }
      void this.#answer(msg.id, msg.method, msg.params);
      return;
    }
    if (typeof msg.id !== "number") return;
    const waiting = this.#pending.get(msg.id);
    if (!waiting) return; // an answer to nothing this tab asked; legal to ignore
    this.#pending.delete(msg.id);
    if (msg.error) waiting.reject(new Error(msg.error.message ?? "the agent refused"));
    else waiting.resolve(msg.result);
  }

  /** The agent is gone; nobody is going to answer these now. */
  fail(reason: string): void {
    for (const [, waiting] of this.#pending) waiting.reject(new Error(reason));
    this.#pending.clear();
  }

  async #answer(id: number | string, method: string, params: Params): Promise<void> {
    const fn = this.#requests.get(method);
    if (!fn) {
      // An honest refusal over silence. \`fs/*\` lands here on purpose: this
      // tab holds no file handle, and the agent is a process in the project
      // that reads and writes with its own hands \u2014 which is exactly what the
      // asks/does-not-ask line in the transcript is about.
      this.#send({ jsonrpc: "2.0", id, error: { code: -32601, message: \`this tab has no handler for \${method}\` } });
      return;
    }
    try {
      const result = await fn(params);
      this.#send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (e) {
      this.#send({ jsonrpc: "2.0", id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
    }
  }
}

// ---- the transcript

/** The agent's words arrive as fragments, so consecutive fragments of one
 *  kind append to one block \u2014 the agent owns its line breaks, not this
 *  screen. Anything else that lands in the transcript resets the weld. */
let streaming: { kind: string; el: HTMLElement } | null = null;

function entry(kind: string): HTMLElement {
  const el = document.createElement("div");
  el.className = \`entry \${kind}\`;
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function line(kind: string, text: string): HTMLElement {
  streaming = null;
  const el = entry(kind);
  el.textContent = text;
  return el;
}

function stream(kind: "agent" | "thought", text: string): void {
  if (!text) return;
  if (!streaming || streaming.kind !== kind) streaming = { kind, el: entry(kind) };
  streaming.el.textContent += text;
  log.scrollTop = log.scrollHeight;
}

interface Block {
  type?: string;
  text?: string;
  path?: string;
  content?: Block;
}

const blockText = (b: Block | undefined): string => (b ? (typeof b.text === "string" ? b.text : blockText(b.content)) : "");

interface ToolCall {
  toolCallId?: string;
  title?: string;
  status?: string;
  content?: Block[];
}

/** One line of what a tool call is about \u2014 enough to judge a permission
 *  question without a diff viewer. A diff viewer is a fine thing to add;
 *  this file is in your pewter. */
function summary(content: Block[] | undefined): string {
  if (!content?.length) return "";
  return content
    .map((c) => {
      if (c.type === "diff" && c.path) return \`edit \${c.path}\`;
      const t = blockText(c).trim();
      return t.length > 200 ? t.slice(0, 200) + "\u2026" : t;
    })
    .filter((t) => t)
    .join("\\n");
}

const tools = new Map<string, { title: HTMLElement; status: HTMLElement; detail: HTMLElement }>();

function toolRow(tc: ToolCall): void {
  streaming = null;
  const el = entry("tool");
  const title = document.createElement("span");
  title.className = "tool-title";
  title.textContent = tc.title ?? "tool call";
  const state = document.createElement("span");
  state.className = "tool-status";
  state.textContent = tc.status ?? "pending";
  const detail = document.createElement("div");
  detail.className = "tool-detail";
  detail.textContent = summary(tc.content);
  el.append(title, state, detail);
  if (tc.toolCallId) tools.set(tc.toolCallId, { title, status: state, detail });
}

function toolUpdate(tc: ToolCall): void {
  const row = tc.toolCallId ? tools.get(tc.toolCallId) : undefined;
  if (!row) return;
  if (tc.title) row.title.textContent = tc.title;
  if (tc.status) row.status.textContent = tc.status;
  const more = summary(tc.content);
  if (more) row.detail.textContent = more;
}

/** \`session/update\` \u2014 everything the agent narrates while it works. */
function update(params: Params): void {
  const u = (params?.["update"] ?? {}) as Record<string, unknown>;
  switch (String(u["sessionUpdate"] ?? "")) {
    case "agent_message_chunk":
      return stream("agent", blockText(u["content"] as Block));
    case "agent_thought_chunk":
      return stream("thought", blockText(u["content"] as Block));
    case "tool_call":
      return toolRow(u as ToolCall);
    case "tool_call_update":
      return toolUpdate(u as ToolCall);
    case "plan": {
      const items = (u["entries"] as { content?: string; status?: string }[] | undefined) ?? [];
      if (items.length) line("note", "plan: " + items.map((i) => \`\${i.status === "completed" ? "\u2713" : "\u2022"} \${i.content ?? ""}\`).join("  "));
      return;
    }
    default:
      return; // available_commands_update and friends \u2014 not this screen's business
  }
}

/** The agent's permission question, as a card with buttons. The promise
 *  resolves when you click, and that IS the JSON-RPC response \u2014 the agent
 *  stays parked on it for exactly as long as you take. */
function permission(params: Params): Promise<unknown> {
  const tc = (params?.["toolCall"] ?? {}) as ToolCall;
  const options = ((params?.["options"] as { optionId?: string; name?: string }[] | undefined) ?? []).filter((o) => o.optionId);
  streaming = null;
  const card = entry("permission");
  const title = document.createElement("p");
  title.textContent = tc.title ?? "the agent wants to do something";
  card.append(title);
  const detail = summary(tc.content);
  if (detail) {
    const p = document.createElement("pre");
    p.textContent = detail;
    card.append(p);
  }
  const verbs = document.createElement("div");
  verbs.className = "choices";
  card.append(verbs);
  return new Promise((resolve) => {
    const settle = (optionId: string | null, name: string): void => {
      verbs.replaceChildren();
      const answer = document.createElement("em");
      answer.textContent = name;
      verbs.append(answer);
      resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
    };
    for (const o of options) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = o.name ?? o.optionId!;
      b.addEventListener("click", () => settle(o.optionId!, b.textContent ?? ""));
      verbs.append(b);
    }
    // A question with no options is not answerable in its own words, and
    // cancelling is the one honest answer this screen can always give.
    if (!options.length) {
      const never = document.createElement("button");
      never.type = "button";
      never.textContent = "cancel";
      never.addEventListener("click", () => settle(null, "cancelled"));
      verbs.append(never);
    }
  });
}

// ---- the conversation

/** The one running conversation, or null. Everything the composer needs. */
let live: { rpc: Rpc; sessionId: string } | null = null;
/** Which agent's exit still means anything \u2014 an old exit must not narrate
 *  over a newer conversation. */
let current: Agent | null = null;
let turning = false;

/** Where the agent runs, and which agent it would be. Asked fresh every time
 *  the picker shows, so a project cloned \u2014 or an adapter installed \u2014 since
 *  the last conversation is on the list. */
async function offer(): Promise<void> {
  chat.hidden = true;
  picker.hidden = false;
  places.replaceChildren();
  note.textContent = "asking the host\u2026";
  try {
    const [{ agents }, { repos }] = await Promise.all([pewt.agents.list(), pewt.repos.list()]);
    const installed = agents.filter((a) => a.installed);
    if (installed.length === 0) {
      // Nothing to start. An adapter is an ordinary dependency, so the fix
      // is a line you type, and the roster knows the lines.
      note.textContent = "this pewter has no ACP adapter installed \u2014 an adapter is an ordinary dependency:";
      for (const a of agents) {
        const row = document.createElement("li");
        row.className = "hint";
        row.textContent = \`\${a.install} \u2014 \${a.asks ? "asks before it edits" : "edits with its own hands"}\`;
        places.append(row);
      }
      return;
    }
    const first = installed[0]!;
    note.textContent = \`\${first.title}\${first.version ? \` \${first.version}\` : ""} \u2014 \${first.asks ? "asks before it edits" : "edits with its own hands"}. The host asks before it starts one.\`;
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

/** One conversation, for as long as the agent runs. */
async function open(repo: string | null): Promise<void> {
  picker.hidden = true;
  chat.hidden = false;
  again.hidden = true;
  log.replaceChildren();
  tools.clear();
  streaming = null;
  live = null;
  who.textContent = "";
  say.disabled = true;
  send.disabled = true;
  sayStatus("waiting \u2014 the host asks on its own terminal before it starts an agent");

  let agent: Agent;
  const rpc = new Rpc((message) => agent.send(message));
  try {
    agent = await pewt.agent({ ...(repo ? { repo } : {}), onMessage: (m) => rpc.deliver(m) });
  } catch (e) {
    // A refusal is a normal ending: the human at the host's terminal said
    // no, or there is nothing to start. Back to the picker, under the reason.
    sayStatus(words(e));
    await offer();
    return;
  }
  current = agent;

  const info = agent.info;
  who.textContent = \`\${info.title}\${info.version ? \` \${info.version}\` : ""} \u2014 in \${info.where}\`;
  // The roster measured whether this agent asks before it edits. Said before
  // the first prompt rather than found out after the first edit.
  line(
    "note",
    (info.asks ? "this agent asks before it changes a file" : "this agent edits with its own hands \u2014 it will not ask first") +
      (info.unmeasured ? " (measured against a different version than yours)" : "")
  );

  rpc.onNotification("session/update", update);
  rpc.onRequest("session/request_permission", permission);

  // The exit, whenever it comes. Anything the agent said on stderr on the
  // way out is on the terminal running \`pewt serve\`, not here.
  void agent.exit.then((code) => {
    if (current !== agent) return;
    rpc.fail("the agent exited");
    live = null;
    turn(false);
    say.disabled = true;
    send.disabled = true;
    sayStatus(code === null ? "the agent ended without an exit code \u2014 a signal, or the host went away" : \`the agent exited (\${code})\`);
    again.hidden = false;
  });

  try {
    // The ACP handshake. The fs capabilities are declared false because they
    // are: this tab holds no file handle, so the agent touches the project
    // with its own hands and this screen narrates what it hears.
    await rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const made = await rpc.request<{ sessionId?: string }>("session/new", {
      // Absolute, because ACP requires one \u2014 it arrived with the started
      // agent, labelled for exactly this call.
      cwd: info.cwd,
      mcpServers: [],
    });
    if (!made.sessionId) throw new Error("the agent answered session/new without a sessionId");
    live = { rpc, sessionId: made.sessionId };
  } catch (e) {
    line("error", words(e));
    agent.close();
    return;
  }
  status.hidden = true;
  say.disabled = false;
  send.disabled = false;
  say.focus();
}

/** One turn: your words in, the agent's stream back, an end reason. */
async function ask(): Promise<void> {
  const text = say.value.trim();
  if (!text || !live || turning) return;
  say.value = "";
  line("user", text);
  turn(true);
  try {
    const done = await live.rpc.request<{ stopReason?: string }>("session/prompt", {
      sessionId: live.sessionId,
      prompt: [{ type: "text", text }],
    });
    if (done.stopReason && done.stopReason !== "end_turn") line("note", \`turn ended: \${done.stopReason}\`);
  } catch (e) {
    line("error", words(e));
  } finally {
    turn(false);
    streaming = null;
  }
}

function turn(on: boolean): void {
  turning = on;
  send.disabled = on || !live;
  stop.hidden = !on;
}

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  void ask();
});
// Enter sends; Shift+Enter is a newline. A chat-box convention, and yours to
// change.
say.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void ask();
  }
});
// Stop is a notification, not a plea: the agent ends the turn and says how
// (\`stopReason: "cancelled"\`), and the prompt's answer arrives normally.
stop.addEventListener("click", () => {
  if (live) live.rpc.notify("session/cancel", { sessionId: live.sessionId });
});
again.addEventListener("click", () => {
  again.hidden = true;
  current = null;
  void offer();
});

function sayStatus(text: string): void {
  said.textContent = text;
  status.hidden = false;
}

const words = (e: unknown): string =>
  e instanceof PewtError ? e.message + (e.hint ? \`\\n\${e.hint}\` : "") : String(e);

// Opened with \`{repo}\` \u2014 the repos row's agent verb \u2014 this screen skips its
// picker and goes straight there. Opened bare, it offers the choice. Either
// way the host asks before anything starts: the argument opened a screen,
// not a process.
const openedWith = (await args) as { repo?: unknown } | undefined;
if (openedWith && typeof openedWith.repo === "string") {
  await open(openedWith.repo);
} else {
  await offer();
}
`);
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
