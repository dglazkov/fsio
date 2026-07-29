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
| client conformance (B1) | the real `@fsio/client` over a Node fs shim against an in-process host: event delivery, D11 construction/disposal semantics, uplink lane selection, D6 cleanup ownership, D12 spawn policy, D13 registered kinds, D14 introspection + injected pty | `packages/bench/src/test-client.ts` + `fs-shim.ts` | per push |
| smoke | one full happy path per uplink lane + flow control, with a *generous* latency ceiling (100 ms p50 — catches the F1/F2 wakeup-regression class, never runner jitter) | `packages/bench/src/test-smoke.ts` | per push |
| labs | platform measurement, not pass/fail: benches, observer lab, write microbench. Results feed [spec/FINDINGS.md](spec/FINDINGS.md), never CI verdicts | `packages/bench`, workbench | when investigating |
| browser harness (B3) | the real workbench in headed Chrome against a real host, one human click per run (F15) — bench in both uplink lanes at the smoke's 100 ms ceiling + a typed shell echo read back natively | `npm run harness` (`scripts/browser-harness.mjs`) | on demand: after a Chrome update, before a release, when a browser-touching change lands |
| sandbox posture | the terminal-demo Seatbelt profile, layer by layer (ROOT allow, `.fsio` deny via SBPL last-match-wins, outside-ROOT deny, fail-closed pty wrapper) — macOS-only, skips elsewhere (same posture as the F-findings being macOS-measured) | `packages/terminal-demo/src/test-sandbox.ts` | per push |

Conventions:

- Integration tests cite what they enforce — a spec rule, a D-number, or an
  F-number — in a comment. A test without a citation is testing an
  implementation accident.
- Hermetic or it doesn't merge: every integration scenario gets its own
  tmpdir and host process. No shared state, no ordering dependencies.
- **Poll, don't snapshot.** A cross-process assertion that samples state
  once after an awaited precursor is a flake: adjacent effects on the
  other side interleave arbitrarily from outside. Two shipped examples:
  chunk deletion trails the response it acks (8f66d9e), and a session is
  listed from dir-adoption on, before its spawn.json is parsed
  (post-#27). If the target state is sticky, `waitFor` it.
- Time-based host behaviors (60 s stale-session GC, 5 min idle reap) are
  **not** tested at real timescales: #17's `HostServer` inversion made the
  intervals injectable, so `test-lifecycle.ts` runs them at milliseconds.
  The protocol-integration tier still spawns the real CLI as a child
  process; the lifecycle tier deliberately runs in-process — the library
  surface is part of what it tests.

## Not tested (deliberately)

- **Workbench UI** — owned by the cooperative manual loop: a human drives
  the page, the page self-reports into `.fsio/client/<clientId>/report.json`
  (one dir per page load — #39; read the newest), the native side (human or
  agent) reads the verdicts.
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
- **B3 — real Chrome, real host-visible directory (LANDED as the
  one-click harness,
  [#21](https://github.com/dglazkov/fsio/issues/21)).** `npm run harness`:
  Playwright launches headed Chrome for Testing, a CDP-synthesized
  directory drop mints a real handle (F14), one human click grants write
  for the whole browser session (F15), then the agent drives the workbench
  unattended — bench in both uplink lanes asserted at the smoke's generous
  100 ms ceiling, plus a shell echo typed into xterm and read back
  natively from the shared dir (no self-grading by the page). On-demand
  only: the click-per-run cost is Chrome's design, which is also why the
  *scheduled* uplink drift job stays blocked
  ([#22](https://github.com/dglazkov/fsio/issues/22)).
- **B4 — cooperative loop, formalized
  ([#35](https://github.com/dglazkov/fsio/issues/35)).** One in-page
  button runs a client conformance battery and writes structured pass/fail
  into `report.json` for the native side to read. Covers what automation
  never will: the real picker, Safe Browsing toggles (#11), new Chrome
  builds — and the harness clicks the same button once it exists.
