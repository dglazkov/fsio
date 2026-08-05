# fsio process — which layer a thought goes in

## The katamari problem

**The symptom.** Ask for work on an issue and you get an agent trying to
reconcile a pile of constraints where only some are real. It reads the
records, finds five rules that bear on the task, treats all five as
binding, and produces a design contorted around two that were never
constraints at all. The owner's name for this is *the descent into
madness*, and the reason it is maddening rather than merely wrong is that
nothing looks broken from inside: every rule cited is on the record, in
the same voice, in the same file, under the same stable-numbering
discipline. A page's UX decision reads exactly as binding as the wire
format. The only way to tell them apart is to have been there.

**How it happened.** The records were built for a linear exploration —
measure, decide, write it down, never renumber. The work has not been
linear. Directions got parked (the hub, fsiod), directions moved out of
this repo (season two), and the demos made a few hundred small choices that
were never protocol questions. None of that had anywhere to go, because
the records were the only shelf in the building. So demo choices became
D-entries, demo needs became a nineteen-entry requirements namespace for
a mechanism nobody had built, measurements of our own shipped pages
became findings, and design that never settled stayed in issue comments
and got cited from shipped code anyway. The ball rolled up whatever it
touched.

**The measured shape**, so it is a size and not a feeling:

- **Confinement**: 427 lines of findings, 463 of requirements, 928 of
  labs, 70 of decision, 48 of threat model — **2,344 lines of record
  around 408 lines of code**, and not one line of it shipped as a
  library.
- **Nineteen requirement numbers**: for an unbuilt mechanism, cited ~106
  times from shipped code and tests, defined only in the body and
  comments of one issue.
- **D30 and D32**: one demo's decisions in the protocol decision log,
  with `packages/common` citing one of them.
- **F29**: a finding whose subject is a page we wrote.

**Why it is not fixed by labelling.** The first attempt at this document
was a scope label on every entry saying what it binds. That is the ball
rolling one more time: more record, about the record, in the record's own
voice. The fix is **somewhere else to put a thought** — which is what the
layers below are.

## Failure modes that recur

Written down because they are the moves a fresh reader makes, every one
of them observed in the session that produced this file.

- **Labelling instead of relocating.** Sixty-two hand-written scope lines
  asserting what each entry binds. Two were provably wrong within an
  hour, and a confident label on a judgment you do not have is worse than
  no label, because it is now on the record and cites nothing.
- **Inventing authority.** "The roadmap says the profile mechanism lands
  in fsiod" — where the roadmap was an issue bullet and a track label's
  description. There is no roadmap. Watch for *the plan*, *the roadmap*,
  *the direction* used as a source; in this repo those are issues, and
  issues are allowed to be wrong.
- **Volume mistaken for importance.** Confinement had more written about
  it than anything else, so it read like a prerequisite for shipping
  anything. It is not; ship first, confine later is the normal order.
  The record inverted it by making the confined version the one that was
  written down.
- **Housing a dangling reference instead of removing it.** 106 citations
  resolved to nothing, so a file was built to hold them. The citations
  were what should have gone.
- **Inferring scope from location.** An entry cited by `PROTOCOL.md` is
  not thereby protocol — it may be cited for a *fact* it contains. D29
  was mis-scoped exactly this way, twice.
- **Finding every piece a home instead of asking whether it should
  exist.** The last move before D29 was finally dropped was a careful
  three-way split of it: one rule re-grounded on a better reason, one
  moved to the library, one kept as protocol. Every step was defensible
  and the whole thing was the ball rolling — the split had *found* that
  the surviving rule's premise held only on macOS, which is the signal
  that the rule does not belong in a substrate-independent document, and
  read it instead as a repair job. **"This does not fit here" is more
  often a delete signal than a rewrite signal.** The tell is a plan whose
  every branch ends in "and it goes *there*", with no branch ending in
  "and it goes.

**The recognition trigger.** If you are weighing a constraint you cannot
trace to a file, or reconciling two rules that seem to disagree, you are
in it. Stop and ask which layer each one is on. If that is not answerable
from the page, it is a question for the owner (rule 4), not a puzzle to
solve.

**This is not solved.** `node scripts/record-hygiene.mjs` reports where
the ball still is.

## The layers

