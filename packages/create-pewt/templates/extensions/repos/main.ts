// The project list — the first screen a pewter shows.
//
// It is not part of the product. It is this file, in your pewter, and you can
// read it, change it, or delete it. Nothing it uses is private to it: every
// call below has a spelling on the command line too — `pewt repos`,
// `pewt repos create <name>`, `pewt repos clone <url>`.
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
  note.textContent = `${repos.length} in repos/, read through the folder you granted`;
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
    // The row's verbs. `shell` and `agent` are on every row (#198): each
    // opens its extension pointed here, and the host asks before the shell
    // or agent itself exists — the argument opens a screen, not a process. The
    // scripts are this project's own `package.json`, not anything this
    // screen invents — an extension cannot make a script runnable by
    // drawing a button for it. `install` leads when node_modules is
    // missing (every fresh clone), because the scripts will not run
    // without it — and unlike clone, install is asked about (#193).
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
 *  tab opens with `{repo}` (#198) — an argument to a screen, not a grant:
 *  the host still asks before the shell itself starts. */
function openShell(repo: string): void {
  error.hidden = true;
  pewt.tabs.add({ name: "terminal", title: repo, args: { repo } }).catch(complain);
}

/** Open the agent extension in a new tab, pointed at this project. The same
 *  arrangement as the shell verb: the argument opens a screen, not a
 *  process — the host asks before the agent itself starts. */
function openAgent(repo: string): void {
  error.hidden = true;
  pewt.tabs.add({ name: "agent", title: repo, args: { repo } }).catch(complain);
}

/** `npm install`, asked first: it runs lifecycle scripts, which makes it
 *  the first execution of what a clone fetched. The question rides the run
 *  rung, so `--allow-runs` or a standing `run/<project>` grant covers it. */
function installRepo(repo: string): void {
  error.hidden = true;
  progress.textContent = `npm install — in ${repo}\n`;
  progress.hidden = false;
  busy(true);
  const waiting = setTimeout(() => {
    progress.append("(waiting — the host asks on its own terminal before it starts anything)\n");
  }, 1200);
  pewt.repos
    .install(repo, {
      onOutput: (line) => {
        clearTimeout(waiting);
        progress.append(line + "\n");
        progress.scrollTop = progress.scrollHeight;
      },
    })
    .then(async ({ exitCode }) => {
      progress.append(`\nexit ${exitCode ?? "?"}\n`);
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
  progress.textContent = `npm run ${script} — in ${repo}\n`;
  progress.hidden = false;
  busy(true);
  const waiting = setTimeout(() => {
    progress.append("(waiting — the host asks on its own terminal before it starts anything)\n");
  }, 1200);
  pewt
    .run(script, {
      repo,
      onOutput: (line) => {
        clearTimeout(waiting);
        progress.append(line + "\n");
        progress.scrollTop = progress.scrollHeight;
      },
    })
    .then(({ exitCode }) => progress.append(`\nexit ${exitCode ?? "?"}\n`))
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
  error.textContent = known ? known.message + (known.hint ? `\n${known.hint}` : "") : String(e);
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
  progress.textContent = `git clone ${url}\n`;
  progress.hidden = false;
  busy(true);
  pewt.repos
    // git's own lines, throttled by the host. Everything it says — progress
    // included — arrives on "err", which is git's convention, not a failure.
    .clone(url, {
      onOutput: (line) => {
        progress.append(line + "\n");
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
        progress.append(`\nclone failed (exit ${exitCode ?? "?"})\n`);
      }
    })
    .catch(complain)
    .finally(() => busy(false));
});

await refresh();
