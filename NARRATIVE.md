# Pewter

Pewter is a development environment that runs out of one folder on your
machine. The folder is three things at once: a git repository, an npm
project, and the channel that connects your machine to a web page.

You open the page, grant it the folder, and the page shows your projects.
From there you browse files, open terminals, run builds, and start coding
agents. Nothing is uploaded. The page is served from pewter.town, but no
server sits between it and your machine.

## Terms

| Term | Meaning |
| --- | --- |
| Pewter | This environment, as a whole. |
| pewter | One Pewter folder. You can have several. |
| project | A git repository inside a pewter, under `repos/`. |
| pewt | The command-line tool. Installed in the pewter, never globally. |
| host | The `pewt serve` process. One per pewter. |
| shell | The page at pewter.town. Holds tabs and provides the `pewt` API. |
| extension | A small TypeScript app that fills a tab. |
| adapter | An npm package that lets Pewter drive one coding agent over ACP. |

## What makes it different

Your environment is a repository you own. Your settings are not rows in a
vendor's database; they are files in your git history. You can read them,
change them, fork them, and delete them.

Agents extend your pewter by writing code into it. Ask an agent for a
dashboard and it writes one as an extension: a screen you can open any
time, that reads the project fresh each time, and that runs with every
agent turned off.

After a few months, your pewter no longer looks like the one you started
with. The difference is a list of commits, and every one of them is code
you can read.

## Create a pewter

```sh
npm create pewt@latest ~/Documents/code/work-pewter
cd ~/Documents/code/work-pewter
npm start
```

Put it anywhere. Nothing depends on where a pewter lives or what it is
called, and you can have as many as you want.

`npm start` runs `pewt serve`, which opens pewter.town and waits. It looks
for a Chromium rather than your default browser, because the page needs
the File System Access API. The last step is yours: pick the folder in the
browser and allow it. `pewt` cannot do that part. Picking and allowing a
folder are gestures only Chrome can offer, and they are what stops the
page from reaching anything you did not choose.

The shell is an ordinary web page, and after it loads it makes no network
requests. Listing projects, running builds, and loading its own screens
all travel through the folder you granted.

## What is in a pewter

```
~/dev/tinkering/
├── AGENTS.md          How this pewter works. Agents read this first.
├── package.json       Dependencies, your agents, pewter-wide scripts.
├── tsconfig.json      Covers extensions/. Your editor and pewt check use it.
├── extensions/        The screens you see, including ones agents wrote.
├── templates/         What a new project starts as.
├── repos/             Your projects. Each its own git repo.
├── .fsio/             The channel: frames, session transcripts.
└── .pewter/           This pewter's state: grants, build output.
```

Everything sorts by what deletes it:

- **Committed:** `AGENTS.md`, `package.json`, `tsconfig.json`,
  `extensions/`, `templates/`. This is the pewter itself.
- **Ignored:** `repos/`. Your work, each project keeping its own history.
  The pewter holds no opinion about it.
- **Regenerated:** `.fsio/` and `.pewter/`. Delete either and the next
  `pewt serve` rebuilds it.
- **Not on disk:** tabs, and any file you sent to the page. Those live in
  the browser's storage.

Because your work is not committed, you can push your pewter to a public
repository without publishing anything you have worked on. You can also
restore it anywhere:

```sh
git clone github:you/work-pewter ~/src/work
cd ~/src/work && npm i && npm start
```

Your extensions, templates, scripts, and agents come back. Your projects
do not.

## Extensions

Almost nothing in the page is built in. The shell holds tabs and provides
the `pewt` API. What fills a tab is an extension: a small TypeScript app
that lives in your pewter.

The first screen proves it. Open a new pewter and you get a list of
projects with a button to add one. That screen is not part of the product.
It is `extensions/repos/`, and you can read it, change it, or delete it.

```
extensions/
├── repos/          The project list you see on startup.
│   ├── index.html
│   └── main.ts
├── chat/           Where you talk to an agent.
└── dashboard/      What is happening in a project right now.
```

