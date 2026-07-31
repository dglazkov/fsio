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
   [D10](spec/DECISIONS.md#d10--json-rpc-20-control-plane-over-rpc-frames)
   frames are symmetric, so composition costs nothing to build —
   only something to show.

## Season two — whose agent is it

Acts 1–5 are one human, one machine: they prove *where the agent runs
is a deployment detail*. Season two
([#78](https://github.com/dglazkov/fsio/issues/78)) opens a different
claim: **whose agent it is becomes a grant, not a possession.** A
small team shares a chat-like room (a deliberately boring cloud web
app — rendezvous, identity, chat); each member's machines lend
capabilities to the team; friends borrow each other's agents. The
member's tab is the junction — the only place holding both the fsio
grant down to the machine and the cloud connection out to the team —
so borrowing is borrowing a *service*, never credentials or shell
access.

The ladder grows its fourth rung: see / edit / run / **share** — and
the share rung is not a step on top but a **recursion of the whole
ladder**: what a borrower is granted is itself see-shaped (a
read-only agent), edit-shaped (daemon-judged writes), or run-shaped
(spawns under the owner's policy), climbed by an actor who is
autonomous *and borrowed* — deliberately the consent spine's
([#6](https://github.com/dglazkov/fsio/issues/6)/[#46](https://github.com/dglazkov/fsio/issues/46),
[#76](https://github.com/dglazkov/fsio/issues/76)) hardest case.
Consent renders in the owner's surfaces, where the owner is. And the
cloud layer supplies the one thing the transport structurally cannot
([D15](spec/DECISIONS.md#d15--origin-is-client-stamped-advisory-and-display-only)
was right to refuse to fake it): a trust anchor — grants name a
*person*, not an origin.

The honesty clause carries over: the cloud room is a real server; the
claim survives precisely because the transport *to the machine* still
has none. Season two's demo point is that the two compose.

## What pewter.town is

The mental model has to come before the walkthrough, because the
pieces alone read as a box of parts — here are the legos, go wild:
generative and confusing at once. LEGO is not generative because it
has many pieces; it is generative because every brick shares one
connection grammar. So, stated once:

**pewter.town is a room where your computer is also a member.**
People join, and their pewters join with them. A pewter is a
teammate-shaped thing: it has a name, a roster of skills (its named
services —
[D24](spec/DECISIONS.md#d24--the-service-directory-is-the-origin-facing-capability-document)/[D27](spec/DECISIONS.md#d27--reach-attaches-to-the-grant-not-the-workspace)'s
noun), a presence dot, and an owner whose glance is its conscience.
Every piece in the season obeys one grammar: **a named service, on
someone's pewter, borrowed under a shape, visible in the room.**
`fsio expose github` is a pewter learning a skill; borrowing is
asking a teammate's pewter to do something; the shape is what its
owner said it may do and for whom; the feed is the room watching it
happen.

The model is pre-trained: every team already lives in a chat app
with deploy bots and CI bots in the channel. The delta is one
sentence — *the bots are your teammates' machines, and they leave
when their owners do.* The model also answers "what is this place"
negatively, which matters as much: not remote desktop, not a VPN,
not self-hosted CI, not an MCP registry — a room; those are merely
skills members might have.

Two cautions are built in rather than discovered. Personification
has an accountability edge: "Bob's pewter did it" must never obscure
*Alice asked it to* — the feed line is always `alice, via Bob's
pewter`, D15's display-honesty carried into the social layer. And
membership must not swallow the asymmetry: you can be in the town
without bringing a pewter (borrowers, spectators, the new hire);
bringing one is the graduated commitment.

**The spectrum: what a pewter can lend.** The roster is not a list
of one kind of thing. Borrow a *command* (`test-runner`, exit
codes), a *tool* (a stdio MCP server), an *agent* (a conversation
with keys), a *running app* (the dev-server preview), *compute* (the
closet GPU box; the one Mac whose Keychain signs the iOS builds), an
*entitlement* (the owner's subscription tokens), or a *place* (a
workspace — the most fsio-native service of all: season one shared a
folder with a page, season two shares one with a person's agent).
Consent posture varies *predictably* along the spectrum:
typed-and-narrow at the shallow end
([F25](spec/FINDINGS.md#f25--a-stdio-mcp-server-runs-under-a-deny-default-profile-in-15-rules-5-of-which-are-the-services-reach-the-same-server-under-the-shell-posture-reads-everything):
an MCP server confines under deny-default in 15 rules, 5 of them the
service's own reach), open-ended and identity-bound at the deep end
([F26](spec/FINDINGS.md#f26--placement-moves-a-childs-state-but-not-its-identity-the-agent-clis-credential-lives-in-the-os-keystore-so-a-deny-default-profile-silently-logs-it-out):
an agent's credential lives in the OS keystore, and no profile can
narrow it away without logging the agent out). Each demo beat picks
a point on this spectrum on purpose.

**Shapes do two jobs, and that is the trick.** A shape
([#76](https://github.com/dglazkov/fsio/issues/76)) is the *consent*
contour — what this grant permits — and simultaneously the
*compatibility* contract — what can plug into this slot. The same
object that makes a borrow safe makes the parts interchangeable. In
the grammar above, the shape is the stud pitch: "go wild" and "stay
safe" don't fight, because the connection grammar and the consent
grammar are the same grammar.

## What each seat gains

**The owner becomes a host.** His machine becomes a place other
people visit. He lends the service and keeps the keys — and F26
makes that literal: his credentials live in the OS keystore and
structurally *cannot* travel, because they cannot even be placed
into a directory. He watches the work happen —
`alice@pewter.town ran test-runner in fsio (exit 0)` in his
scrollback — with ctrl-C and tab-close as physically enforced
revocation. And the afternoon he spent wiring MCP servers, seeding
the database, and configuring the agent stops being a private sunk
cost: **configuration becomes capital**, a team asset the moment it
works once. Every team has the person who gets tools working; the
town turns that person from a bottleneck ("ask Bob how he set it
up") into a quartermaster ("borrow Bob's").

**The borrower gets capabilities at zero footprint** — no picker, no
install, no `~/.fsio`, nothing created on her machine — and what she
borrows comes in four kinds, each a kind of Bob-ness her own machine
cannot supply:

- **Entitlement** — Bob has a subscription; Alice doesn't. Borrowing
  his agent is the *only* way to share the subscription without
  sharing the credential (F26 again: the key cannot move). What the
  cost ledger held as a risk flips into the product — "Alice may use
  claude, up to N turns a day" — and the #76 shape grant grows its
  quantitative axis. Told honestly, this is *lending metered access
  to your agent*, never account-splitting: the same mechanism
  wearing a ToS-shaped target.
- **Knowledge** — ask the project, not the person. Bob's agent sits
  in the actual repo with Bob's context and memory; Alice gets
  grounded answers on demand, and Bob stops being the human FAQ for
  his own project.
- **Contribution** — the zero-setup contributor. The designer, the
  PM, the collaborator who was never going to install a toolchain
  tells Bob's agent "make the header sticky" and has contributed
  sixty seconds after clicking the invite. (Honest gap: seeing the
  result pulls a preview-shaped service into scope.)
- **Authority** — Alice cuts the release she holds no keys for, by
  driving Bob's agent while the prompts land on Bob's screen and he
  turns the key. The npm token and the signing cert never move.

Alice's walkthrough is the arc through the four, in that order —
each beat adds a kind of Bob-ness to the same mechanism. Two rules
of scenario craft, learned by discarding a beat: choose
**capability-shaped** stories (they fire on every collaboration —
questions, onboarding, releases) over *recovery-shaped* ones (a
borrow that only pays off after a rare failure — "a test only Bob's
machine can reproduce" — asks the audience to first believe in the
blue moon); and stage a repo holding **unpushable state** (the
credentialed server, the seeded local database, the running
process) — otherwise borrowing is theater, because the borrower
could clone and run her own.

## Consent at team velocity

Consent-by-prompt does not survive contact with a team. At team
frequency, prompts degrade into consent *theater*: either the owner
becomes the team's latency floor, or he habituates and
rubber-stamps — and a prompt that fires often enough launders
anything through it. Structurally it was already dead: `fsio up`'s
whole point is a pewter online while unattended, and an unattended
pewter has no screen for a prompt to land on. The attendance ladder
and the consent ladder must move together.

The replacement is not fewer prompts but a different stack — the
credit-card model instead of the toll booth. Nobody approves
individual card swipes; a limit, a statement, an anomaly alert, and
a kill switch together are *stronger* consent than per-transaction
approval ever was:

- **Shape** (#76) — service, scope, workspace, declared once at
  grant time. Here
  [F24](spec/FINDINGS.md#f24--the-wall-is-a-write-wall-a-confined-child-inherits-the-hosts-entire-environment-ssh-agent-socket-included-and-reads-every-file-the-user-can-read)'s
  honesty clause becomes load-bearing: a standing grant's consent
  sentence is said once and holds forever, which is exactly why the
  wall behind it must be measured (F23/F25), not asserted.
- **Budget** — tokens, turns, rate: the quantitative axis the
  entitlement borrow forces.
- **Audit** — the feed while attended, the statement while not:
  "while you were out: alice, 14 tool calls, 2k tokens, all within
  shape." Non-blocking awareness is a different thing from blocking
  consent; conflating them is the original sin of prompt-everything
  designs.
- **Revocation** — ctrl-C, tab close, `fsio unshare`: cheaper than
  granting, which is what makes generous standing grants rational.

Prompts are *rationed*, not abolished — a prompt's meaning is
inversely proportional to its frequency. Spend them where stakes are
high and frequency is low (the release, the first session of a new
borrow, a request stepping outside shape), where they read as
**ceremony**: the owner deliberately turning the key while the
borrower watches. Out-of-shape requests *queue* for the owner's
next glance instead of block-modaling anyone.

No new mechanism is owed.
[D12](spec/DECISIONS.md#d12--spawn-policy-is-a-host-side-hook-confirmation-is-an-async-policy)
already says confirmation is an async *policy* behind a host-side
hook — it never mandated a dialog. The owner's own spawns may still
prompt (he is present by definition when he is the caller); borrowed
principals get their calls evaluated against the grant shape. One
policy table, keyed by principal. The threat model shifts
accordingly: a borrower never needs to escape the sandbox — she can
just *ask* — so the boundary that matters is the D12 policy plus the
owner's attention, which is on-thesis: incremental, legible,
enforced by a party the owner already trusts.

The demo shot this buys: the owner's screen is a **feed**, not a
stack of dialogs — tool calls scrolling by within shape, a meter
ticking, one queued escalation waiting — and exactly one modal all
day, at the release, when both parties mean it.

## The bench

Composition is symmetric: any slot in a working setup can be filled
by any member's service. Bob brings the checkout, Alice brings the
agent that works on it — her harness, his filesystem, every access a
service call judged by his daemon (for borrowers the browser wall
never existed to begin with). So the room needs a second-order noun.
Services are the bricks; what stays on the table overnight is the
build: a **bench** — a named, standing assembly with typed slots.
Workspace: Bob's. Database: Carol's. Toolbelt: Dana's Figma plus the
github server. Agent: *whoever sits down*. The slots are typed by
shape — which is what makes them swappable at all.

A bench is **attachment, not replication** — the genuinely new part.
Every prior "same setup" story (dotfiles, devcontainers, cloud dev
environments) replicates, and replicas drift. A bench cannot drift
because there is one of it. Jack stands up in Kyiv, Jill sits down
in Portland, and it is the *same running setup*, literally — the
sunchase: work follows the sun around a bench that never empties,
and nobody stood up cloud infrastructure to get it.

The sunchase forces exactly the right questions, and the findings
already hold answers:

- **Continuity lives in placed state — F26 promoted from limitation
  to design.** For Jill to pick up after Jack, the session
  (transcript, memory, in-progress context) must outlive Jack's
  agent. That is precisely the half of placement that works: state
  places into the host-owned slot; identity does not, and should
  not. Put the session slot on the workspace side of the bench and
  any member's agent sits down, resumes the conversation, and brings
  its *own* keys. The conversation belongs to the bench, not the
  agent.
- **The night problem is residency's real sales pitch.** A bench
  anchored on a commuter's machine loses its floor when that owner
  sleeps. "Bob adds a second repo" was bookkeeping; "the bench must
  not empty when you sleep" is a reason to run `fsio up`.
- **The sitter rotates with the sun.** Escalations queue for whoever
  is awake and holds the role — a grant kind the ladder has not
  needed before: holding a *role* (sitter, approver), not borrowing
  a service. Flagged here, not designed.
- **One physics note:** an agent doing file I/O against a
  cross-continent workspace is the most latency-sensitive
  composition in the pool
  ([#88](https://github.com/dglazkov/fsio/issues/88) gains its most
  demanding customer). The answer is already in the thesis:
  placement is a deployment detail, so hot loops co-locate agent and
  workspace — the *choice* is what's free.

## Commuters and residents

The last piece: a **server-only pewter**. One command on a bare
Linux box —

    fsio serve --workspace ./repo --expose test-runner,github \
      --room pewter.town/acme

— and a new member appears in the room with no human attached. This
is the fourth rung of the host's own attendance ladder —
session-scoped tab → foreground TTY → daemon-plus-tab → **standing
server** — each rung trading attention for availability, each
re-anchoring consent in a surface appropriate to it. For the server
rung the anchor is the invocation itself: **the command line is the
consent sentence**, legible in scrollback and `ps`, the whole shape
in argv —
[D28](spec/DECISIONS.md#d28--durable-grants-are-minted-on-return-not-first-run)'s
logic transposed from return-visit to launch.

Architecturally the move is smaller than it looks, if the hub folder
stays. The tab was never magic; it was the *junction* — the one
place holding both the machine grant and the room connection. The
server pewter collapses the junction into a process but keeps the
hub as the data plane: a headless connector plays the tab's role
over the same D10 frames,
[D19](spec/DECISIONS.md#d19--the-hub-pivot-one-transport-folder-as-a-socket-workspaces-as-resources)/[D20](spec/DECISIONS.md#d20--the-hub-folder-carries-transport-and-advertisement-authority-lives-outside-it)
carry over wholesale, and a local editor on the server still
attaches to the hub (the mirror hall works headless). The browser is
revealed as what it always was: one costume for the junction role —
season one's reveal one level up. Season one: "local vs. cloud
agent" was never an architecture, only where you cut the stdio.
Season two: "laptop vs. server" was never an architecture — a pewter
is a role.

One consequence has teeth: **headless, the confinement track is the
wall.** On a browser pewter, Chrome enforces the folder boundary and
the profile is the second wall; on a bare server the "other party"
is absent, and the
[F23](spec/FINDINGS.md#f23--child-confinement-is-transitive-to-any-depth-and-cannot-be-re-entered-in-either-direction-setuid-binaries-become-unexecutable)–F25
program (composed before the spawn —
[D29](spec/DECISIONS.md#d29--profiles-compose-before-the-spawn-confinement-is-inherited-and-cannot-be-re-entered)
— deny-default, transitive) is the only wall the consent sentence
can lean on. A Linux confinement lane (landlock/namespaces as the
Seatbelt analog) graduates from nice-to-have to prerequisite, and
F24's honesty clause governs what `fsio serve` may claim.

Socially, the room absorbs the new member and even names it: laptop
pewters **commute** — they arrive with their humans and leave with
them, presence lit by attendance — and server pewters **reside**,
which was already the narrative's word for the daemon posture.
Residents are where benches anchor. A resident has no tab to
background, so
[F16](spec/FINDINGS.md#f16--filesystemobserver-is-not-throttled-in-hidden-tabs-adaptive-mode-degrades-to-observer-cadence-in-the-background-and-recovers-instantly)'s
background clamp does not apply to it and #88's hardest cases become
commuter-only concerns. And the team's spare metal — the closet GPU
box, the $5 VPS, the office NAS — joins the roster with one command
and zero platform engineering: the union of rosters now includes
machines nobody sits at.

The danger is named as a principle, because it is real: standing
presence outcompetes attended presence, benches will drift
resident-ward by gravity, and at the bottom of that slope the town
has quietly become a PaaS with extra steps — the exact thing it was
an alternative to. The answer is not resisting the drift but a
constitutional line: **residents hold work; humans hold grants.** A
resident is a member, never a sitter — it cannot approve
escalations, mint shares, or widen shapes; every grant it operates
under traces to a person's invocation or click; and the feed still
says `alice, via team-pewter`. Consent never delegates to unattended
members. This sharpens
[#87](https://github.com/dglazkov/fsio/issues/87) too: a resident
authenticates to the room as a *machine* principal minted at join —
the person/machine identity split stops being implicit the moment a
member has no face. Presence renders the split honestly: a face-dot
for commuters, a house-dot for residents.

## The team it makes amazing

Season two's target posture is small — a 2–9 person team doing rapid
prototyping — and the pitch compresses to one sentence: **a team's
effective capability today is the *intersection* of its members'
setups; pewter.town makes it the *union*.** Everything such a team
is slow at traces to the intersection: the prototype only runs where
it was built, the tool only works where it was configured, the
credential exists on one machine, the GPU is in one room. On the
union, five people get a platform team, a device lab, a model host,
and an internal-tools group — made of hardware they already own,
with zero ops, because the infrastructure is presence.

Daily life, in room grammar:

- **Demo without deploy.** The running prototype on a member's
  machine is a borrowable service — "come look at my branch" with no
  staging environment, no preview build, no CI gate. For this team,
  likely the most-fired beat of the week.
- **The team database on Carol's laptop.** One seeded, canonical,
  MCP-fronted source of truth — hosted by nobody.
- **Communal hardware.** Dana's Mac Studio serves the local model —
  entitlement sharing generalized to compute, with the privacy bonus
  that the team's data never leaves the team's machines.
- **Toolbelts multiply.** Borrowed agents don't compose — you can't
  merge conversations — but borrowed tools do: five members × three
  services each puts fifteen tools on every agent in the room. The
  union made mechanical.
- **Onboarding is the ladder read backwards.** Person four joins
  Tuesday, borrows everything day one, contributes within the hour,
  and graduates toward owning a setup rung by rung.
- **Ephemerality is hygiene.** Prototypes die fast, and cloud infra
  for a dead prototype is undead infra. A borrowed service's
  lifecycle *is* presence: close the tab and the infrastructure
  ceases to exist. Zero decommissioning, enforced by physics.

When sorting future beats, two axes: how often it fires (hourly /
weekly / launch-day) and where it sits on the spectrum (how honest
its consent sentence is). A telling that opens ambient (toolbelts),
runs hourly (ask-the-project, demo-without-deploy), and climaxes
weekly at maximum stakes (the release ceremony) covers the map.

## Season two, visualized: pewter.town

An aspiration written as a walkthrough, so the abstractions have to
cash out in directories and gestures. Suppose the site exists —
people register their 'puters, see each other's rosters, and borrow
each other's resources (MCP servers, local agents, test runners) to
do real work. Bob registers his pewter and invites Alice to hack on
a repo together. What actually happens?

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

**Graduation, not installation.** Bob adds a second repo, or the
team stands up a bench that must not empty when he sleeps: `fsio
up`. Only now does the daemon exist, the hub folder appear, and the
one genuinely awkward picker gesture — pick `~/fsio`,
[#69](https://github.com/dglazkov/fsio/issues/69)'s subject — arrive,
after the value is proven and Bob is invested. He exposes resources
by name: `fsio expose github`, a `test-runner` shape for `npm test`.
The directory advertises names — never paths, never a shell.

**The invite.** Bob shares `test-runner` with Alice — deliberately
the lowest-stakes borrow on the spectrum, the mechanism at zero
risk. The consent sentence names a person, a service, and a place —
"Alice may use test-runner in workspace fsio" — the (principal ×
service × workspace) triple the grant binds
([D27](spec/DECISIONS.md#d27--reach-attaches-to-the-grant-not-the-workspace)),
with the person anchored by the cloud layer's identity, the one
thing the transport structurally cannot supply.

**Alice, day one — the punchline, then the arc.** Alice picks
nothing. No picker, no install, no `~/.fsio`, not one directory
created on her machine. Her click travels tab → cloud → Bob's tab →
Bob's hub → Bob's daemon, and the result flows back the same way.
The asymmetry is the design: borrowing is borrowing a service, so
the borrower's trust ask is zero. Her first borrow is the throwaway
one — `test-runner` against her pushed branch, exit codes at zero
stakes. Then the arc from *What each seat gains*: she chats with
Bob's agent on Bob's meter (entitlement), asks it how the sync layer
works (knowledge), has it make the header sticky under Bob's shape
(contribution), and on Friday cuts the release while the one modal
of the week lands on Bob's screen and he turns the key (authority).
If Bob's terminal is open, he watches all of it scroll by.

**Jack and Jill, week two — the bench.** The team stands up a bench
for the sprint: workspace on the team's resident pewter (a $5 VPS
that joined with one command), Carol's database, Dana's toolbelt,
agent — whoever sits down. Jack stands up in Kyiv; Jill sits down in
Portland eight hours later and resumes the *same conversation* — the
session lives in the bench's placed state slot, and her agent brings
its own keys (F26 as design, not limitation). The bench never
empties, nobody ran a deploy, and the feed shows who sat where.

**Facts the telling must keep saying out loud.** For commuters, the
owner's tab is the bridge: Bob's pewter is online exactly while a
pewter.town tab holds the folder grant — presence is a consent
primitive enforced by physics, and closing the tab takes the pewter
offline. A resident trades that physics for consent-as-invocation,
which is why the constitutional line (*residents hold work; humans
hold grants*) is load-bearing. And for borrowers the browser wall
does not exist: Bob's see/edit rungs are enforced by his browser on
his own grant, but every action of Alice's arrives as a service call
judged by Bob's daemon alone — which is why season two's rule (*a
service, never credentials or shell*) is a property, not a style
preference.

## The staging device

One identical chat UI with a toggle: **brain: local / page.** Same
folder, same conversation, same D12 prompts; the only visible
difference is the
[D15](spec/DECISIONS.md#d15--origin-is-client-stamped-advisory-and-display-only)
origin line. The reveal: "local agent" vs. "cloud agent" was never an
architecture — it's where you cut the stdio, and the transport made
the cut relocatable. When the audience can't tell which side of the
machine boundary the harness is on, the D13 claim stops being a
slogan and becomes an observed fact.

Season two gets its own devices, same trick one level up. The
**agent: mine / Bob's** toggle: same chat UI, and the only visible
differences are the owner line and whose screen the prompts land on.
And the roster's two presence glyphs — face-dot for commuters,
house-dot for residents — where the demo moment is one command on a
bare VPS making a house-dot appear while every laptop in the room
sleeps.

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
rigged prop rather than an installed fact. And the server-only
pewter is the hub thesis at its purest — junction as a role, hub as
the data plane, no browser in the loop at all.

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

Season two adds the team-level contrast: cloud team infrastructure
is "stand up a service and manage its secrets"; pewter.town is "the
moment it works on one machine, the team has it." Same thesis, one
level up — and every season-two beat should end on some form of
*that*.
