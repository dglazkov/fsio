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
npx github:dglazkov/fsio#create-pewt ~/Documents/code/work-pewter
cd ~/Documents/code/work-pewter
npm start
```

Put it anywhere. Nothing depends on where a pewter lives or what it is
called, and you can have as many as you want.

`npm start` runs `pewt serve`, which opens pewter.town and waits. It looks
for a Chromium rather than your default browser, because the page needs
the File System Access API. The last step is yours: hand the folder to the
page — drop it on the page, or pick it — and allow it. `pewt` cannot do that
part. Handing over a folder and allowing it are gestures only Chrome can
offer, and they are what stops the page from reaching anything you did not
choose.

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
projects with a button to add one — and each project's row knows its
branch and its scripts, every script one click from running. That screen
is not part of the product. It is `extensions/repos/`, and you can read
it, change it, or delete it.

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
  pewt.repos.create({ name: nameField.value });
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
  the tab. `pewt ext bundle <name>` is the same operation from a terminal,
  which is how you see a compile error without opening the tab.
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

```
$ pewt check

extensions/repos/main.ts
  33:7    TS2322  Type 'number' is not assignable to type 'string'.
  34:18   TS2345  Argument of type 'string' is not assignable to parameter of type 'Node'.

2 errors — typescript 7.0.2, 55 ms
```

The compiler is your pewter's own — the one in its `node_modules`, restored
by `git clone && npm i` along with everything else, and the one your editor
picks up when you open the folder. Nothing carries a second copy that could
disagree with it.

It is also the one command with no host in it. Everything else in `pewt` is a
call over the folder, and this reads the disk where you typed it, because the
moment you want a typecheck is while you are writing rather than while a
browser is attached. `pewt check` in a git hook works with nothing running.
For the same reason there is no `pewt.check()` for an extension to call: the
API is the host's table, and this is not on it.

Exit codes say which kind of no: `0` clean, `1` the compiler found errors,
`2` there was nothing to check with. The last is separate because "your code
is wrong" and "this pewter has no compiler" need different fixes.

## Running things on your machine

An extension runs in a browser tab. It cannot compile anything, touch git,
or start a process. When it needs one of those, it asks:

```ts
await pewt.run("build", {
  repo: "fsio",
  onOutput: (line) => log.append(line),
});
```

The callback stays in your tab. Only the call's number crosses the message
channel, and the shell sends each line back against that number — so a
function you pass here is an ordinary function, not something shipped
across a boundary.

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
host asks before starting anything.

Typing `pewt run build --repo fsio` in a terminal does the same thing, and
exits with the script's own exit code the way `npm run` does.

### Terminals

A script is what a project already declares. A terminal is everything else:

```sh
pewt shell --repo fsio
```

That is your shell — `$SHELL`, on a real pty, starting in the project you
named. It exits with its own exit code, and it stops if the host stops.

A tab can hold one too, and it is the same operation:

```ts
const shell = await pewt.shell({ repo: "fsio", onData: (bytes) => term.write(bytes) });
shell.write("git status\n");
shell.resize(term.cols, term.rows);
await shell.exit;
```

What arrives is the terminal's own bytes, escape sequences included, so
whatever draws it is a terminal emulator you chose. Nothing about the
terminal is built into the shell.

The host asks before it opens one, the same way it asks before a run, and
`pewt serve --allow-shells` is the separate answer-in-advance for a host
nobody is sitting at. Separate from `--allow-runs` on purpose: something
that was told it could build a project has not been told it can do
anything.

Nothing confines what a shell can reach. It is your account on your
machine, and the host's question is the whole control — see "Looking into
the Future".

## Agents

Pewter ships no agent. It carries the Agent Client Protocol: an agent is an
ordinary process on your machine whose stdio rides the folder — the same
channel everything else uses — and **the tab is the ACP client**.

That last part is what makes the rest work. `session/request_permission`
and `fs/read_text_file` arrive as requests from the agent, and the party
that should answer them is the one with you and the folder in front of it.
So the agent's permission question becomes a screen somebody designed
rather than a redraw inside a terminal nobody can style, and its file reads
are served through the grant you already made.

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
the roster says which is which before you pick — along with the version you
have, because that answer was measured against one build and yours may not
be it. The host asks before it starts an agent, and its question repeats
whether this one will ask you back.

The conversation happens in a tab. `extensions/chat/` is an extension like
any other: change how it looks, add to it, or replace it. From there the
agent reads `AGENTS.md` and works through `pewt` exactly as you would, and
the conversation rides the folder, so it lands in the same transcripts every
other session does.

The terminal spelling is a pipe rather than a chat:

```sh
pewt agent --repo fsio
```

One ACP message per line in on stdin, the agent's own messages out on
stdout. Nothing in between interprets either, which makes `pewt agent` the
thing a terminal can do that a tab cannot: be driven by another program.

An agent gets a synthesized environment rather than yours — eight variables,
plus `pewt` on its `PATH` so it can call back in. Nothing confines it, and
this is not confinement; it is the difference between a wall and not handing
over your ssh-agent socket to something nobody is sitting at.

## Tabs

A tab holds an extension. The shell holds the tabs, and that is nearly all
the shell is:

```sh
pewt tabs                       # what the page has open
pewt tabs add dashboard         # open an extension in a new tab
pewt tabs update tab-9f2c "Build log"
pewt tabs focus tab-9f2c
pewt tabs close tab-9f2c
```

```ts
const { id } = await pewt.tabs.add({ name: "dashboard" });
```

These are the first commands the **page** answers rather than the host.
Everything else in `pewt` is a question about your machine, and the machine
is where the answer is. A tab is not on disk anywhere: it exists because a
browser is open, it is gone when that tab closes, and nothing in the folder
remembers it. So the host cannot answer these — it forwards them down the
session the page already has open and hands you back what the page said.

Two things follow, and both are visible from a terminal:

- **They need a page.** `pewt tabs` exits 4 when none is open, which is a
  different fix from exit 3: start the host, or open the shell and hand it
  the folder.
- **Nothing asks you.** The host's question is for things it starts on your
  machine, and opening a screen your folder already contains starts nothing.

Adding a tab builds the extension first, so `pewt tabs add dashboard` on
something that does not compile is refused with the compile error rather
than opening a tab with nothing in it.

## Sending a file to the page

An extension is code that runs. A file is a snapshot of content. Three
commands send one, differing in who ends up holding the bytes:

| Command | What the page gets | If the file is deleted |
| --- | --- | --- |
| `pewt open <path>` | A view of the file, read through your grant | The tab reports it is gone |
| `pewt fling <path>` | A copy in the browser's storage | The tab keeps working |
| `pewt publish <path>` | A copy other people can open (not built) | The tab keeps working |

```sh
pewt open repos/site/README.md
pewt fling repos/site/dist/report.html
pewt files                      # the copies the page has custody of
pewt files show file-9f2c
pewt files drop file-9f2c
```

**The path is inside the pewter, and nothing else is.** Both commands hand
the page a path and the page opens the file itself, through the same one
grant that carries the transport — so no bytes ride the wire in either
direction, `fling` has no size limit of ours, and a path that climbs out of
the folder is refused rather than resolved. Sending a file from elsewhere on
your machine is a thing neither command does.

From a terminal the path is resolved the way your shell meant it, so
tab-completion inside a project works; from an extension it is always
relative to the pewter, because an extension has no working directory.

`fling` is how a build output outlives its build directory. Delete
`dist/`, stop `pewt serve`, revoke the folder: the tab still works,
because the page holds the bytes. An extension does not work that way. The
shell may still have its code cached, but an extension with no host cannot
call anything, so it renders and then sits there.

A copy outlives more than the file. Tabs die with the page — a tab exists
because a browser is open — and a copy does not, so a reload leaves you
holding bytes with nothing showing them. That is what `pewt files` is: the
catalog of what this page owns, and `pewt files show` puts one back in a tab.
`pewt files drop` is how you take it back, and it closes the tabs onto it.

## The pewt command line

`pewt` only runs inside a pewter. Outside one it is not installed, so
there is nothing to run.

```
PEWTER      serve · check · doctor · api   (doctor, api not built)
PROJECTS    repos {create, clone, link, rm} · template {new, apply}   (link, rm, template not built)
RUNNING     run · shell · agent · agents
THE PAGE    tabs {list, add, update, close, focus} · open · fling
            files {list, show, drop}