`pewter` is an ordinary package in your pewter's `node_modules`, so an
extension imports it like anything else and your editor knows the types:

```ts
import { pewt, proxy } from "pewter";

for (const repo of await pewt.repos.list()) {
  list.append(row(repo));
}

addButton.onclick = () =>
  pewt.repos.create({ name: nameField.value, github: true });
```

There is no plugin API to learn. `pewt.repos.list()` is the same operation
as typing `pewt repos`, so an extension reaches everything the command
line reaches — and nothing that ships with a new pewter has access your
own code lacks.

### How an extension reaches the page

Your source never travels over the network. When a tab opens, the shell
asks the host for that extension. The host bundles it into one
self-contained HTML file, sends the bytes through the folder, and the
shell loads them into a sandboxed iframe.

```
extensions/repos/*.ts → bundle → one HTML file → the folder → iframe
```

Two things follow:

- **You never run a build to see a change.** The host rebuilds whenever
  the source is newer than the last bundle, so you save a file and reload
  the tab.
- **An extension is one file.** Bundling inlines the JavaScript and CSS,
  which is why code splitting and runtime asset loading are not available
  to it.

### Why an extension is sandboxed

The shell is hosted, so its origin is shared by everyone who uses Pewter,
and that origin stores the grants for every folder you have ever opened.
Code running there can read all of them.

An extension is not necessarily code you wrote. An agent may have written
it, or it may have arrived with a pewter you cloned from someone else. So
an extension runs in a sandboxed iframe with no `allow-same-origin`, which
gives it an opaque origin of its own: no access to pewter.town's storage,
none to the shell's DOM, and none to another extension.

Everything an extension does, it does by asking the shell over a message
channel. It gets the whole `pewt` API and nothing but the API. That
removes ambient access; it does not narrow the operations themselves.

### Types are how an agent checks its work

An agent writing an extension has one obvious feedback signal — render it
and look — and that one needs you, a browser, and a judgment call.
TypeScript gives it a second signal it can run alone: `pewt check`
compiles `extensions/` and reports what is wrong before anything reaches a
screen.

That is the main reason an extension is TypeScript rather than JavaScript,
and it is why the extensions that arrive with a new pewter are written
exactly the way yours are. `extensions/repos/` is both the proof that
there are no built-ins and the worked example of how to write one.

## Running things on your machine

An extension runs in a browser tab. It cannot compile anything, touch git,
or start a process. When it needs one of those, it asks:

```ts
await pewt.run("build", {
  repo: "fsio",
  onOutput: proxy((line) => log.append(line)),
});
```

`pewt.run` runs a script the project already declares. There is no
Pewter-specific registry, and nothing has to be added to a project to make
it work. `build` here is the ordinary script in `repos/fsio/package.json`:

```jsonc
// repos/fsio/package.json — unchanged, and knows nothing about Pewter
"scripts": { "build": "vite build", "test": "node --test" }
```

Scripts in your pewter's own `package.json` work the same way and run with
no `repo`.

Two things fall out of reusing npm scripts instead of inventing a
mechanism for this:

- **An extension cannot invent a script.** It can only run what is already
  written in a `package.json` you can read. The set of runnable things is
  a file, not a capability.
- **Projects stay portable.** A repo with a `build` script works here and
  works for someone who has never heard of Pewter.

The script runs with the project as its working directory and `pewt` on
its `PATH`, so an existing build can call back in without ceremony. The
host asks before starting anything new.

Typing `pewt run build --repo fsio` in a terminal does the same thing.

## Agents

Pewter ships no agent. It speaks the Agent Client Protocol, so the shell
is an ACP client and an agent is an ordinary process on your machine whose
stdio rides the folder — the same channel everything else uses.

Which agents your pewter can run is a line in `package.json`:

```sh
npm i @agentclientprotocol/claude-agent-acp
```

