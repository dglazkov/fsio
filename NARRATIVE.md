# The demo narrative

Issues carry the work; this doc carries the story. The demo track
(`track: demo`) is not a pile of showcases — it is one claim
demonstrated from successive angles, and each demo should be built
knowing which act it plays. Track membership and sequencing stay in
the issue labels and comments (per AGENTS.md); the through-line lives
here so it doesn't end up three comments deep.

## The claim

[D13](spec/DECISIONS.md#d13--session-kinds-are-a-host-side-registry-echo-is-just-an-entry)
states it: **a stdio-shaped bridge over files — bring your own
semantics.** The demos exist to make that claim falsifiable in front
of an audience. Agent harnesses are the most demanding consumer the
transport could have (interactive TUIs, streamed tokens, tool-call
round-trips, autonomous file mutation), so the agent demos are the
strongest evidence the claim will ever get.

## The acts

Every act is the same folder wearing a different protocol. The
recurring character is the **capability ladder** — see the folder
(picker gesture), edit it
([F20](spec/FINDINGS.md#f20--a-persisted-handle-with-allow-on-every-visit-spans-browser-restarts-revisit-is-zero-gesture)'s
durable write grant), run things (fsiod +
[D12](spec/DECISIONS.md#d12--spawn-policy-is-a-host-side-hook-confirmation-is-an-async-policy)
per-command prompts) — each rung a consent gesture the user
physically performs, each enforced by a different party (Chrome,
Chrome, the daemon).

1. **A web page is a terminal to your machine**
   ([#16](https://github.com/dglazkov/fsio/issues/16), shipped). No
   server, no websocket, no extension. Establishes the trick: stdio
   rides DATA frames over a shared folder.
2. **Local brain, cloud face**
   ([#18](https://github.com/dglazkov/fsio/issues/18)): a page
   drives an agent that lives on your machine — the browser is an
   ACP client, the agent's stdio rides the folder. Chat on the left,
   the living workspace on the right, one directory handle powering
   both.
3. **Cloud brain, local hands**
   ([#74](https://github.com/dglazkov/fsio/issues/74)): the
   inversion. The harness runs in the page; the machine contributes
   files (direct FS Access reads/edits — fsio uninvolved) and, once
   fsiod is present, execution (the bash tool *is* a spawn). The
   user brings their repo, not their runtime; the browser is the
   sandbox.
4. **Local tools for cloud brains**
   ([#77](https://github.com/dglazkov/fsio/issues/77)): the page
   harness articulates local stdio MCP servers — the toolbelt web
   agents can't otherwise reach. Files, shell, *and* the installed
   MCP ecosystem, behind the same ladder.
5. **The mirror hall** (unfiled; #44-shaped): both directions as
   peers on one socket. A local editor attaches to the page agent;
   the page agent spawns the claude CLI as its subagent over ACP.
   [D10](spec/DECISIONS.md#d10--one-control-file-per-side-json-rpc-batch-frames-data-rides-inside)
   frames are symmetric, so composition costs nothing to build —
   only something to show.

## Season two — whose agent is it

Acts 1–5 are one human, one machine: they prove *where the agent runs
is a deployment detail*. Season two
([#78](https://github.com/dglazkov/fsio/issues/78)) opens a different
claim: **whose agent it is becomes a grant, not a possession.** A
small team shares a chat-like room (a deliberately boring cloud web
app — rendezvous, identity, chat); each member's agents run locally
on their own machine in their own configuration; friends borrow each
other's agents. The member's tab is the junction — the only place
holding both the fsio grant down to the machine and the cloud
connection out to the team — so borrowing is borrowing a *service*,
never credentials or shell access.

The ladder grows its fourth rung: see / edit / run / **share** —
per-person × per-workspace ×
[#76](https://github.com/dglazkov/fsio/issues/76) shape grants,
consent rendered in the owner's tab, where the owner is. And the
cloud layer supplies the one thing the transport structurally cannot
([D15](spec/DECISIONS.md#d15--session-origin-is-host-stamped-display-only)
was right to refuse to fake it): a trust anchor — prompts name a
*person*, not an origin. Presence is capability presence: an agent is
borrowable exactly while its owner's tab is open.

The honesty clause carries over: the cloud room is a real server; the
claim survives precisely because the transport *to the machine* still
has none. Season two's demo point is that the two compose.

## Season two, visualized: pewter.town

An aspiration written as a walkthrough, so the abstractions have to
cash out in directories and gestures. Suppose a site — call it
pewter.town — that is season two wearing a product: people register
their 'puters, see each other's rosters, and borrow each other's
resources (MCP servers, local agents, test runners) to do real work.
Bob registers his pewter and invites Alice to hack on a repo
together. What actually happens?

**Three directories, one trained convention.** Agent harnesses
already taught users this shape: the directory you launch in is the
*scope*, and `~/.claude` is the *self* — keys, config, state. fsio
borrows it wholesale:

- `~/src/fsio/` — the **workspace**. Bob's clone, Bob's scope.
- `~/fsio/` — the **hub**
  ([D20](spec/DECISIONS.md#d20--the-hub-folder-carries-transport-and-advertisement-authority-lives-outside-it)):
  transport data plane, co-tenant-readable, no authority inside.
  Exists only once Bob graduates to a resident daemon.
- `~/.fsio/` — the **self**: registry, grant records, and
  per-(workspace × service) state slots —
  `~/.fsio/state/fsio/github/` holds that server's token, never the
  repo, never the hub. "Daemon-private" means private from *tenants*,
  not from Bob: it is a dotdir he can `ls`, exactly as legible as
  `~/.claude`.

**Bob, day one — the host climbs its own ladder.** `cd ~/src/fsio &&
fsio`. Foreground, in a terminal Bob is watching; the scrollback is
the audit log and ctrl-C is revocation. No daemon, no installer —
the host asks for rung-1 trust the same way it offers it to
children. When pewter.town asks to connect, the picker gesture is
the natural one: Bob picks his *project folder*, the same folder
rungs 1–2 (direct edit) and the transport both ride. Consent pixels
are the terminal itself — a page cannot reach, overlay, or clickjack
a TTY. The first visit ends session-scoped, deliberately: Bob can
walk away, no harm, no residue
([D28](spec/DECISIONS.md#d28--durable-grants-are-minted-on-return-not-first-run)).
When he returns, the site says *welcome back — one click makes this
permanent*, and the re-prompt mints durability at the moment
returning has earned it.

**Graduation, not installation.** Bob adds a second repo, or wants
his pewter online without babysitting a terminal: `fsio up`. Only
now does the daemon exist, the hub folder appear, and the one
genuinely awkward picker gesture — pick `~/fsio`,
[#69](https://github.com/dglazkov/fsio/issues/69)'s subject — arrive,
after the value is proven and Bob is invested. He exposes resources
by name: `fsio expose github`, a `test-runner` shape for `npm test`.
The directory advertises names — never paths, never a shell.

**The invite.** Bob shares `test-runner` with Alice. The consent
sentence names a person, a service, and a place — "Alice may use
test-runner in workspace fsio" — the (principal × service ×
workspace) triple the grant binds
([D27](spec/DECISIONS.md#d27--reach-attaches-to-the-grant-not-the-workspace)),
with the person anchored by the cloud layer's identity, the one
thing the transport structurally cannot supply
([D15](spec/DECISIONS.md#d15--origin-is-client-stamped-advisory-and-display-only)).

**Alice, day one — the punchline.** Alice picks nothing. No picker,
no install, no `~/.fsio`, not one directory created on her machine.
Her click travels tab → cloud → Bob's tab → Bob's hub → Bob's
daemon, and the result flows back the same way. The asymmetry is
the design: borrowing is borrowing a service, so the borrower's
trust ask is zero. Collaboration stays git-shaped — Alice edits her
own clone, pushes a branch, runs Bob's test-runner against it — and
if Bob's terminal is open he watches it happen:
`alice@pewter.town ran test-runner in fsio (exit 0)`.

**Two facts the telling must keep saying out loud.** The owner's
tab is the bridge: Bob's pewter is online exactly while a
pewter.town tab holds the folder grant, so presence is a consent
primitive enforced by physics — closing the tab takes the pewter
offline. And for borrowers, the browser wall does not exist: Bob's
see/edit rungs are enforced by his browser on his own grant, but
every action of Alice's arrives as a service call judged by Bob's
daemon alone — which is why season two's rule (*a service, never
credentials or shell*) is load-bearing and not a style preference.

## The staging device

One identical chat UI with a toggle: **brain: local / page.** Same
folder, same conversation, same D12 prompts; the only visible
difference is the
[D15](spec/DECISIONS.md#d15--session-origin-is-host-stamped-display-only)
origin line. The reveal: "local agent" vs. "cloud agent" was never an
architecture — it's where you cut the stdio, and the transport made
the cut relocatable. When the audience can't tell which side of the
machine boundary the harness is on, the D13 claim stops being a
slogan and becomes an observed fact.

## The hub's role: multiplier for season one, stage for season two

The narrative and the hub
([D19](spec/DECISIONS.md#d19--the-hub-pivot-one-transport-folder-as-a-socket-workspaces-as-resources),
`track: hub`) are deliberately separable bets. **Every act must
remain playable in degenerate mode** (folder = workspace = transport
— a hub of one), so the tracks can fail independently: no demo is
sequenced behind #70–#72, and no act's thesis may quietly assume the
daemon. For season one the hub is an ergonomics and posture
*multiplier* — one grant per origin ever, workspaces as parameters,
the installed-capability feel — never a dependency.

Season two is different: capability presence ("Bob's test-runner is
online") requires a standing, zero-gesture, multi-workspace socket,
which is the hub's thesis wearing a social costume. The service
directory ([#70](https://github.com/dglazkov/fsio/issues/70)) is the
local half of [#78](https://github.com/dglazkov/fsio/issues/78)'s
borrowable-capability roster — the room's roster is the union of
everyone's service directories, surfaced through their tabs. The hub
is season two's *staging requirement*: #78 runs without it, but as a
rigged prop rather than an installed fact.

The tracks braid rather than race: demo-first in build order,
hub-first in where the findings flow. Demos are the hub spec's
requirements generator (the #74 grant-composition fork surfaced on
#70 this way), and pre-hub demo work keeps its session-setup layer
deliberately disposable — that's the part D19 kills. The consent
spine
([#6](https://github.com/dglazkov/fsio/issues/6)/[#46](https://github.com/dglazkov/fsio/issues/46),
[#76](https://github.com/dglazkov/fsio/issues/76)) is shared by both
tracks and designed once — it's what keeps the ladder honest when the
actor climbing it is autonomous.

## Contrast to hold in every telling

Cloud sandboxes are "trust us with a copy of your repo." Local CLI
agents are "trust the binary with everything, day one." This is the
version where trust is incremental, legible, and enforced by parties
the user already trusts — that sentence is the demo track's thesis,
and every act should end on some form of it.