EXTENDING   ext {new, rm, bundle}
THE RECORD  grants {list, revoke} · sessions {log, replay}   (sessions not built)
SHARING     publish · share · join · workspaces   (not built)
```

Commands that act on a project accept `--repo`; every command accepts
`--json`, and the ones that start something accept `--dry-run`. Exit codes
distinguish the two ways the system can be unavailable: `3` means no host
is running, and `4` means no page is open. They need different fixes.

`pewt run` is the exception, and it is the exception `npm run` set: it
exits with the script's own code, because a script that calls it wants the
build's answer. So a script that exits 3 and a pewter with no host look
alike from the outside, and the line on stderr is what tells them apart.

## One API, two ways in

The command line and an extension are two front ends over one set of
operations. Neither is the real one:

| From a terminal | From an extension |
| --- | --- |
| `pewt repos` | `await pewt.repos.list()` |
| `pewt repos create site` | `await pewt.repos.create({ name: "site" })` |
| `pewt repos clone https://…/site.git` | `await pewt.repos.clone("https://…/site.git")` |
| `pewt run build --repo site` | `await pewt.run("build", { repo: "site" })` |
| `pewt shell --repo site` | `await pewt.shell({ repo: "site" })` |
| `pewt agents` | `await pewt.agents.list()` |
| `pewt agent --repo site` | `await pewt.agent({ repo: "site" })` |
| `pewt tabs add chat` | `await pewt.tabs.add({ name: "chat" })` |
| `pewt open notes.md` | `await pewt.open("notes.md")` |
| `pewt fling report.html` | `await pewt.fling("report.html")` |
| `pewt files` | `await pewt.files.list()` |

