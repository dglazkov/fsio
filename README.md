# @fsio/client

Open sessions against an fsio host from a browser page. The host runs in a Node
process on the same machine; the two halves communicate by reading and writing
files under a `.fsio/` subtree of a directory they both hold. There is no port,
no socket, and no server.

The Node half is [`@fsio/host`](https://github.com/dglazkov/fsio/tree/main/packages/host).
The file formats both halves use are specified in
[spec/PROTOCOL.md](https://github.com/dglazkov/fsio/blob/main/spec/PROTOCOL.md).

> **Stability: unstable.** The API changes without notice and without a
> deprecation period. Pin the exact commit your project resolved — the
> instructions below produce a lockfile entry that does this for you.

## Requirements

A browser with the File System Access API. This package needs
`showDirectoryPicker()` and the handle types it returns.

The FS dependency is a structural type rather than a named one, so anything
shaped like the handles works. The fsio test suite drives this package from
Node against a shim built on `node:fs`. That shim is not part of this package;
if you want one, write it against the `FsDirectory`, `FsFile`,
`FsWritable`, and `FsSnapshot` types exported here.

## Install

```sh
npm install github:dglazkov/fsio#client
```

This package is distributed from a branch of the fsio repository rather than
from npm. The command adds `@fsio/client` to your dependencies and installs
`@fsio/common`, the protocol types both halves share, alongside it.

Install `@fsio/host` from the same repository for the Node half:

```sh
npm install github:dglazkov/fsio#host
```

Both packages depend on the same `@fsio/common` branch, so npm installs one
copy and both halves see the same types and the same `RpcError` class.

## Open a session

```ts
import { FsioClient } from "@fsio/client";

const root = await showDirectoryPicker({ mode: "readwrite" });
const client = new FsioClient(root);

const { alive, ageMs, info } = await client.connect();
if (!alive) throw new Error(`no host on this folder (last beat ${ageMs} ms ago)`);

const session = client.createSession({ kind: "shell", cols: 80, rows: 24 });
session.on("data", (bytes) => term.write(bytes));
session.on("status", (st) => { if (st.state === "exited") onExit(st); });
session.on("error", (err) => report(err));

await session.ready;          // rejects with RpcError if the host refuses
session.sendData("ls\n");
session.notify("resize", { cols: 100, rows: 30 });

await session.close();
```

Call `connect()` before anything else. It opens `.fsio/` and `.fsio/sessions/`,
creating them if needed, and then returns what `hostInfo()` returns: whether a
host is alive, how old its last heartbeat is, and the heartbeat's contents.

`createSession()` is synchronous on purpose. No I/O happens before it returns,
so listeners you attach in the same synchronous block cannot miss an event.
Every asynchronous failure — creating the session folder, committing the spawn
request, the host refusing — rejects `session.ready` instead.

## Connect the two halves

The page and the host never address each other directly. They meet because
they hold the same directory:

1. A Node process starts a `HostServer` on a directory.
2. Your page calls `showDirectoryPicker()` and the person using it selects
   that same directory.
3. You construct an `FsioClient` on the handle and call `connect()`.

Nothing else connects them. The person choosing the directory in step 2 is the
entire access-control decision.

## Spawn specs

`createSession()` takes a spec whose `kind` decides the rest.

```ts
client.createSession({ kind: "echo" });
client.createSession({
  kind: "shell",
  cols: 80, rows: 24,
  cmd: "/bin/zsh", args: ["-l"],  // omit for the host user's $SHELL
  cwd: "src",                     // relative to the workspace root
  workspace: "notebook",          // required when the host serves several
  pty: false,                     // force the pipe fallback
});
client.createSession({ kind: "rev", anything: "the host's kind defines it" });
```

Every spec also takes `client`, a free-form string that identifies your page in
the host's session list and in diagnostics.

A shell session spawns a real process, and the host decides whether to allow
it. A refusal rejects `session.ready` with an `RpcError` carrying a numeric
`code`: `1004` for a policy denial, `1003` for an unknown kind, `1006` for an
unresolvable workspace.

## Events

Subscribe with `on(type, listener)`, which returns the function that
unsubscribes. `close()` drops every listener.

| Event | Arguments | Fires when |
|---|---|---|
| `data` | `bytes: Uint8Array` | The host sends output. This is the one you want. |
| `frame` | `frame, at` | Any frame is delivered, including data. Responses to your own requests are consumed by the control plane and do not appear. |
| `status` | `status: SessionStatus` | The session's status file changes. Compared deeply, so this does not fire on rewrites that changed nothing. |
| `replay` | `phase: "start" \| "end", gen: number` | Scrollback replay begins and ends. See [Reattach](#reattach-to-a-running-session). |
| `note` | `note: string` | Something non-fatal happened, such as the notifier falling back to polling. |
| `error` | `error: Error` | An asynchronous failure the library cannot throw at you, such as a failed upload commit or a listener that threw. |

A listener that throws routes to `error` and never costs you a frame. With no
`error` listener attached, these are rethrown on a fresh stack so they surface
as uncaught errors rather than vanishing.

## Send

| Method | Description |
|---|---|
| `sendData(text)` | Send text as a data frame. |
| `send(type, payload)` | Send a raw frame. |
| `sendJson(type, obj)` | Send JSON as a frame of the given type. |
| `request(method, params, opts)` | JSON-RPC request; resolves `{result, rx}`. Pass `opts.timeoutMs` to bound the wait. |
| `notify(method, params)` | JSON-RPC notification: `resize`, `ack`, `close`, and anything a custom kind defines. |

Frames queued while a commit is in flight are batched into a single chunk, and
commits are strictly serialized, so you can send as fast as you like without
coordinating.

## Session options

Pass these as the second argument to `createSession()` or `attachSession()`.

| Option | Default | Description |
|---|---|---|
| `mode` | `auto` | How the client learns there is new output. `auto` becomes `adaptive` where file-system observers exist and `poll` where they do not. `hybrid` and `observer` exist for measurement. |
| `pollMs` | `15` | Fast poll interval. Round-trip time tracks this value closely. |
| `uplink` | `auto` | How outgoing bytes travel. `auto` sends small batches over the fast path and larger ones as chunk files; `file` and `dirname` force one or the other. |
| `safetyMs` | `500` | Slow backup poll. `0` disables it. |
| `heartbeatMs` | `20000` | How often the page tells the host it is still there, so the host can distinguish a thinking client from a gone one. `0` disables it. |
| `observeSettleMs` | `2000` | How long to wait for the observer to settle before downgrading to polling. |
| `uplinkLane` | shipped thresholds | `{slowMs, reprobeMs}` for the fast-path probe. |

Lowering `pollMs` below the default mostly buys CPU rather than latency: the
wake loop saturates once the interval approaches the time a wake takes, which is
around 4 ms on a fast machine (*measured*). Raising it above one display frame
is what a person notices.

Read `session.mode` after `ready` for the mode actually in effect, which may be
a downgrade from what you asked for.

## Reattach to a running session

A shell keeps running when the page holding it goes away. `listSessions()`
enumerates what is there and `attachSession()` takes one over.

```ts
for (const s of await client.listSessions()) {
  console.log(s.id, s.kind, s.status?.detached ? "detached" : "live");
}

const session = client.attachSession(id, { replay: true });
const info = await session.ready; // AttachResult: kind, pid, epoch, …
```

Attaching is a takeover, not a second viewer. The grant raises the session's
writer epoch, moves the upload directory, and fences the previous client, which
sees the change and stops sending. Read `session.epoch` to know which
generation you own; a higher epoch in the status file means someone has taken
the session from you.

With `replay: true`, the host re-emits the stored output before live traffic
resumes, bracketed by `replay` events:

```ts
let replaying = false;
session.on("replay", (phase) => { replaying = phase === "start"; });
session.on("data", (bytes) => {
  term.write(bytes);
  if (!replaying) runSideEffects(bytes); // don't re-run history
});
```

The bracket fires even when there is nothing to replay, so your state machine
stays symmetric. Replay covers the newest segment only: if `gen` is higher than
the one you saw last time, older output has been rotated away and what you are
receiving is the tail rather than the whole session.

To walk away without ending the session, call `detach()`. It asks the host to
mark the session detached immediately instead of waiting for heartbeat silence,
then releases local resources. The process keeps running for a later
`attachSession()`. Call `close()` when you mean to end it: that fails pending
requests and lets the host delete the session directory. Never delete that
directory yourself.

## Ask what the host can do

```ts
if (await client.hasCapability("notebook.export")) enableExportButton();

const doc = await client.services();
for (const kind of doc?.kinds ?? []) console.log(kind.name, kind.needsGrant);
```

Feature-detect on capability names, never on protocol version ranges, and treat
a name you do not recognize as "not supported" rather than as an error.

The service document is larger and colder than the heartbeat, so it has a
doorbell: `host.json` carries a revision number. If you are already reading the
heartbeat, pass that number to `services(rev)` and you get your cached copy back
untouched unless the number moved.

## Load without a bundler

`dist/` is plain ESM with relative imports, so a browser can load it directly
given an import map for the one bare specifier:

```html
<script type="importmap">
  { "imports": { "@fsio/common": "/node_modules/@fsio/common/dist/index.js" } }
</script>
```

Bundlers follow the `exports` map and need no configuration.

## Measurement surface

`session.stats` counts chunks, bytes, wakeups, retries, and fast-path
fallbacks. `session.uplinkBacklog()` reports uncommitted outgoing chunks. These
exist for the fsio benchmarks and are not a stable API; they change whenever the
transport does.
