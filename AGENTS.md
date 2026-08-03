# fsio — agent operating guide

A filesystem-based bridge between stdio and the Web Platform File System
API. The prototype is real, but the *methodology* is the asset: findings-
driven, spec-grounded, issue-tracked, cooperatively verified. Work in that
style.

## Map

- **`PROCESS.md` — read this before the records, every time.** The records
  below absorbed a great deal that was never protocol: demo choices sit in
  the decision log, findings measure pages we wrote, and numbers cited from
  shipped code resolve to nothing. They all read alike, so **if you find
  yourself reconciling constraints where some seem not to fit, you are not
  missing context — some of them are not real.** PROCESS.md says which layer
  a thought goes in (demos fast and unrecorded, protocol slow, findings
  slowest, workbench and labs are instruments), names the failure modes that
  recur, and gives the one rule that matters when a demo runs into the
  protocol: **stop and ask.** Don't write a decision to resolve the tension —
  that is how it got here. `node scripts/record-hygiene.mjs` shows the
  current state.
- `spec/PROTOCOL.md` — normative (MUST/SHOULD). `spec/FINDINGS.md` — measured
  platform behaviors, F-numbered. `spec/DECISIONS.md` — ADR-lite, D-numbered.
  `spec/PRINCIPLES.md` — platform principles, P-numbered (handles below).
- `TESTING.md` — test tiers and what deliberately isn't tested.
- `NARRATIVE.md` — the demo through-line: which act each demo plays.
- `packages/{common,client,host,fsiod,confine,workbench,terminal-demo,acp-demo,bench}`
  — npm workspaces; `common` is the single source of protocol truth (types +
  codec + JSON-RPC), both sides import it. `confine` is the Seatbelt write
  wall, extracted from the two demos that wrote it (PROCESS.md rule 6). The
  `*-demo` packages are page + native helper pairs consuming `@fsio/host` as
  a library.

## Principles (P1–P6)

The six handles from `spec/PRINCIPLES.md`, meant to be said out loud in
design arguments — each entry there carries the context/forces/guidance
behind its handle:

- **P1 — the URL travels; the data stays.** Ship interface, never
  custody.
- **P2 — if it didn't ride the folder, it didn't happen.** No side
  channels; optimize within the medium, never around it.
- **P3 — trust is a noun.** Every capability is a distinct rung with a
  distinct gesture; fight prompt fatigue with scope and durability,
  never breadth.
- **P4 — fast is a mode, not a premise.** Latency is a parameter;
  correctness holds at any value of it.
- **P5 — never your own bouncer.** A rung's enforcer must predate, and
  not benefit from, the software asking.
- **P6 — the bottom rung is a destination.** Read-only is a place to
  live, not an on-ramp.

A design that strains one of these must name it and argue — in the
D-entry or the PR, not silently. Cite P-numbers the way F/D numbers are
cited. Before merging protocol-touching changes, ask which principles
the diff touches (often none — say so and move on).

## Ground truth commands

- `npm run build` and `npm test` are the ONLY truth. Never conclude from a
  bare `tsc`/direct tool run — wireit's graph is what CI runs, byte for
  byte. Direct invocations are allowed only as throwaway probes.
- `scripts/dev.sh` — fresh host on `~/fsio-demo` + vite at
  http://localhost:8765/. Never demo from `/tmp` (F9).
- Toolchain is pinned: node via `.nvmrc`, npm via CI + `engines`. The
  package manager is part of the reproducibility surface (a CI npm-version
  drift once rejected a lockfile local npm accepted).

## Operating loop

**You write the issues — the human never does.** The tracker is agent-authored
memory: a past session's grounding for a future one, alongside the code and
the records. Write for that reader — enough context to pick one up cold. Two
things follow from who the author is:

- **An issue is never the human's opinion.** Not the priority, not the
  framing, not the "we should." It is a previous you, reasoning with less
  than you have now. When a call needs their judgment, ask them; never quote
  an issue back at them as though they had said it.
- **Issues go stale.** They were true when written and nothing updates them
  when the code moves underneath. Check an issue's claims against the code
  and the records before acting on them, and when one has gone stale, retitle
  or close it rather than building around it.

**The direction is the human's to choose; your job is to make that choice a
good one.** Writing the issue is yours — deciding what the system should
*become* is not. Finding a problem does not make its remedy yours to pick,
and an issue that arrives with a fix already argued for has quietly made an
architectural decision on the owner's behalf, in a file that outlives the
conversation. Bring the measurement, the options nobody has ruled out yet,
and what each one costs; say which you would choose only when asked, and
mark it as an opinion when you do. A p1 with a recommended remedy in it is
the shape to watch for: it reads as reporting and acts as deciding. This is
PROCESS.md rule 4 wearing different clothes — strain stops and asks — and it
applies to any fork wide enough that a reasonable person could take the
other branch.