Ordered by how fast they are allowed to change. Fast layers absorb
change so slow layers do not have to.

**Demos — `packages/*-demo`.** The fast layer. Where we make things and
find out what strains. Code, code comments, and issues. **No numbered
entries, ever** — no D, no F, no R belongs to a demo. A demo is allowed
to be wrong, to be abandoned, and to be deleted without leaving a
tombstone behind. That freedom is the point: it is what makes a demo
cheap enough to be honest.

**Libraries — `packages/{common,client,host,…}`.** Also fast, but shared.
A library is **an extraction, not a design**: it exists because two
consumers already wrote the same thing, and the duplication is what
proved the shape. It carries no numbered entries either. What it owes
instead of a record is an API and tests.

Confinement is the worked example, in both directions. Nineteen
requirements were written for a confinement mechanism before any of it
existed; then both demos wrote it anyway, 408 lines, overlapping. The
duplication *was* the requirements document, and it arrived faster and
more accurately than the derivation did.

**Protocol — `spec/PROTOCOL.md` + `spec/DECISIONS.md`.** The slow layer.
Changes when the wire contract changes and not otherwise. A D is written
because the protocol moved, never because a demo or a library chose
something.

**Findings — `spec/FINDINGS.md`.** The slowest layer, and **protocol-only**:
measurements of the ground *the protocol stands on*. Chrome's FS Access,
the filesystem, Node's watchers. One shelf. Ground that something else
stands on — Seatbelt's write wall, an agent CLI's keystore — is that
thing's business, and it belongs with that thing.

**Instruments — `packages/workbench`, `packages/bench`,
`scripts/*-lab.mjs`, the harness.** Not on the ladder. This is the
environment in which experiments are run and findings are analyzed — the
bench, not the thing on it. An instrument carries no design content, so it
has no record obligations. What it owes instead is trustworthiness: a
measurement is only worth what the apparatus is worth, which is why the
labs' method notes live next to their numbers (F16's detach requirement is
the standing example).

## The rules

**1. Nothing in `spec/` names a demo package.** If a normative rule has to
point at `packages/acp-demo` to explain itself, it is describing one
implementation, not a contract. This is the whole boundary, and it is
mechanically checkable — `node scripts/record-hygiene.mjs`.

**2. Demos obey `PROTOCOL.md`, and nothing else binds them.** A demo may
read a finding as evidence for a choice it is making; reading the ground
is free. What it may not do is acquire its own numbered rules, or inherit
another demo's.

**2a. Demos do not run labs.** A measurement is either about the ground
the protocol stands on — in which case an instrument makes it and it
becomes a finding — or it is the demo's own business, in which case it is
a test, or a paragraph, or nothing. A demo that starts producing findings
has begun growing a record, which is the thing this document exists to
prevent. Measuring the shipped page and filing the result as F29 is the
shape to watch for.

