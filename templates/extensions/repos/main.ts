// The project list — the first screen a pewter shows.
//
// It is not part of the product. It is this file, in your pewter, and you can
// read it, change it, or delete it. Nothing it uses is private to it: every
// call below has a spelling on the command line too — `pewt repos`,
// `pewt repos create <name>`, `pewt repos clone <url>`.
//
// The screen is a lit template over the handful of signals below, drawn by
// `screen()` from `pewter-ui`. There is one description of what a project
// row looks like and one place each fact lives, so a row cannot go stale
// while something else on the screen is up to date.
import { explain, pewt, type Project } from "pewter";
import { html, nothing } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { signal } from "@lit-labs/signals";
// The shared look: tokens, base styles and the kit's elements, an ordinary
// dependency of this pewter. Delete both imports to style this screen
// entirely yourself.
import { screen } from "pewter-ui";
import "pewter-ui/style.css";

// ---- what this screen is, as state

/** The projects, or null while the host has not answered yet. */
const projects = signal<Project[] | null>(null);

/** A refusal, in the operation's own words. Empty means nothing is wrong. */
const error = signal("");

/** What a running command has printed, or null when nothing is running and
 *  nothing ran. Lines rather than one string: appending is what happens to
 *  it, and a list says so. */
const output = signal<string[] | null>(null);

/** One thing runs at a time on this screen, and every control says so. */
const busy = signal(false);

/** The two fields. Held here rather than read off the DOM, so clearing one
 *  after a success is a fact changing rather than an element being poked. */
const newName = signal("");
const cloneUrl = signal("");

/** The output pane, for the one thing state cannot express: staying scrolled
 *  to the bottom as lines arrive. */
const pane = createRef<HTMLPreElement>();

const note = (): string => {
  const repos = projects.get();
  if (repos === null) return "asking the host…";
  if (repos.length === 0) return "nothing in repos/ yet";
  return `${repos.length} in repos/, read through the folder you granted`;
};

const ui = screen(document.body, () => {
  const repos = projects.get();
  const lines = output.get();
  return html`
    <main class="screen">
      <header>
        <h1>Projects</h1>
        <p class="note">${note()}</p>
      </header>
      <ul id="list">
        ${repos?.length === 0
          ? html`<li class="empty">No projects yet — start one, or clone one, below.</li>`
          : repos?.map((repo) => row(repo))}
      </ul>
      <section id="verbs">
        <form @submit=${create}>
          <input
            placeholder="a name"
            autocomplete="off"
            spellcheck="false"
            .value=${newName.get()}
            ?disabled=${busy.get()}
            @input=${(e: Event) => newName.set((e.target as HTMLInputElement).value)}
          />
          <button ?disabled=${busy.get()}>New project</button>
        </form>
        <form @submit=${clone}>
          <input
            placeholder="https://… or git@… or a path"
            autocomplete="off"
            spellcheck="false"
            .value=${cloneUrl.get()}
            ?disabled=${busy.get()}
            @input=${(e: Event) => cloneUrl.set((e.target as HTMLInputElement).value)}
          />
          <button ?disabled=${busy.get()}>Clone</button>
        </form>
      </section>
      <p class="error" ?hidden=${!error.get()}>${error.get()}</p>
      <pre id="progress" ${ref(pane)} ?hidden=${lines === null}>${lines?.join("\n")}</pre>
    </main>
  `;
});

/** One project. The row's verbs: `shell` and `agent` are on every row
 *  (#198) — each opens its extension pointed here, and the host asks before
 *  the shell or agent itself exists, so the argument opens a screen, not a
 *  process. The scripts are this project's own `package.json`, not anything
 *  this screen invents — an extension cannot make a script runnable by
 *  drawing a button for it. `install` leads when node_modules is missing
 *  (every fresh clone), because the scripts will not run without it — and
 *  unlike clone, install is asked about (#193). */
const row = (repo: Project) => html`
  <li>
    <span>
      ${repo.name}
      ${repo.branch ? html`<em class="branch">${repo.branch}</em>` : nothing}
      ${repo.git ? nothing : html`<em class="branch">not a git repository</em>`}
    </span>
    <span class="verbs">
      ${repo.installed === false
        ? html`<button class="install" ?disabled=${busy.get()} @click=${() => install(repo.name)}>install</button>`
        : nothing}
      <button ?disabled=${busy.get()} @click=${() => openTab("terminal", repo.name)}>shell</button>
      <button ?disabled=${busy.get()} @click=${() => openTab("agent", repo.name)}>agent</button>
      ${repo.scripts.map(
        (script) => html`<button ?disabled=${busy.get()} @click=${() => runScript(repo.name, script)}>${script}</button>`
      )}
    </span>
  </li>
`;

