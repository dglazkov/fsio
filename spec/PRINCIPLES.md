# fsio principles — what the platform refuses to trade away

Each entry follows the structure from
[The Structure of a Principle](https://glazkov.com/2021/10/29/the-structure-of-a-principle/):
context (the situation), forces (the tension the principle wrestles —
no tension, no principle), and guidance (how to navigate it). The
section title is the handle — the shorthand meant to be said out loud
in design arguments. Numbers (P1, P2, …) are stable and never reused;
a principle that stops earning its forces gets a superseded note, not
an edit.

Principles constrain design; they do not record decisions. When a
decision cites a principle, the principle is the *why behind the why* —
the test a whole family of decisions must keep passing. Companions:
[DECISIONS.md](DECISIONS.md) (ADR-lite),
[FINDINGS.md](FINDINGS.md) (measured platform behaviors),
[../NARRATIVE.md](../NARRATIVE.md) (the demo through-line these
principles distill).

## P1 — the URL travels; the data stays

**Context.** Every fsio scenario couples a distributable interface to a
resident machine: a hosted page drives a local brain, a web harness
reaches a local toolbelt, a static page serves a team with each user's
own machine as the backend. Every incumbent architecture instead moves
one to the other — cloud sandboxes take a copy of the repo, CLI
installs take custody of the machine.

**Forces.** Custody is genuinely easier. Sync, sharing, backup,
telemetry, and monetization all get simpler when the vendor holds the
data, so every feature considered will have a custody-shaped version
that is less work. Against that: residence is the entire
differentiation. The first feature that requires data to leave the
machine makes fsio an ordinary connector with extra steps.

**Guidance.** Ship interface, never custody. If a design needs data
off the machine, that is not a trade-off to weigh — it is a signal the
design is wrong for this platform; find the version where the
interface travels instead. Sharing means sharing a URL or a folder
grant, never uploading.

## P2 — if it didn't ride the folder, it didn't happen

**Context.** The transport is files, so the record of what software
did *is* the medium it did it in — the audit trail cannot be more
incomplete than the behavior was
([D9](DECISIONS.md#d9--segmented-log-with-cumulative-ack-flow-control)'s
log, the replay window). This is the platform's most unusual asset —
sessions as replayable artifacts, compliance as a property of the
architecture rather than a vendor's diligence — and it is
all-or-nothing.

**Forces.** Side channels will be proposed, each locally reasonable: a
websocket fast path for latency, a cloud queue for convenience, a
direct API call for just one thing. Every side channel makes some
feature easier. One side channel makes the record a partial account,
permanently — and a partial record has the credibility of a vendor
log, which is to say the incumbents' credibility.

**Guidance.** Everything between the parties rides the folder.
Optimizations adapt *within* the medium —
[D4](DECISIONS.md#d4--hybrid--adaptive-notification)'s hybrid
notification and
[D5](DECISIONS.md#d5--dirname-fast-lane-for-small-uplink-batches)'s
fast lane are the template — never around it. When a capability cannot
ride the folder, it is not an fsio capability yet; say so rather than
tunneling.

## P3 — trust is a noun

**Context.** Incumbent trust is an event: a binary yes at install,
invisible afterward, gone-but-not-revoked at uninstall. fsio's grants
are already objects
([D23](DECISIONS.md#d23--consent-is-host-served-and-grants-are-proof-of-possession-capabilities):
proof-of-possession capabilities;
[D27](DECISIONS.md#d27--reach-attaches-to-the-grant-not-the-workspace):
reach attaches to the grant;
[D28](DECISIONS.md#d28--durable-grants-are-minted-on-return-not-first-run):
minted on return) — with holders, histories, and revocation surfaces.
An object can be earned, lent, worn, delegated, and trained on; an
event can only be remembered.

**Forces.** Prompt fatigue is real, and an autonomous agent's cadence
makes it brutal — the pressure will always be to bundle rungs,
pre-approve, and make trust smooth by making it invisible again.
Against that: legibility is the thesis. The demo's climactic moment is
*watching* a grant happen.

**Guidance.** Every capability is a distinct rung with a distinct
gesture, and the object outlives the gesture: inspectable, revocable,
attributable to who granted it (which may differ from who benefits).
Fight fatigue by making grants durable and scoped —
[F20](FINDINGS.md#f20--a-persisted-handle-with-allow-on-every-visit-spans-browser-restarts-revisit-is-zero-gesture)'s
persistence, D28's return-minting — never by making them broader. No
rung is ever implied by another.

## P4 — fast is a mode, not a premise

**Context.** The headline numbers are millisecond RTTs, and the
demanding consumers (interactive TUIs, streamed tokens) justify the
tuning. But the strangest reachable futures — sessions over sync
services measured in seconds, air-gapped folders measured in days,
devices speaking through their own storage, substrates not yet
invented — exist only because the protocol never actually requires
speed.

**Forces.** Performance work wants invariants. It is tempting to let a
timeout, a heartbeat default, or a protocol assumption quietly encode
"the substrate answers in milliseconds." Each such assumption buys a
little polish and forecloses an entire timescale.

**Guidance.** Latency is a parameter; correctness must hold at any
value of it. Fast paths are adaptive escalations from a slow-safe
baseline ([D4](DECISIONS.md#d4--hybrid--adaptive-notification) is the
pattern), and anything time-based — heartbeats
([D17](DECISIONS.md#d17--client-heartbeats-opt-in-detached-marking-instead-of-kill)'s
opt-in and detached-not-killed stance is right), retention, detachment
— stays advisory or configurable, never load-bearing for correctness.

## P5 — never your own bouncer

**Context.** The narrative's closing contrast says it: trust here is
"enforced by parties the user already trusts." The picker gesture and
durable grants are Chrome's; the spawn confirmation is the daemon's,
deliberately host-side
([D12](DECISIONS.md#d12--spawn-policy-is-a-host-side-hook-confirmation-is-an-async-policy),
[D23](DECISIONS.md#d23--consent-is-host-served-and-grants-are-proof-of-possession-capabilities)).
The credibility of every rung comes from its enforcer predating the
software that is asking.

**Forces.** Self-enforcement is always easier to build — a
confirmation dialog rendered by the requesting page, a policy checked
by the library that wants the access. It works identically in the demo
and is worthless in the threat model: software vouching for itself is
the incumbent posture with better UX.

**Guidance.** For every rung, name the enforcing party, and it must
not be the party that benefits. If a new capability has no pre-trusted
enforcer available (Chrome, the daemon, the OS), the capability waits
until one exists — enforcement is never absorbed into the thing being
constrained.

## P6 — the bottom rung is a destination

**Context.** Read-only looks like a waystation on the capability
ladder — the rung passed through en route to edit and spawn. But
presence-without-trust keeps turning out to be a category of software,
not a demo of a permission: ambient pages that watch a workspace and
react, spectators attached to a session they can replay but not steer,
tools that should never be trusted further and don't need to be.

**Forces.** Product gravity pulls users up the ladder — value demos
better at the spawn rung, and it is tempting to design read-only as
merely the on-ramp. But a rung designed as an on-ramp is a rung nobody
is allowed to live on, and it forfeits the largest population of
potential clients.

**Guidance.** Read-only gets first-class design attention: its own
session kinds
([D13](DECISIONS.md#d13--session-kinds-are-a-host-side-registry-echo-is-just-an-entry)'s
registry has room), its own demos, ergonomics that assume the client
stays there forever. Never gate a read-only experience on climbing.

## Tripwires

Intuition is recognition. Each principle's force arrives as a
recognizable proposal shape — when one of these appears (in an issue,
a design sketch, your own plan), the matching principle is the
argument to have before writing code:

- "this feature needs the data server-side" / "just upload a copy" → P1
- "a websocket fast path" / "a cloud queue" / "a direct call, just for
  this one thing" → P2
- "bundle the prompts" / "pre-approve the whole session" → P3
- "we can assume the host answers in milliseconds here" → P4
- "the page can render its own confirmation" / "the library checks its
  own policy" → P5
- "read-only is just the on-ramp" → P6

None of these shapes is forbidden — principles are arguments, not
walls. The tripwire only guarantees the argument happens, on the
record.
