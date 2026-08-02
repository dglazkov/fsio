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
| host lifecycle | time-based host behaviors at short injected timescales: idle GC, stale-session GC, the hot poll's traffic gate (D4/F22), `close()` resource release | `packages/bench/src/test-lifecycle.ts` (in-process `HostServer`) | per push |
| client conformance (B1) | the real `@fsio/client` over a Node fs shim against an in-process host: event delivery, D11 construction/disposal semantics, uplink lane selection, D6 cleanup ownership, D12 spawn policy, D13 registered kinds, D14 introspection + injected pty, D22 workspace resolution (1006, contained `cwd`), D24/D25 service directory (the `servicesRev` doorbell, write-only-on-change, names-never-paths, feature detection by capability name) | `packages/bench/src/test-client.ts` + `fs-shim.ts` | per push |
| smoke | one full happy path per uplink lane + flow control, with a *generous* latency ceiling (100 ms p50 — catches the F1/F2 wakeup-regression class, never runner jitter) | `packages/bench/src/test-smoke.ts` | per push |
| labs | platform measurement, not pass/fail: benches, observer lab, write microbench, background lab (`npm run bg-lab`, F16/F17), cost lab (`npm run cost-lab`, F18), confinement lab (`npm run confinement-lab` — the only lab that is also an escape matrix, so it exits non-zero if a canary appears outside the wall), service-reach lab (`npm run service-reach-lab` — shell posture vs deny-default service posture, driving a real stdio MCP server), agent-reach lab (`npm run agent-reach-lab` — a real agent CLI under confinement; needs the CLI installed, so it is the one lab that is not self-contained). Confinement results feed [packages/confine/MEASUREMENTS.md](packages/confine/MEASUREMENTS.md) and the acp demo's own; platform results feed [spec/FINDINGS.md](spec/FINDINGS.md). Never CI verdicts | `packages/bench`, workbench, `scripts/*-lab.mjs` | when investigating |
| browser harness (B3) | the real workbench in headed Chrome against a real host, one human click per run (F15) — bench in both uplink lanes at the smoke's 100 ms ceiling + a typed shell echo read back natively | `npm run harness` (`scripts/browser-harness.mjs`) | on demand: after a Chrome update, before a release, when a browser-touching change lands |
| conformance battery (B4) | the B1 battery re-run on the real platform via one in-page button; structured `{name, ok, detail}` verdicts land in a `conformance` event in `report.json` for the native side | workbench "Conformance battery" button ([#35](https://github.com/dglazkov/fsio/issues/35)) | cooperative loop on demand; every harness run clicks it |
| hub daemon | fsiod's own rules, none of which are protocol: the singleton lock (D21) including the reclaim-a-corpse and never-steal-a-live-socket cases, daemon-private state placement and modes (D20), and the workspace registry's refusals (D22) — names not paths, no substituted subject, `$HOME` and hub-containing folders refused — plus what the daemon advertises (D24): only names the user marked advertisable, a share reaching pages without a restart, a revision that never rewinds | `packages/fsiod/src/test-{lock,registry,services}.ts` | per push |
| sandbox posture | the terminal-demo Seatbelt profile, layer by layer (ROOT allow, `.fsio` deny via SBPL last-match-wins, outside-ROOT deny, fail-closed pty wrapper) plus the three properties the wall rests on (inherited by descendants and detached children, `sandbox_apply` refused in both directions, setuid binaries unexecutable) — macOS-only, skips elsewhere (same posture as the measurements themselves) | `packages/terminal-demo/src/test-sandbox.ts` | per push |
| acp kind (#18) | the framing contract in both directions — one DATA frame is one whole ACP message however the agent chunks its writes, junk on stdout diverted not delivered, a two-message frame refused — plus the session facts a page reads (`sandboxed`, state posture, synthesized env with the ssh-agent socket absent), the allow-list refusal, and the agent's exit taking the kind's methods with it (#98). Driven against a fixture agent: no installed agent, no model key, no network. The agent profile's own layers (state carve named not inferred, `/private/tmp` denied, reads still open — it is a write wall) sit beside it, macOS-only | `packages/acp-demo/src/test-{framing,acp-kind,sandbox}.ts` | per push |
| agent roster (D31) | what the helper tells the page this machine has ([#102](https://github.com/dglazkov/fsio/issues/102)): presence reported per allow-list entry against a real PATH-shaped fixture (a directory and a non-executable file are not agents), an uninstalled entry still *listed* — it is the install line the page prints — and every shipped entry declaring `asks`, the one roster field that is a measured claim (F30, #100) rather than a label. Guards the D24 privacy line at the point where the demo composes the object that rides `services.json`: no `bin`, no `$HOME`, no path-shaped value outside an install command. The library half (transcribed verbatim, dropped for an unserved kind or a non-object, `rev` moving only on real news) is in the B1 battery | `packages/acp-demo/src/test-agents.ts`, `packages/bench/src/test-client.ts` | per push |
| session discovery (#113/#117) | what the *folder* can say about a running conversation the browser has no record of, which is the whole of whether the picker is a recovery path or a list of hashes: the ACP session id recovered from a `session/update` (the case that survives a rotated handshake) and from `session/new`'s reply (the case where nothing has been said yet), the line to choose by (a message split across a rotation is one message; a tool call ends the run, as it does in the chat itself), the birthday decoded out of the session id, and the filter — running `acp` only, never one this page already holds. Read like a stranger wrote it (D20): junk payloads, non-DATA frames and a half-written trailing frame are stepped over, not fatal. The record's durable `adopted` flag rides in `test-resume.ts` beside the rest of the record | `packages/acp-demo/src/test-discovery.ts` | per push |
| the open set ([#120](https://github.com/dglazkov/fsio/issues/120)) | which conversations a page holds and which is on screen, written down twice for two jobs: the URL that carries them to whoever is handed the link (P1) and the store a bare visit comes back to. The URL wins when it names anything — sharing one of three tabs means one tab — and everything that constructs a set goes through one normalizer, because the three sources have three ways of being wrong. Read like a stranger wrote it, since the hash is the one input to this page a stranger writes: a mangled fragment is no instruction rather than an error, an `active` pointer outside its own set is pulled back inside it, and a path-shaped id never reaches `attachSession()` | `packages/acp-demo/src/test-tabs.ts` | per push |
| acp client role (#100) | the half of the page's ACP client role that no installed agent exercises ([#100](https://github.com/dglazkov/fsio/issues/100)): a **puppet agent** that asks permission and has no hands — every file it touches travels as an `fs/*` request — driven by a scripted client playing the page. Asserts the ask precedes the write, that the write is byte-for-byte the diff the human approved, that a rejection or cancellation writes nothing, that the client's refusal *text* survives into the transcript an agent would relay, and that a wrongly-allowed out-of-bounds read is reported as a hole rather than passed over. Needs no tmpdir: the puppet is pointed at a folder that does not exist, and the last case asserts it is still not there | `packages/acp-demo/src/test-fixture-agent.ts` | per push |

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

  **The verdicts survive the run.** `client/` is the one directory under
  `.fsio` the host does not own, so the demo helpers keep it at Ctrl-C
  along with `transcripts/` ([#109](https://github.com/dglazkov/fsio/issues/109),
  [D6](spec/DECISIONS.md#d6--one-writer-per-file-one-cleanup-owner)). Read
  the newest dir *after* stopping the helper and the reports are still
  there; that used to be advice that only worked if you never stopped it,
  which is how #102's first run lost its verdicts. What does still wipe
  them is starting a host with `fresh: true` — the next run's first
  gesture, deliberately, so "the newest dir" always names this run.
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
- **B4 — cooperative loop, formalized (LANDED as the workbench's
  conformance battery, [#35](https://github.com/dglazkov/fsio/issues/35)).**
  One in-page button ("Conformance battery") re-runs the B1 battery where
  the platform allows — discovery, D10 spawn/ping/coded refusal, D11
  first-status + listener disposal, F10 lane selection, D6 host-owned
  cleanup — and writes each check as `{name, ok, detail}` in a
  `conformance` event in `report.json` for the native side to read. The
  DATA-delivery leg needs a pty-less `/bin/cat` (the echo kind has no data
  sink) and self-skips without `--allow-shell`. Covers what automation
  never will: the real picker, Safe Browsing toggles (#11), new Chrome
  builds — and the harness clicks the same button (B3 step 4).
