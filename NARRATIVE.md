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

## Why the hub is part of the story

[D19](spec/DECISIONS.md#d19--the-hub-pivot-one-transport-folder-as-a-socket-workspaces-as-resources)'s
folder-as-socket is what makes every act feel *installed* rather than
rigged: one grant per origin ever, and thereafter agents of either
topology just show up on it. The hub's service directory
([#70](https://github.com/dglazkov/fsio/issues/70)) is where act 4's
tool discovery lives; the consent spine
([#6](https://github.com/dglazkov/fsio/issues/6)/[#46](https://github.com/dglazkov/fsio/issues/46),
[#76](https://github.com/dglazkov/fsio/issues/76)) is what keeps the
ladder honest once the actor climbing it is autonomous.

## Contrast to hold in every telling

Cloud sandboxes are "trust us with a copy of your repo." Local CLI
agents are "trust the binary with everything, day one." This is the
version where trust is incremental, legible, and enforced by parties
the user already trusts — that sentence is the demo track's thesis,
and every act should end on some form of it.
