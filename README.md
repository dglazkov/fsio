# @fsio/host

Run an fsio host in a Node process. The host serves sessions — shells, or
session kinds you define — to a browser page that has been granted access to
the same directory. There is no port, no socket, and no server: the two halves
communicate by reading and writing files under a `.fsio/` subtree of a
directory they both hold.

The browser half is [`@fsio/client`](https://github.com/dglazkov/fsio/tree/main/packages/client).
The file formats both halves use are specified in
[spec/PROTOCOL.md](https://github.com/dglazkov/fsio/blob/main/spec/PROTOCOL.md).

> **Stability: unstable.** The API changes without notice and without a
> deprecation period. Pin the exact commit your project resolved — the
> instructions below produce a lockfile entry that does this for you.

## Requirements

Node 24 or later.

## Install

```sh
npm install github:dglazkov/fsio#host
```

This package is distributed from a branch of the fsio repository rather than
from npm. The command adds `@fsio/host` to your dependencies and installs
`@fsio/common`, the protocol types both halves share, alongside it.

Install `@fsio/client` from the same repository if your project contains the
browser half:

```sh
npm install github:dglazkov/fsio#client
```

Both packages depend on the same `@fsio/common` branch, so npm installs one
copy and both halves see the same types and the same `RpcError` class.

## Start a host

Point a `HostServer` at a directory and start it:

```ts
import { HostServer } from "@fsio/host";

const host = new HostServer({
  root: "/Users/you/projects/notebook", // the directory the page will pick
  allowShell: true,                     // permit shell sessions; default false
  logger: console,                      // default: silent
});

await host.start();
// Clients can now discover this host and open sessions.

// On shutdown:
await host.close();
```

`start()` resolves once `host.json` — the heartbeat file that tells clients a
host is alive — is on disk. After it resolves, a page that has been granted
the same directory can connect.

`logger` takes an object with `info`, `warn`, and `error` methods. The global
`console` satisfies that, which is why the example passes `console` rather than
`console.log`.

## Connect the two halves

The host and the page never address each other directly. They meet because
they hold the same directory:

1. Your Node process starts a `HostServer` on a directory, for example
   `/Users/you/projects/notebook`.
2. Your page calls `showDirectoryPicker()` and the person using it selects
   that same directory.
3. The page constructs an `FsioClient` on the resulting handle and calls
   `connect()`, which reads the heartbeat the host is writing.

Nothing else connects them. The person choosing the directory in step 2 is the
entire access-control decision, which is why the host writes only inside
`.fsio/` and cleans up after itself.

## Options

Pass these to the `HostServer` constructor.

| Option | Default | Description |
|---|---|---|
| `root` | required | The shared directory. `.fsio/` is created inside it. |
| `allowShell` | `false` | Permits `shell` sessions, which spawn real processes. Ignored when you provide `onSpawnRequest`. |
| `onSpawnRequest` | static policy | Decides each spawn request. See [Control what runs](#control-what-runs). |
| `workspaces` | none | Resolves a spawn spec's `workspace` name to a directory. See [Serve more than one directory](#serve-more-than-one-directory). |
| `workspaceName` | none | The name this host answers to for its own `root`. Ignored when you provide `workspaces`. |
| `services` | none | What the host advertises to pages: capability names, workspace names, the consent endpoint. See [Advertise what you serve](#advertise-what-you-serve). |
| `transcripts` | `false` | Keeps ended sessions' output under `.fsio/transcripts/`. See [Keep transcripts](#keep-transcripts). |
| `fresh` | `false` | Deletes `.fsio/` at startup. Refused while another host is live on the directory. |
| `takeover` | `false` | Starts even when `host.json` still looks live. Use it for a killed host whose last heartbeat has not yet gone stale. |
| `watch` | `true` | Uses `fs.watch` for wakeups. Set it to `false` to poll only. |
| `gitignore` | `true` | Adds `.fsio/` to `.gitignore` when the shared directory is inside a git repository. Session output is full scrollback and must not reach version control. |
| `hotPollMs` | `5` | Scan interval while traffic is flowing. `0` turns the fast loop off. |
| `pollMs` | `0` | Unconditional scan interval. `0` turns it off. |
| `logger` | silent | An object with `info`, `warn`, and `error` methods. |
| `pty` | auto | A pty module to use, or `false` to force the pipe fallback. See [Terminal support](#terminal-support). |
| `timings` | see below | Every time-based behavior. |
| `limits` | see below | Flow-control thresholds. |

### timings

Every field is optional and takes the listed default, in milliseconds.

| Field | Default | Description |
|---|---|---|
| `heartbeatMs` | `2000` | How often `host.json` is rewritten. Clients read a host as live when the file is newer than three beats. |
| `safetyPollMs` | `250` | Slow scan that backs up `fs.watch`. |
| `hotWindowMs` | `2000` | How long traffic keeps the fast scan loop armed. |
| `idleGcMs` | `300000` | How long an idle `echo` session survives before it is reaped. |
| `idleSweepMs` | `30000` | How often the idle sweep runs. |
| `detachAfterMs` | `180000` | How long a client can go silent before its session is marked detached. Background browser tabs clamp timers to one per minute, so keep a wide margin here. |
| `staleGraceMs` | `60000` | How old an exited session must be to be collected when a host adopts it. |
| `closeDelayMs` | `500` | Delay before a closed session's directory is deleted, so the client can stop its watchers first. |
| `retryMs` | `5` | Retry delay when an incoming chunk reads as torn or empty. |
| `killGraceMs` | `3000` | How long a child gets after `SIGTERM` before `SIGKILL`. |

Injectable timings are what make the host's time-based behavior testable at
millisecond timescales instead of real ones.

### limits

| Field | Default | Description |
|---|---|---|
| `segMax` | 8 MiB | Size at which the output log rotates to a new segment. |
| `ackWindow` | 4 MiB | Unacknowledged bytes at which output pauses. |
| `ackResume` | 2 MiB | Unacknowledged bytes at which output resumes. |

## Lifecycle

**`start()`** looks for a pty module, optionally clears `.fsio/`, writes the
manifest, and resolves after the first heartbeat. Read `ptyAvailable` after it
resolves to learn whether shell sessions get a real terminal.

**`listSessions()`** returns read-only snapshots of the sessions this host is
serving. Each carries `{id, kind, client, phase, pid, pty, bytesOut,
bytesAcked, lastActivityAt}`. `phase` moves through `adopted` → `pending` →
`running` → `exited` or `done`. A session sits in `pending` while your spawn
policy is deciding, which is the state a confirmation prompt renders. Mutating
a snapshot changes nothing.

**`close()`** kills session children, releases every timer and watcher, and
unlinks `host.json` so peers read the host as gone rather than flapping. All of
that happens synchronously, so an unawaited call still tears down completely.
The returned promise additionally resolves once the children have actually
exited, so `await host.close()` before `process.exit()` leaks nothing. Session
directories survive close — a restarted host adopts them again.

Run one `HostServer` per directory. Nothing arbitrates two hosts on one
`.fsio/`; the second heartbeat writer wins.

Scan-loop errors reach `logger.error` and nowhere else. They are swallowed by
design, because the scan is idempotent and retried. Read `listSessions()` and
the protocol files for state you want to act on; the log is for humans.

## Control what runs

A shell session spawns a real process. `allowShell: true` permits every one of
them, which is a reasonable default only when your embedder has already decided
the question. To decide per request, pass `onSpawnRequest`:

```ts
const host = new HostServer({
  root: dir,
  onSpawnRequest: async (spec, info) => {
    if (info.kind !== "shell") return true;
    if (await askTheHuman(info)) return true;
    return { allow: false, reason: "user declined" };
  },
});
```

`info` carries `{sessionId, kind, client, cmd, args, cwd, pty}`. `cmd` is
already resolved, so a bare shell request arrives as the actual `$SHELL` value
and you judge what would really run.

- The policy is consulted for every spawn request of every kind, and it
  replaces `allowShell` entirely.
- Returning a promise is the confirmation mechanism. While it is pending the
  session gets no service, so take as long as you need — but note that clients
  own their own spawn timeouts, and a page that gives up stops waiting for your
  answer.
- A denial reaches the client as JSON-RPC error `1004` carrying your `reason`.
  A policy that throws or rejects denies the request, so a bug fails safe.
- Unknown kinds are rejected with `1003` before the policy runs.
- With a policy present, `host.json` advertises `allowShell: true` — the claim
  is "asking is not pointless", so clients attempt the spawn and receive your
  real verdict.
- Restarting a host re-judges the sessions it adopts, so a confirmation prompt
  asks again. For a security gate that is the correct default.

## Add your own session kinds

A kind is a set of JSON-RPC methods plus a data sink and source. Use one when
you want the transport without a process behind it:

```ts
host.registerKind("rev", (ctx) => ({
  result: { motd: "lines come back reversed" }, // merged into the spawn result
  onData: (bytes) => {                          // client → host
    const line = Buffer.from(bytes).toString().trimEnd();
    ctx.write([...line].reverse().join("") + "\n"); // host → client
  },
  methods: {
    sum: ({ xs }) => ({ total: xs.reduce((a, b) => a + b, 0) }),
  },
  onClose: () => releaseWhatever(),
}));
```

Register kinds before clients spawn them; names are first-come. The handler
runs once per allowed spawn, after the spawn policy, and it may be async. A
handler that throws fails the spawn with `1002`.

`ack` and `close` are reserved for the host. Methods your kind does not define
fall through to the built-ins — `ping` answers on every kind — and then to
`-32601`. To return a coded error, throw an object with a numeric `code`, such
as `RpcError` from `@fsio/common`.

`ctx.exit(code)` publishes the exited status and stops delivery. The session
directory still waits for the client to close it. `onClose` does not fire after
your own `exit()`.

The `echo` kind is itself a registry entry. `shell` is native and its name is
reserved.

Kinds have no backpressure hook. `ctx.write` appends regardless of the
acknowledgement window — shell sessions pause their pty, and kinds have no
equivalent — so do not stream gigabytes from a kind.

## Advertise what you serve

Pages discover what a host can do by reading `.fsio/services.json`. The host
derives part of that document; the rest is what you claim:

```ts
const host = new HostServer({
  root: dir,
  services: {
    capabilities: ["notebook.export"],
    workspaces: [{ name: "notebook", label: "Notebook" }],
    needsGrant: ["shell"],
  },
});

host.setServices({ ...next }); // replace at runtime
host.services();               // the document as it would publish right now
```

`setServices()` is idempotent and cheap. The document is rewritten only when
its content actually changes, and only then does its revision number move —
which is the signal a page watches to know the document is worth re-reading.

Advertise a capability name only once the facility behind it works. A client
treats an unknown name as "not supported" rather than as an error, so a name
that arrives early is a promise you have not kept.

One `services.json` serves every page granted the directory. Put no paths and
no secrets in it.

## Serve more than one directory

By default a host serves the one directory you gave it, and a spawn request
that names a workspace gets error `1006`. Set `workspaceName` to give that
directory a name, or pass `workspaces` to resolve names against a registry:

```ts
const host = new HostServer({
  root: hubDir,
  workspaces: (name, info) => {
    const root = registry.get(name);
    if (!root) return { error: `no workspace named ${name}` };
    return { root, name };
  },
});
```

The resolver is synchronous by design: a registry lookup is a map read, and the
root it returns has to be identical for the policy's `info` and for the spawn
itself.

Two rules the host cannot enforce for you. The resolver must not substitute a
default for a name it cannot resolve, because the client would be told it ran
somewhere it did not. And the `error` string reaches the client verbatim, so it
must contain no paths and must not enumerate workspaces the client did not
name.

## Keep transcripts

By default an ended session takes its output with it. Set `transcripts` to keep
it under `.fsio/transcripts/<id>/`:

```ts
new HostServer({ root: dir, transcripts: true });
new HostServer({ root: dir, transcripts: { keep: 25, maxBytes: 64 * 1024 * 1024 } });
```

`keep` defaults to 10 transcripts and `maxBytes` to 32 MB in total. Both bounds
are enforced when a transcript is archived and again at startup, so lowering
them takes effect on the next run rather than at the next rotation. The newest
transcript is never swept.

Turn this on only if your sessions carry something worth outliving the host
that wrote it. Retention survives `fresh: true`.

## Terminal support

Shell sessions use a real pty when [node-pty](https://www.npmjs.com/package/node-pty)
is available and fall back to pipes when it is not. This package does not
declare node-pty as a dependency, because it is a native addon and most
embedders never need one. You have three choices:

- **Install it yourself.** `npm install node-pty` in your project. The host
  finds it at `start()` and `ptyAvailable` becomes `true`.
- **Inject a module.** Pass it as `pty` — useful for a test fake, whose
  `onData` and `onExit` must accept multiple listeners.
- **Skip it.** Pass `pty: false` to force the pipe fallback without probing.

If you install node-pty, be aware that it ships its `spawn-helper` binary
without the execute bit on some platforms, which surfaces as a spawn failure
rather than as a permissions error. A `postinstall` step that runs
`chmod +x node_modules/node-pty/prebuilds/*/spawn-helper` clears it.

## Command-line entry point

The fsio repository also contains a CLI wrapper, `fsio-host.js`, that adds
argument parsing, a timestamped logger, and `SIGINT` → `close()`. It is not
included in this package, which ships the library only. Clone the repository if
you want it.
