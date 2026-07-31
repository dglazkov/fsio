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
5. **The mirror hall**
   ([#95](https://github.com/dglazkov/fsio/issues/95)): both
   directions as peers on one socket. A local editor attaches to the page agent;
   the page agent spawns the claude CLI as its subagent over ACP.
   [D10](spec/DECISIONS.md#d10--json-rpc-20-control-plane-over-rpc-frames)
   frames are symmetric, so composition costs nothing to build —
   only something to show.

The arc ends here, on its own thesis: when the audience can't tell
which side of the machine boundary the harness is on, the D13 claim
stops being a slogan and becomes an observed fact.

## The staging device

Every claim gets the same theatrical form — one identical chat UI,
one toggle, an audience that cannot find the seam.

Season one's toggle: **brain: local / page.** Same folder, same
conversation, same D12 prompts; the only visible difference is the
[D15](spec/DECISIONS.md#d15--origin-is-client-stamped-advisory-and-display-only)
origin line. The reveal: "local agent" vs. "cloud agent" was never an
architecture — it's where you cut the stdio, and the transport made
the cut relocatable.

## The hub's role: multiplier, not dependency

The narrative and the hub
([D19](spec/DECISIONS.md#d19--the-hub-pivot-one-transport-folder-as-a-socket-workspaces-as-resources),
`track: hub`) are deliberately separable bets. **Every act must
remain playable in degenerate mode** (folder = workspace = transport
— a hub of one), so the tracks can fail independently: no demo is
sequenced behind #70–#72, and no act's thesis may quietly assume the
daemon. The hub is an ergonomics and posture *multiplier* — one
grant per origin ever, workspaces as parameters, the
installed-capability feel — never a dependency.

The track carries itself on those merits: one grant per origin
ever, multi-workspace routing under a single picker gesture, the
daemon as the residence of spawn policy, and multi-client attach
(the mirror hall runs through it). Whether that holds the track's
current priority is a live question, re-argued where AGENTS.md says
priorities live — in the hub-track issue comments — not assumed
here.

The tracks still braid: demos are the hub spec's requirements
generator, and pre-hub demo work keeps its session-setup layer
deliberately disposable — that's the part D19 kills. The consent
spine
([#6](https://github.com/dglazkov/fsio/issues/6)/[#46](https://github.com/dglazkov/fsio/issues/46),
[#76](https://github.com/dglazkov/fsio/issues/76)) stays designed
once — it's what keeps the ladder honest when the actor climbing it
is autonomous.

## A season that isn't here

A second season was once drafted in this document — a team-facing
product built above the transport. It was spun out as a separate
project in July 2026 and does not track back here; the arc ending at
act 5 is by design, not truncation. Git history has the full story.
The consent grammar it exercised — the capability rungs, shape
grants, the (principal × service × workspace) triple
([D27](spec/DECISIONS.md#d27--reach-attaches-to-the-grant-not-the-workspace)),
confirmation-as-policy
([D12](spec/DECISIONS.md#d12--spawn-policy-is-a-host-side-hook-confirmation-is-an-async-policy)),
and the measured-confinement discipline
([F23](spec/FINDINGS.md#f23--child-confinement-is-transitive-to-any-depth-and-cannot-be-re-entered-in-either-direction-setuid-binaries-become-unexecutable)–[F26](spec/FINDINGS.md#f26--placement-moves-a-childs-state-but-not-its-identity-the-agent-clis-credential-lives-in-the-os-keystore-so-a-deny-default-profile-silently-logs-it-out))
— stays, because it stands on fsio-native ground: two *origins*
granted the same workspace already need per-asker reach, and a
chatty agent already needs consent that survives its cadence.

## Contrast to hold in every telling

Cloud sandboxes are "trust us with a copy of your repo." Local CLI
agents are "trust the binary with everything, day one." This is the
version where trust is incremental, legible, and enforced by parties
the user already trusts — that sentence is the demo track's thesis,
and every act should end on some form of it.