The spellings differ where each side has its own conventions. The
operations do not. Adding one adds both, so there is no second surface to
keep in sync, and nothing that ships in a new pewter has access your own
code lacks.

Where an operation is *answered* is not part of the deal either. `repos` is
answered on your machine and `tabs`, `open`, `fling` and `files` in the
browser; both are one call in either spelling, and neither front end is told
which it got.

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
12:06:02  ▸ run build --repo fsio                   from the page
12:06:02    ?   npm run build
12:06:02        vite build
12:06:02        cwd repos/fsio/
12:06:02      allow once / allow always / deny  [o/a/D] a
12:06:02    ✓ standing grant recorded → .pewter/grants.json
12:06:02      any run in fsio — take it back with `pewt grants revoke run/fsio`
12:06:09    ✓ exit 0 · 41 lines of output
```

The question appears in the terminal, not in the page. The page is the
thing asking for permission, so the page cannot be the thing granting it.

Sending a tab title does not prompt — and neither does `pewt repos clone`,
which does start a process. The line is not "starts a process" but "runs
something of yours or something fetched": git fetches and executes nothing
it fetched, the same reasoning that leaves `pewt check`'s compiler and
`ext bundle`'s esbuild unasked. What a clone widens — the host reaching a
network address somebody chose — is said here rather than put behind a
prompt with no scope to offer.

### What "always" remembers

`allow always` writes a standing grant to `.pewter/grants.json`, and the
next question of that shape is not asked. What a grant covers is deliberately
narrower than the question that produced it:

| You answered `a` to | The grant covers | Called |
|---|---|---|
| `run build --repo fsio` | any run in `fsio` | `run/fsio` |
| `agent pi-acp --repo fsio` | `pi-acp` in `fsio` | `agent/pi-acp/fsio` |
| `shell` | nothing — there is no third answer | — |

A run's grant is the project rather than the script, because a script is a
line in that project's `package.json` and the next one is a line away: what
you are trusting is the project. An agent's names the adapter as well,
because the line you read before answering was whether *that* adapter asks
before it edits, and carrying that answer over to different software would
answer a question nobody asked.

A shell has no standing grant at all. It is unconfined — its own question
says so — so an `always` would mean "always, anything", and there is nothing
in the question to scope it with. Typing `a` there is denied and told why,
rather than quietly treated as `allow once`.

`pewt grants` lists what this pewter remembers and `pewt grants revoke <id>`
takes one back, which the very next question feels: the host reads the file
each time it asks rather than holding a copy. `.pewter/` is git-ignored, so a
grant does not travel with a clone, and deleting the file costs you the
questions again and nothing else.

A host with no terminal in front of it — started by a script, by CI, or in
the background — cannot ask, so it cannot allow anything it was not told
about in advance. `--allow-runs`, `--allow-shells` and `--allow-agents` are
that telling, and they are three flags rather than one: something told it
could build a project has not been told it can open a terminal, or run a
coding agent on your work. All three are meant for hosts nobody is sitting
at.

A standing grant is the other kind of telling in advance, and it applies to
those hosts too: a background `pewt serve` cannot ask, but it still honours
what you already answered. That is what makes a grant worth having over a
flag — it is narrower, and it costs a keystroke rather than a restart.

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

## Looking into the Future

**Limits on what an extension can ask for.** The sandbox stops an
extension from reaching around the API. It does not narrow the API: any
extension can call any operation, read any file in the folder you granted,
and run any script your projects declare. Restricting that per extension
needs a permission model, and there is not one. What you have instead is
that you can read the code, and that the host asks before it runs anything
new.

**Confinement.** Nothing Pewter starts is confined. A script from `pewt
run` and a shell from `pewt shell` are ordinary processes running as you,
so either can read your ssh keys, write outside the folder you granted,
and reach the network. What stands in front of them is the host's
question, and the question is answered per process rather than once.

That is a choice, not an omission. Confining a child process is
per-operating-system work — the `terminal-demo` in this repository does it
with `sandbox-exec`, which exists on macOS and nowhere else — so a
confined Pewter would be a Pewter whose shells behave differently
depending on where you run it, and whose shells cannot use `~/.ssh`,
`~/.npm` or `~/.config` without carving each one back out by hand. The
version worth building is one where the confinement is legible: you can
read what a shell may reach before you allow it, and the answer does not
depend on which machine you are on. Unbuilt and unscheduled.

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