async function refresh(): Promise<void> {
  const { repos } = await pewt.repos.list();
  projects.set(repos);
}

/** Open an extension in a new tab, pointed at this project. The tab opens
 *  with `{repo}` (#198) — an argument to a screen, not a grant: the host
 *  still asks before the shell or the agent itself starts. */
function openTab(name: "terminal" | "agent", repo: string): void {
  error.set("");
  pewt.tabs.add({ name, title: repo, args: { repo } }).catch(complain);
}

// ---- running something, and watching it run
//
// The three verbs below are one shape: say what is about to happen, stream
// what it says, end on a code. What differs is the call in the middle.

/** Begin a run: the pane opens with its first line and everything goes
 *  quiet. Returns the timer that explains a long silence — the host asks a
 *  human at its own terminal before starting anything, so a call can sit a
 *  while, and the pane says so rather than looking hung. */
function begin(first: string): ReturnType<typeof setTimeout> {
  error.set("");
  output.set([first]);
  busy.set(true);
  return setTimeout(() => append("(waiting — the host asks on its own terminal before it starts anything)"), 1200);
}

function append(line: string): void {
  output.set([...(output.get() ?? []), line]);
  // After the draw the line caused, not before it: the pane has to have the
  // line in it before there is anything new to scroll to.
  void ui.drawn().then(() => {
    const el = pane.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function ended(exitCode: number | null): void {
  append("");
  append(`exit ${exitCode ?? "?"}`);
}

/** `npm install`, asked first: it runs lifecycle scripts, which makes it the
 *  first execution of what a clone fetched. The question rides the run rung,
 *  so `--allow-runs` or a standing `run/<project>` grant covers it. */
function install(repo: string): void {
  const waiting = begin(`npm install — in ${repo}`);
  pewt.repos
    .install(repo, {
      onOutput: (line) => {
        clearTimeout(waiting);
        append(line);
      },
    })
    .then(async ({ exitCode }) => {
      ended(exitCode);
      if (exitCode === 0) await refresh();
    })
    .catch(complain)
    .finally(() => {
      clearTimeout(waiting);
      busy.set(false);
    });
}

/** Run one script, output streaming into the shared pane. */
function runScript(repo: string, script: string): void {
  const waiting = begin(`npm run ${script} — in ${repo}`);
  pewt
    .run(script, {
      repo,
      onOutput: (line) => {
        clearTimeout(waiting);
        append(line);
      },
    })
    .then(({ exitCode }) => ended(exitCode))
    .catch(complain)
    .finally(() => {
      clearTimeout(waiting);
      busy.set(false);
    });
}

function create(e: SubmitEvent): void {
  e.preventDefault();
  const name = newName.get().trim();
  if (!name) return;
  error.set("");
  busy.set(true);
  pewt.repos
    .create({ name })
    .then(async () => {
      newName.set("");
      await refresh();
    })
    .catch(complain)
    .finally(() => busy.set(false));
}

function clone(e: SubmitEvent): void {
  e.preventDefault();
  const url = cloneUrl.get().trim();
  if (!url) return;
  error.set("");
  output.set([`git clone ${url}`]);
  busy.set(true);
  pewt.repos
    // git's own lines, throttled by the host. Everything it says — progress
    // included — arrives on "err", which is git's convention, not a failure.
    .clone(url, { onOutput: (line) => append(line) })
    .then(async ({ exitCode }) => {
      if (exitCode === 0) {
        cloneUrl.set("");
        output.set(null);
        await refresh();
      } else {
        // The reason is already on screen in git's words; this line says how
        // it ended. A failed clone leaves nothing behind.
        append("");
        append(`clone failed (exit ${exitCode ?? "?"})`);
      }
    })
    .catch(complain)
    .finally(() => busy.set(false));
}

/** A refusal, in the operation's own words — `explain` keeps the hint that
 *  travels with a PewtError, so this screen never has to guess. */
function complain(e: unknown): void {
  error.set(explain(e));
}

await refresh();