1. Issue-driven: `gh issue list` → pick by priority label (`p1` first;
   `p3` = blocked or deferred, don't start it) → implement → commit with
   `Closes #N` → push → **watch the CI run to conclusion** → verify the
   issue closed. Backlog items discovered mid-work become new issues, not
   scope creep. Watch CI with `node scripts/ci-status.mjs <pr#|main>`
   (one line, exit 0 pass / 1 fail / 2 pending) in an until-loop —
   `gh run watch` and bare sleep-polling are permission-blocked in some
   agent harnesses, and hand-rolled `gh pr checks` parsing has traps
   (the `skipping` bucket; the text output's columns) that script
   already encodes.
2. Issues also carry `track: *` labels — named sequences with an internal
   order (demo, verification, robustness, security; the order and its
   why live in issue comments, membership in the label). Pick up work
   track-first: finish or advance a sequence before hopping. Untracked
   p3s are parked/cross-cutting — they join a track when something pulls
   them, not by default.
3. Session-end triage: every new issue gets a `p1`/`p2`/`p3` label; when
   closing an issue, re-check whether it unblocks a `p3` (promote it).
   Titles state *remaining* work, not history — when scope shifts,
   retitle (#9 sat as "Investigate… (report upstream?)" long after the
   investigation ended; the actual next step was three comments deep). A
   priority is a claim about the dependency graph *and the current goal*
   (a working demo; agent-verifiable browser loops) — cite what it waits
   on, and beware two biases with label-shaped disguises: "just became
   possible" masquerading as "now urgent" (once put npm packaging at p1
   the day the host became embeddable), and "minutes of effort"
   masquerading as priority (once put a crbug-filing errand at p1 —
   effort is orthogonal; genuinely-free tasks are done opportunistically,
   not ranked first).
4. Direct-to-main is fine for docs/spec/tests; protocol-touching changes
   prefer a short-lived branch + PR so CI gates the merge.
5. Commit messages explain *why*, cite F/D/P/issue numbers, and record
   measured results when behavior was verified (numbers, not adjectives).
   Write multi-line commit/PR/comment bodies to a temp file and pass
   `-F`/`--body-file` — heredocs inside `"$(cat <<'EOF' …)"` get mangled
   by the tool shell (bad substitution; cost a retry more than once).

## Cooperative verification (browser work)

Two loops, both ending in the agent reading verdicts from the native side
of `<shared-dir>/.fsio/client/<clientId>/{log.txt,report.json}` — one dir
per page load (#39); pick the newest (`ls -t`):

- **One-click harness** (`npm run harness`, TESTING.md B3): agent drives
  the real workbench in headed Chrome; the human's entire job is one
  "Allow on every visit" click per run (F15 — unautomatable by Chrome's
  design). Prefer this for workbench-side changes.
- **Manual loop**: agent implements → human drives the page → page
  self-reports. Still the only loop for anything the harness can't reach
  (the real picker, the terminal-demo page, new-Chrome sanity).

Ask the human to click; read the report; never claim browser code works
without one of the two.

Rig-run protocol (learned from a burned grant window): the terminal's
CLICK banner is invisible when a rig script runs as a background task —
**the chat message launching the run must itself ask the human to click,
in that same message**, and on macOS the rig also raises an OS
notification at banner time. The grant window is
`FSIO_GRANT_TIMEOUT_MS` (default 180 s); a timed-out run tears itself
down cleanly and can just be relaunched.

Measurement labs on the same rig (`scripts/harness-rig.mjs`):
`npm run bg-lab` (background throttling, F16/F17) and `npm run cost-lab`
(idle/pollMs cost matrix, F18). Anything measuring *background or
visibility* behavior must use `startRig({detachable: true})` and detach
during measured phases — an attached Playwright/CDP session
force-emulates focus (covered tabs stay `visible`, timers unthrottled)
and Playwright's default launch flags disable the throttling itself
(F16's method note; three lab runs were invalidated learning this).

## Conventions (each learned the hard way)

- **Stable numbers, never renumber**: findings (F), decisions (D), spec open
  questions — issues and commits cite them. Resolved spec questions collapse
  to a tombstone pointing at the settling D-number.
- **Citations everywhere**: every spec MUST that exists because of a finding
  links to it; every integration test cites the spec rule/F/D it enforces
  (a test without a citation tests an implementation accident).
- **Markdown links**: bare `#N` does not autolink in repo files — use full
  GitHub URLs. Heading-slug anchors are checked by
  `node scripts/check-anchors.mjs` (part of `npm test`, so a rename that
  breaks links fails CI — still run it directly after editing spec docs
  for the fast signal).
- **After editing any package.json by hand, run `npm install`** and commit
  the lockfile — `npm ci` on CI rejects drift.
- **When a change adds/moves build output, update `.gitignore` in the same
  commit** (`git add -A` once swept `dist/` into the repo).
- **Never edit a shell script while an instance is running** (bash reads
  incrementally; the running copy executes garbage).
- One writer per file, host owns cleanup (D6) — applies to code you write
  against the protocol, including test fixtures.

## Gotchas that look like bugs but aren't

- Empty/partial chunk files, `NotReadableError` on reads: torn state is
  normal; wait and re-read (invariant 3, F11).
- Duplicate JSON-RPC responses (e.g. spawn after host restart): legal,
  ignore unknown ids (spec Control plane).
- Wireit "skipped" ≠ broken: it means inputs unchanged. `rm -rf .wireit
  packages/*/.wireit packages/*/dist` simulates a cold CI run.
- Throwaway node probes written to a scratchpad outside the repo can't
  `import` repo dependencies (ESM resolves from the *script's* path, not
  cwd) — put probes under the repo, or import via the dependency's
  absolute path in `node_modules`.