An adapter is an ordinary dependency, so what you already know applies. It
is pinned in your lockfile, `npm rm` removes it, and `git clone` followed
by `npm i` brings your agents back on another machine along with the rest
of your pewter. Nothing installs globally and nothing hides in your home
directory.

The cost is disk. The Claude adapter measured 111 packages and 293 MB,
most of it the bundled CLI, and two pewters mean two copies.

### Not every agent asks before it edits

`pewt agents` lists what is installed and, for each one, whether it
requests permission before it changes a file. That is measured rather than
assumed, and the answers differ:

| Adapter | Asks before editing |
| --- | --- |
| `claude-agent-acp` | Yes |
| `pi-acp` | No. It reads and edits with its own hands. |

The difference matters, and it is not something to find out afterward, so
the roster says which is which before you pick. Start one on a project:

```sh
pewt agent --repo fsio
```

From there the agent reads `AGENTS.md` and works through `pewt` exactly as
you would. The conversation rides the folder, so it lands in the same
transcripts every other session does.

The chat tab itself is `extensions/chat/`, an extension like any other.
Change how it looks, add to it, or replace it.

## Sending a file to the page

An extension is code that runs. A file is a snapshot of content. Three
commands send one, differing in who ends up holding the bytes:

| Command | What the page gets | If the file is deleted |
| --- | --- | --- |
| `pewt open <path>` | A view of the file, read through your grant | The tab reports it is gone |
| `pewt fling <path>` | A copy in the browser's storage | The tab keeps working |
| `pewt publish <path>` | A copy other people can open (not built) | The tab keeps working |

`fling` is how a build output outlives its build directory. Delete
`dist/`, stop `pewt serve`, revoke the folder: the tab still works,
because the page holds the bytes. An extension does not work that way. The
shell may still have its code cached, but an extension with no host cannot
call anything, so it renders and then sits there.

## The pewt command line

`pewt` only runs inside a pewter. Outside one it is not installed, so
there is nothing to run.

```
PEWTER      serve · check · doctor · api
PROJECTS    repos {new, clone, link, rm} · template {new, apply}
RUNNING     run · shell · agent · agents
THE PAGE    tabs {add, update, close, focus} · open · fling
EXTENDING   ext {new, rm}
THE RECORD  sessions {log, replay} · grants {revoke}
SHARING     publish · share · join · workspaces   (not built)
```

Every command accepts `--repo`, `--json`, and `--dry-run`. Exit codes
distinguish the two ways the system can be unavailable: `3` means no host
is running, and `4` means no page is open. They need different fixes.

## One API, two ways in

The command line and an extension are two front ends over one set of
operations. Neither is the real one:

| From a terminal | From an extension |
| --- | --- |
| `pewt repos` | `await pewt.repos.list()` |
| `pewt repos new site --github` | `await pewt.repos.create({ name: "site", github: true })` |
| `pewt run build --repo site` | `await pewt.run("build", { repo: "site" })` |
| `pewt fling report.html` | `await pewt.fling("report.html")` |

The spellings differ where each side has its own conventions. The
operations do not. Adding one adds both, so there is no second surface to
keep in sync, and nothing that ships in a new pewter has access your own
code lacks.

This is what makes the agent level work. An agent gets no private API; it
runs the same commands you run. Three things follow:

- **Its reach is your reach.** An agent cannot do anything you could not
  do yourself.
- **Its work is readable.** A session is a list of commands in the
  vocabulary you already use, so reviewing what an agent did takes no
  second thing to learn.
- **Existing automation already fits.** Because the surface is a command
  line, npm scripts, git hooks, CI, and cron drive your pewter without a
  plugin API.

One operation has no command: the folder grant. Picking a folder and
allowing it are gestures only Chrome offers, so `pewt` cannot perform them
and neither can an agent. That gap is the boundary everything else rests
on.

## What pewt serve does

`pewt serve` is the host: the one process that can open sessions in the
folder. The page is a client, and the CLI is a client. Clients cannot talk
to each other, so without a host, neither works. Starting a second host on
the same folder fails.

