# @fsio/client

The fsio client library: sessions over a shared directory's `.fsio/`
subtree, per [spec/PROTOCOL.md](../../spec/PROTOCOL.md). Browser-first
(File System Access API), but not browser-only: the FS dependency is a
structural type, so anything that looks like the handles works — including
the Node fs shim the test suite uses (TESTING.md B1).

> **Status: nascent, unstable.** Not published (see
> [#7](https://github.com/dglazkov/fsio/issues/7)); the surface is the
> deliberate API pass of
> [#17](https://github.com/dglazkov/fsio/issues/17), recorded as
> [D11](../../spec/DECISIONS.md#d11--client-library-surface-events-synchronous-construction-structural-fs-types).
> Freezing is [#8](https://github.com/dglazkov/fsio/issues/8)'s job.

## Use

```ts
import { FsioClient } from "@fsio/client";

const root = await showDirectoryPicker({ mode: "readwrite" });
const client = new FsioClient(root);
const host = await client.connect(); // {alive, ageMs, info} from host.json

const session = client.createSession({ kind: "shell", cols: 80, rows: 24 });
session.on("data", (bytes) => term.write(bytes)); // xterm takes Uint8Array
session.on("status", (st) => { if (st.state === "exited") onExit(st); });
session.on("error", (e) => report(e));

const info = await session.ready; // rejects with RpcError on spawn refusal
session.sendData("ls\n");
session.notify("resize", { cols, rows });
// later:
await session.close(); // host owns cleanup of the session dir (D6)
```

### Semantics worth knowing (D11)

- **`createSession()` is synchronous.** No I/O happens before it returns,
  so listeners attached in the same synchronous window cannot miss events.
  Every init failure rejects `session.ready`.
- **`on(type, fn)` returns the unsubscribe function.** Event types:
  `frame` (every delivered frame, RPC responses excluded), `data` (DATA
  payloads — the one obvious way to consume output), `status`, `note`
  (non-fatal observations, e.g. the D7 observer→poll downgrade), `error`
  (async failures: uplink commit errors, throwing listeners). A throwing
  listener routes to `error` and never loses frames.
- **`close()` drops all listeners** and fails pending requests; the *host*
  deletes the session dir (D6) — never delete it client-side.
- **Labs surface:** `session.stats` (lane counts, bytes, wakeups),
  `session.uplinkBacklog()`, `session.mode` (effective notifier after any
  downgrade).

### Options (`createSession(spec, opts)`)

| option | default | meaning |
|---|---|---|
| `mode` | `auto` | notifier: `auto`→`adaptive` (observer sentinel + hot poll) or `poll` where observers don't exist; also `hybrid`, `observer` (for science) |
| `pollMs` | `5` | hot-poll interval |
| `uplink` | `auto` | `auto`: ≤180 B batches ride the dirname fast lane (F10), bigger fall back to file chunks; `file` forces chunks |
| `safetyMs` | `500` | slow safety poll; `0` disables (measurement labs) |

## Bundlerless use

`dist/` is plain ESM with relative imports — loadable straight from a
browser given an import map for the one bare specifier:

```html
<script type="importmap">
  { "imports": { "@fsio/common": "/path/to/common/dist/index.js" } }
</script>
```

Bundlers (the workbench uses vite) just follow the `exports` map.