**3. If code or spec cites it, it lives in a file.** A number, a name, or
a rule that anything outside an issue references must have a home in the
repository. Context, argument, and history stay in issues; authority does
not. Nineteen requirement numbers spent months cited from shipped code
while living only in
[#86](https://github.com/dglazkov/fsio/issues/86)'s body and comments,
which is how you get a reader who cannot tell a real constraint from a
remembered one.

**4. Strain is a stop, not a fork. Surface it and ask.** When work in a
demo runs into the protocol, that is the moment to say so out loud and
wait for an answer. Not to write a decision, not to file requirements,
not to invent a workaround and treat the choice as made.

There is no test for whether a strain is real that can be run from inside
the code. Whether the direction is parked, whether the demo is worth
bending the protocol for, whether the thing straining is even the right
demo — none of that is legible from the diff. It is the owner's call, and
the answer comes out of a conversation rather than a rule.

What to bring to that conversation: **what the demo wanted, what the
protocol would not do, and what it did instead** — including "nothing
yet," which is a legitimate answer and often the honest one. That is the
shape of a useful opening, not a form to fill in.

The conversation can end four ways, and three of them are not a D:
change the protocol, work around it in the demo, park it, or "that is not
strain, that is the demo doing it wrong." Only the first produces a
decision entry.

**Working without an answer.** The fast layer's freedom is what makes
stopping cheap — a demo is not blocked by an unanswered strain, it is
just not allowed to descend on its own. Keep building in the demo,
accumulate what the strain looks like in the issue, and leave the
protocol alone until there has been a conversation. An agent working
unattended does the same: the strain waits, the demo does not.

An earlier draft of this rule said a demo earns a protocol change by
shipping a workaround first. It is recorded here because it is the kind
of rule that sounds right and is not: too clean-cut to survive contact,
and sometimes you simply discover you need the thing. The example offered
in its defense did not even fit it — D5's dirname lane came out of F7's
measured 68 ms floor and a conversation, with no workaround shipped at
all.

**5. Abandonment is stated once, at the cluster.** When a direction is
parked or dead, one sentence in one place says so and everything
downstream inherits it. Not a tombstone per entry. A reader who opens
D22 should learn that the hub is parked from the hub's own heading, not
from noticing that nothing cites it.

**6. A library is extracted, never specified in advance.** Two consumers
writing the same thing is the signal; a document describing what the
thing should do is not. This is the rule that would have prevented the
largest single piece of the katamari, and it is worth stating why it
failed. Confinement acquired eight findings, a decision, nineteen
requirements, four labs and a chapter of the threat model — and that
*volume* got mistaken for importance, until confinement read like a
prerequisite for shipping anything. It is not. Ship first, confine later
is the normal order, and the record inverted it by making the confined
version the one that was written down.

## Issues

Issues are the fast layer's memory, and the katamari reached them too.

- **An issue is allowed to be wrong and to die.** Close it as not-planned.
  There is no obligation to reconcile it with any other issue.
- **The body is state; the comments are working.** Already the convention
  (AGENTS.md: titles state *remaining* work), extended: when a comment
  becomes the answer, it moves into the body — or, if anything outside
  the issue will cite it, into a file, per rule 3.
- **A design settled in comments is not settled.** It either gets raised
  as strain (rule 4), or it becomes code and code comments in a demo. It
  does not stay a comment. #86 has seven comments carrying four
  requirements, two amendments, and a measured refutation, none of which
  a reader of the issue title would ever find — which is also what a
  strain looks like when nobody stopped to ask about it.
- **Ordering does not live in label descriptions.** `track: demo`'s
  description currently encodes a sequence (`A: 34→18 (28 absorbed; pulls
  44, 45)`). Nothing can cite it, nothing checks it, and it is invisible
  to anyone reading the issues themselves.

## What a finding is

A measurement someone else could reproduce, which stays true if we delete
our code, **of the ground the protocol stands on**. Chrome's File System
Access API, the filesystem, Node's watchers, the browser's permission
model.

The second half is the constraint that keeps one shelf viable. Seatbelt's
write wall is real, reproducible and durable — and the protocol does not
stand on it, so it is not an F. It is a note belonging to whatever
confines. The test is not "is this true?" but "would a second
implementation of this protocol, on another substrate, need to know it?"

The other distinction that matters in practice is **number versus
verdict**.
F18's pollMs curve is a finding; "15 ms is the right default" is D16.
F3's latency table is a finding; "the hybrid notifier wins" is D4. When a
finding's headline is a verdict, the verdict has escaped its layer — the
measurement stays, the judgment moves to a D.

## Current state, against these rules

Written down rather than discovered. Nothing here is decided; it is the
list of what the rules would touch.

| what | where | rule |
|---|---|---|
| ~~the confinement mechanism, written twice~~ **extracted** | `packages/confine`; the demos keep their posture and their failure policy | 6 — done ([#134](https://github.com/dglazkov/fsio/issues/134)) |
| four confinement labs, 928 lines | `scripts/{confinement,read-wall,service-reach,agent-reach}-lab.mjs` | 2a — they were labs for demos |

Seven of the nine rows have since come off this list, and the three issues
that took them off are each worth a sentence, because in none of the three
was the work the shape this table predicted.

[#130](https://github.com/dglazkov/fsio/issues/130) — D30 and D32 were one
demo's decisions in the protocol decision log, and F29 measured a page we
wrote. All three were *second copies*: the demo's own code already stated
every rule of D30 and D32 in its own voice, beside the code that keeps
them. So what actually moved was the little nobody had written down twice,
and what is left at each number is a line saying it is spent.

[#131](https://github.com/dglazkov/fsio/issues/131) — the hub and season
two now say their own status, once, at the cluster (rule 5). The hub note
is narrower than this row assumed: the *direction* is parked, but D20,
D22–D26 shipped anyway and are cited from `common`, `host`, `client` and
the demos today, so a blanket "D19–D28 are parked" would have made a reader
discount five live decisions. Only D19 and D21 are purely the pivot.
Season two moved to its own repo rather than dying.

[#132](https://github.com/dglazkov/fsio/issues/132) — the confinement
cluster, in slices. The six findings moved to what they are ground for (the
wall's to `packages/confine`, the two agent CLIs' to the demo that has to
choose between them), and the ~104 requirement citations were **removed
rather than housed**, which is the row above stating its own remedy: each
one now says what the requirement says, and points at
[#86](https://github.com/dglazkov/fsio/issues/86) where they actually live.
Nothing was renamed into a file to make the citations resolve — that was
tried once and reverted, and it is the second failure mode listed above.

The confinement cluster finished the way the row above did not predict:
`spec/PROTOCOL.md`'s threat model lost 48 lines of Seatbelt mechanism and
D29 was dropped whole rather than split. The chapter is about what holding
the folder *is* and against whom; how a particular OS confines a child
process is the confining library's subject, and D29's own platform note —
measured on macOS, re-measure on any other backend — was the argument
against keeping it, once anybody read it that way.

The rest is tracked from
[#133](https://github.com/dglazkov/fsio/issues/133).

Nothing in `spec/` changed to produce this document, deliberately. A first
attempt did — a `**Scope.**` line on all 62 D and F entries saying what
each binds, and a file to house those nineteen numbers so their citations
would resolve.
Both were reverted. Labelling the ball is not moving it, and building a
home for a dangling reference is not removing the reference. Under these
rules the layer a thing sits in *is* its scope, so the label was
redundant; and the R-citations go with the extraction rather than ahead
of it.

Note how much of the list is one subject. Confinement is now every
remaining row: 427 lines of findings, 463 of requirements, 928 of labs, 70
of decision, 48 of threat model, and 408 lines of the actual mechanism —
**2,344 lines of record around 408 lines of code**, none of it shipped as
a library. That ratio is rule 6's argument, made by counting.

The code half of that ratio has since moved: `@fsio/confine` is 203 lines,
and what stayed in the demos is 285 — each demo's posture (which holes it
opens, and why, in the profile a human reads) and its failure policy (one
must never throw, one must always throw). The record half has not moved,
which is [#132](https://github.com/dglazkov/fsio/issues/132). Until it
does, the ratio is worse than it was, not better.

## Settled

- **Confinement is a library.** Not protocol, not a demo's, not a
  specification. The extraction is the work; the requirement numbers and
  the framing go with it, and what survives is whatever the two existing
  implementations already agree on.
- **One shelf for findings, protocol-only.** Ground the protocol does not
  stand on moves out with the thing that stands on it.
- **Demos do not run labs.** Rule 2a.
- **A demo is a product that has not been heavily invested in.** It can
  deploy, it can have users, it can be the thing this repo's own work gets
  built inside. None of that is evidence about its status: what ends demo
  status is a call about long-term investment, and that call is made well
  outside this repo. `terminal-demo` is shipped, deployed and load-bearing
  for NARRATIVE.md, and it is still a demo — still deletable, still free to
  be wrong, still owed no record. So there is no signal in here to read,
  and looking for one is the error: presume demo, and let the default flip
  only when the owner says so, once and out loud.

## Still open

- **Do `@fsio/client` and `@fsio/host` keep their D-entries?** D11, D14
  and D16 are library decisions under this model, and rule 6 says
  libraries carry no numbered entries. But those two libraries are also
  the protocol's reference implementation, which is a different
  relationship than a confinement library has. Unresolved, and the answer
  probably differs per entry.
- ~~**What happens to a number when its entry moves.**~~ Settled by
  [#130](https://github.com/dglazkov/fsio/issues/130) and
  [#132](https://github.com/dglazkov/fsio/issues/132), in practice rather
  than by argument: the number **retires where it was**, leaving one line
  that says what moved, where it went, and that the number is spent. The
  material itself goes unnumbered into whatever it is ground for. That
  keeps two things true at once — numbers are never reused, and a citation
  written before the move still resolves to something that explains
  itself.
