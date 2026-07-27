# @fsio/host

The fsio native host: serves sessions over a shared directory's `.fsio/`
subtree, per [spec/PROTOCOL.md](../../spec/PROTOCOL.md). Two ways in: a CLI
(`fsio-host.js`) and an embeddable `HostServer` class.

> **Status: nascent, unstable.** This package is not published (see
> [#7](https://github.com/dglazkov/fsio/issues/7)) and the library surface
> is mid-inversion — slice 1 of
> [#17](https://github.com/dglazkov/fsio/issues/17). Everything below is
> accurate but nothing is frozen; freezing is
> [#8](https://github.com/dglazkov/fsio/issues/8)'s job, and the open API
> questions live on
> [#17](https://github.com/dglazkov/fsio/issues/17). `onSpawnRequest`
> (spawn policy, [D12](../../spec/DECISIONS.md#d12--spawn-policy-is-a-host-side-hook-confirmation-is-an-async-policy))
> is in; expect `registerKind` (custom session kinds) to land before any
> freeze.

## CLI

```sh
node packages/host/dist/fsio-host.js <dir> [--allow-shell] [--hot <ms>] [--poll <ms>] [--no-watch] [--fresh]
```

- `--allow-shell` — permit `kind: "shell"` sessions (spawns processes!)
- `--hot <ms>` — hot-poll interval while sessions are active (default 5, 0 = off)
- `--poll <ms>` — add an unconditional poll loop
- `--no-watch` — disable `fs.watch` (pure polling; pair with `--poll` to measure)
- `--fresh` — wipe `.fsio` on startup

The CLI is a thin wrapper over `HostServer`; it adds argv parsing, a
timestamped console logger, and SIGINT → `close()`. Nothing else.

## Library

```ts
import { HostServer } from "@fsio/host";

const host = new HostServer({
  root: "/path/to/shared-dir", // the directory the browser picks
  allowShell: false,           // default; true spawns real processes
  logger: console.log,         // default: silent
});
await host.start(); // resolves once host.json (the heartbeat) is on disk
// ... sessions are now served; clients discover the host via host.json
host.close(); // kills session children, releases timers/watchers, retracts host.json
```

### `HostServerOptions`

| option | default | meaning |
|---|---|---|
| `root` | (required) | shared directory; `.fsio/` lives inside |
| `allowShell` | `false` | permit `shell` sessions (sugar for the static default policy; ignored when `onSpawnRequest` is set) |
| `onSpawnRequest` | static policy | `(spec, info) => allow/deny`, may be async — see below |
| `fresh` | `false` | wipe `.fsio` on start |
| `watch` | `true` | use `fs.watch` wakeups |
| `hotPollMs` | `5` | fast poll while sessions are live (F2); `0` = off |
| `pollMs` | `0` | unconditional poll loop |
| `logger` | silent | `(...args) => void` |
| `timings` | see below | every time-based behavior, injectable |
| `limits` | see below | flow-control knobs |

`timings` (all optional; defaults are the measured/spec'd values):
`heartbeatMs` 2000 · `safetyPollMs` 250 · `idleGcMs` 300 000 (idle echo
reap, [#3](https://github.com/dglazkov/fsio/issues/3)) · `idleSweepMs`
30 000 · `staleGraceMs` 60 000 (stale-exited GC on adoption, spec Session
lifecycle) · `closeDelayMs` 500 · `retryMs` 5 (torn-chunk retry, F11).

`limits`: `segMax` 8 MiB (out-segment rotation) · `ackWindow` 4 MiB (pause
output) · `ackResume` 2 MiB (resume).

Injectable timings are why the host's time-based behaviors are testable at
millisecond timescales — see
[`test-lifecycle.ts`](../bench/src/test-lifecycle.ts) and
[TESTING.md](../../TESTING.md).

### Semantics worth knowing

- **`start()`** loads `node-pty` if available (`ptyAvailable` reports the
  outcome), optionally wipes `.fsio`, writes the manifest, and resolves
  after the first heartbeat — so "start() resolved" ≡ "clients can
  discover me."
- **`close()`** is the full teardown: session child processes get killed,
  all timers and watchers are released (an embedder's process can exit
  cleanly), and `host.json` is unlinked so peers read the host as gone
  rather than flapping. Session *dirs* are not deleted on close — a
  restarted host re-adopts them (spec: Session lifecycle).
- **One `HostServer` per shared dir.** Nothing arbitrates multiple hosts on
  one `.fsio`; the second heartbeat writer wins. Don't.
- **Logging is the only error channel** for scan-loop errors (they are
  swallowed by design — the scan is idempotent and retried). A structured
  error hook is an open question on
  [#17](https://github.com/dglazkov/fsio/issues/17).

### Spawn policy (`onSpawnRequest`, D12)

```ts
const host = new HostServer({
  root: dir,
  onSpawnRequest: async (spec, info) => {
    // info: {sessionId, kind, client?, cmd?, args?, cwd?, pty?} — cmd is
    // RESOLVED (a bare shell spec means $SHELL; you judge what would run).
    if (info.kind !== "shell") return true;
    if (!(await askTheHuman(info))) return { allow: false, reason: "user declined" };
    return true;
  },
});
```

- Consulted for **every** spawn request, every kind; replaces the
  `allowShell` boolean entirely when present.
- **Async is the confirmation mechanism**: while the promise is pending the
  session gets no service — the spawn request sits unanswered and uplink
  chunks queue unconsumed. Clients own their spawn timeouts (the workbench
  uses 8 s — a human-confirmation flow should keep that in mind, #16).
- Denials reach the client as JSON-RPC error `1004` with your `reason`;
  a throwing/rejecting policy **denies** (fail-safe). Unknown kinds are
  rejected (`1003`) before the policy runs.
- With a hook present, `host.json` advertises `allowShell: true` — "asking
  is not pointless" — so clients attempt the spawn and receive the
  policy's actual verdict.
- Host restart re-adoption **re-judges** live sessions: a confirmation
  prompt will re-ask. For a security gate that's the correct default.
