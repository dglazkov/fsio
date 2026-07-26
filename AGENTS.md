# fsio — agent operating guide

A filesystem-based bridge between stdio and the Web Platform File System
API. The prototype is real, but the *methodology* is the asset: findings-
driven, spec-grounded, issue-tracked, cooperatively verified. Work in that
style.

## Map

- `spec/PROTOCOL.md` — normative (MUST/SHOULD). `spec/FINDINGS.md` — measured
  platform behaviors, F-numbered. `spec/DECISIONS.md` — ADR-lite, D-numbered.
- `TESTING.md` — test tiers and what deliberately isn't tested.
- `packages/{common,host,web,bench}` — npm workspaces; `common` is the
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
   scope creep.
2. Session-end triage: every new issue gets a `p1`/`p2`/`p3` label; when
   closing an issue, re-check whether it unblocks a `p3` (promote it). A
   priority is a claim about the dependency graph *and the current goal*
   (a working demo; agent-verifiable browser loops) — cite what it waits
   on, and beware "just became possible" masquerading as "now urgent"
   (that bias once put npm packaging at p1 the day the host became
   embeddable).
3. Direct-to-main is fine for docs/spec/tests; protocol-touching changes
   prefer a short-lived branch + PR so CI gates the merge.
4. Commit messages explain *why*, cite F/D/issue numbers, and record
   measured results when behavior was verified (numbers, not adjectives).
   Write multi-line commit/PR/comment bodies to a temp file and pass
   `-F`/`--body-file` — heredocs inside `"$(cat <<'EOF' …)"` get mangled
   by the tool shell (bad substitution; cost a retry more than once).

## Cooperative verification (browser work)

No browser automation exists yet (#19). The loop: agent implements → human
drives the workbench → the page self-reports into
`<shared-dir>/.fsio/client/{log.txt,report.json}` → agent reads verdicts
from the native side. Ask the human to click; read the report; never claim
browser code works without one of the two.

## Conventions (each learned the hard way)

- **Stable numbers, never renumber**: findings (F), decisions (D), spec open
  questions — issues and commits cite them. Resolved spec questions collapse
  to a tombstone pointing at the settling D-number.
- **Citations everywhere**: every spec MUST that exists because of a finding
  links to it; every integration test cites the spec rule/F/D it enforces
  (a test without a citation tests an implementation accident).
- **Markdown links**: bare `#N` does not autolink in repo files — use full
  GitHub URLs. Check heading-slug anchors after renames (a link checker
  one-liner lives in the git history of spec commits).
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
