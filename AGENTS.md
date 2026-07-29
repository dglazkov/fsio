# fsio — agent operating guide

A filesystem-based bridge between stdio and the Web Platform File System
API. The prototype is real, but the *methodology* is the asset: findings-
driven, spec-grounded, issue-tracked, cooperatively verified. Work in that
style.

## Map

- `spec/PROTOCOL.md` — normative (MUST/SHOULD). `spec/FINDINGS.md` — measured
  platform behaviors, F-numbered. `spec/DECISIONS.md` — ADR-lite, D-numbered.
- `TESTING.md` — test tiers and what deliberately isn't tested.
- `packages/{common,client,host,web,bench}` — npm workspaces; `common` is the
  single source of protocol truth (types + codec + JSON-RPC), both sides
  import it.

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
5. Commit messages explain *why*, cite F/D/issue numbers, and record
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
