# fsio test strategy

The spec has MUSTs; the platforms have behaviors. **We test our MUSTs and
measure their behaviors** — asserting on platform behavior produces flakes,
and testing nothing produces faith-based refactoring. (#1)

`npm test` runs everything testable without a browser, identically local
and in CI (wireit graph; see README). One command, no surprises.

## Tiers

| tier | what | where | when |
|---|---|---|---|
| unit | pure logic: frame codec, RPC correlation, name encodings | `packages/common/src/*.test.ts` (node:test) | per push, seconds |
| protocol integration | spec MUSTs against a real host over a real FS in a tmpdir: torn writes, ordering, spawn errors, restart adoption | `packages/bench/src/test-protocol.ts` | per push |
| host lifecycle | time-based host behaviors at short injected timescales: idle GC, stale-session GC, `close()` resource release | `packages/bench/src/test-lifecycle.ts` (in-process `HostServer`) | per push |
| client conformance (B1) | the real `@fsio/client` over a Node fs shim against an in-process host: event delivery, D11 construction/disposal semantics, uplink lane selection, D6 cleanup ownership | `packages/bench/src/test-client.ts` + `fs-shim.ts` | per push |
| smoke | one full happy path per uplink lane + flow control, with a *generous* latency ceiling (100 ms p50 — catches the F1/F2 wakeup-regression class, never runner jitter) | `packages/bench/src/test-smoke.ts` | per push |
| labs | platform measurement, not pass/fail: benches, observer lab, write microbench. Results feed [spec/FINDINGS.md](spec/FINDINGS.md), never CI verdicts | `packages/bench`, workbench | when investigating |

Conventions:

- Integration tests cite what they enforce — a spec rule, a D-number, or an
  F-number — in a comment. A test without a citation is testing an
  implementation accident.
- Hermetic or it doesn't merge: every integration scenario gets its own
  tmpdir and host process. No shared state, no ordering dependencies.
- Time-based host behaviors (60 s stale-session GC, 5 min idle reap) are
  **not** tested at real timescales: #17's `HostServer` inversion made the
  intervals injectable, so `test-lifecycle.ts` runs them at milliseconds.
  The protocol-integration tier still spawns the real CLI as a child
  process; the lifecycle tier deliberately runs in-process — the library
  surface is part of what it tests.

## Not tested (deliberately)

- **Workbench UI** — owned by the cooperative manual loop: a human drives
  the page, the page self-reports into `.fsio/client/report.json`, the
  native side (human or agent) reads the verdicts.
- **Chrome platform behavior** — you cannot unit-test the ~300 ms observer
  cadence (F6) or the after-write scan (F7). That's what the findings
  notebook is for.

## Browser testing (the plan)

Browser coverage is tiered by what each tier can actually prove:

- **B1 — client logic in Node (per push). LANDED** with #17's FS-surface
  extraction (D11): `@fsio/client` types its FS dependency structurally
  (`FsDirectory` & co.), and `packages/bench/src/fs-shim.ts` (temp+rename
  emulating the swap-file commit) runs the real client against the real
  host in `test-client.ts`. What the shim deliberately does *not* emulate
  — snapshot staleness (F11), the after-write scan (F7) — stays with the
  workbench.
- **B2 — real Chromium via OPFS (deferred).** `navigator.storage
  .getDirectory()` needs no picker, so browser-mode unit tests are
  possible — but OPFS is a different backend (no F7 scan, different
  snapshot behavior), so it proves API shape, not platform truth.
  Revisit only if B1 leaves gaps.
- **B3 — real Chrome, real picked directory (scheduled).** Needs a spike
  on picker bypass (CDP-synthesized directory drop → `
  getAsFileSystemHandle()`, or a fake-picker flag). Payoff is
  **findings-drift detection**: a nightly re-measurement of F7/F10 is
  #4's durability probe. Tracked in #19.
- **B4 — cooperative loop, formalized (cheap, next).** One in-page button
  runs a client conformance battery and writes structured pass/fail into
  `report.json` for the native side to read. Covers what automation never
  will: the real picker, Safe Browsing toggles (#11), new Chrome builds.