The host also launches processes. `pewt run`, `pewt shell`, and `pewt
agent` all start something, and the host asks first:

```
12:06:02  ▸ run build --repo fsio                       from the page
12:06:02    ? this script has not run before
12:06:02        vite build
12:06:02        cwd repos/fsio
12:06:02      allow once / allow always / deny  [o/a/D] a
12:06:02    ✓ standing grant recorded → .pewter/grants.json
12:06:09    ✓ exit 0 · 41 lines of output

12:09:55  ▸ tabs add --title "CI"                        from a terminal
12:09:55    ✓ t-20                        (no process — nothing to allow)
```

The question appears in the terminal, not in the page. The page is the
thing asking for permission, so the page cannot be the thing granting it.

Only commands that launch a process prompt. Sending a tab title does not.
Answers are recorded in `.pewter/grants.json`; `pewt grants` lists them and
`pewt grants revoke` takes one back.

The host is not optional. While it is down the page has no session, so
browsing files and running commands both stop, and any process the host
started stops with it. What survives is content you sent with `pewt
fling`: those bytes are in the browser's storage, so those tabs keep
working with the host stopped and the folder revoked.

## Who can do what

Three levels. You move up one at a time.

**You.** Browse projects, open terminals, click buttons. No agent is
involved. This is a complete environment on its own, and it is the right
one if you do not want an agent near your machine.

**An agent.** You install an adapter and start an agent on a project. It
reads `AGENTS.md` and works through the same API your screens use, so its
reach matches yours and its work is readable afterward.

**Neither.** The agent writes an extension. From then on you open that
tab, the screen works, and no agent is involved.

The third level is the most independent and the easiest to trust. You can
read an extension. You cannot read an agent.

An extension cannot reach the shell's storage or another extension, but it
can ask for any operation you can. Nothing narrows that; see below.

## What is not built

**Limits on what an extension can ask for.** The sandbox stops an
extension from reaching around the API. It does not narrow the API: any
extension can call any operation, read any file in the folder you granted,
and run any script your projects declare. Restricting that per extension
needs a permission model, and there is not one. What you have instead is
that you can read the code, and that the host asks before it runs anything
new.

**A development harness.** Debugging a bundle is worse than debugging the
files you wrote. A local dev server would give extensions real URLs, hot
reload, and type errors on screen as you type. Worth building when the
loop hurts, not before.

**Version agreement between the shell and pewt.** The shell ships on our
schedule and `pewt` is installed on yours, so the two can disagree about
the API. Noticing that and saying so plainly is not designed yet.

**Sharing.** Two people cannot use one pewter today. The obvious approach
— move the page's storage to a cloud database — would put copies of your
work on someone else's server, which is the one thing this project does
not do. The version worth trying instead treats the cloud as a *channel*:
frames in transit, with each person's files staying on their own disk.
That would also be the first test of whether the protocol really works at
hundreds of milliseconds instead of five. Unbuilt and unscheduled.

**The hub daemon.** One host serving many folders under a single grant.
Parked, and nothing here revives it. A pewter gets one host on one folder,
and directories do the work the hub proposed to do.

## Pewter is a demo

A demo is a product that has not been heavily invested in. It can deploy,
it can have users, it can be the thing fsio itself gets built inside. None
of that says anything about its status. What ends demo status is a
decision about long-term investment, made well outside this repository.

So there is no signal here to read. Presume demo.

That is what keeps it cheap: Pewter can be deleted, can be wrong, and can
be abandoned without leaving anything behind. Its choices earn no numbered
entries in `spec/`, it runs no measurement labs, and nothing in `spec/`
names it.

## Related documents

- [PROCESS.md](PROCESS.md) — which layer a thought goes in, and why demos
  carry no record
- [spec/PRINCIPLES.md](spec/PRINCIPLES.md) — what the platform will not
  trade away
- [spec/PROTOCOL.md](spec/PROTOCOL.md) — the transport Pewter runs on
- [README.md](README.md) — the three demos Pewter is built from
