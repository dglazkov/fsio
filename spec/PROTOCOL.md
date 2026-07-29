# fsio protocol — v0 (working draft)

Normative spec for a filesystem-based bridge between stdio and the Web
Platform File System API. Changes to this document track protocol versions.

Companions (non-normative):

- [FINDINGS.md](FINDINGS.md) — measured platform behaviors (F1–F20) behind
  the rules here. Rules that exist because of a finding cite it.
- [DECISIONS.md](DECISIONS.md) — the decision log (D1–D19): why the protocol
  is shaped this way, with alternatives rejected.

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as in
RFC 2119.

## Roles

Two peers share a directory:

- **client** — typically a web page holding a `FileSystemDirectoryHandle`
  (user-picked, `mode: "readwrite"`), watching with `FileSystemObserver` or
  polling.
- **host** — a native process (Node prototype in `packages/host`) with
  ordinary POSIX file access, watching with `fs.watch`.

All protocol state lives under `<shared-dir>/.fsio/`. The transport is "just
files"; every mechanism below exists to survive the constraints of the two
runtimes (atomicity, append semantics, event coalescing).

## Design invariants

1. **Events are wakeups, not messages.** Watch/observer events may be
   coalesced, duplicated, or dropped. On any wakeup a peer MUST run a full,
   idempotent scan. Peers MUST keep a slow safety poll (250–500 ms) as a
   backstop, in every notification mode.
   ([D1](DECISIONS.md#d1--events-are-wakeups-not-messages); F1, F2, F6)
2. **Never encode meaning in file events.** All meaning is in file *contents
   and names*. The protocol MUST work identically under pure polling. A
   corollary: watcher/observer startup failure MUST downgrade to polling,
   never be fatal.
   ([D7](DECISIONS.md#d7--observer-failure-downgrades-to-polling); F9)
3. **Readers must tolerate torn state.** A trailing partial frame or an
   empty chunk file means "in progress" — wait, never skip. A failed
   snapshot read (e.g. Chrome's `NotReadableError`) is transient: the
   offset hasn't advanced, so the next wakeup re-reads.
   ([D8](DECISIONS.md#d8--snapshot-read-failures-are-transient); F11)
4. **One writer per file, one cleanup owner.** Every file in the protocol
   has exactly one writer. Session cleanup is owned by the host.
   ([D6](DECISIONS.md#d6--one-writer-per-file-one-cleanup-owner); F8)
5. **The transport is asymmetric because the runtimes are.**
   ([D2](DECISIONS.md#d2--asymmetric-transport-append-only-log-down-atomic-chunks-up))
   - Host → client: **append-only log** (`out.log`). POSIX appends are
     cheap; the client reads from a byte offset.
   - Client → host: **numbered chunk files** (`in/NNNNNNNN.f`). The browser
     cannot cheaply append (`FileSystemWritableFileStream` rewrites the
     whole file via a swap file and commits on `close()` — which is exactly
     an atomic commit, so we lean on it). Native clients MUST emulate the
     same atomicity with write-temp-then-rename.

## Directory layout

```
<shared-dir>/.fsio/
  fsio.json                 # { protocol: 0 }
  host.json                 # host heartbeat; rewritten (atomically) every 2s
  client/                   # client-owned diagnostics (not protocol): pages
    <client-id>/            # mirror logs, errors, and results here so the
      log.txt               # native side can read them. One dir per page
      report.json           # load, id = c-<ts36>-<rand> — two pages on one
                            # dir must not share files (one writer per
                            # file). Consumers pick by recency; the host
                            # sweeps stale dirs beyond a small cap (D6)
  sessions/
    <session-id>/           # created by client; id = s-<ts36>-<rand>
      spawn.json            # JSON-RPC spawn request; written LAST by
                            #   client — presence = session is ready
      attach.<aid>.json     # attach request (D18): bootstrap file like
                            #   spawn.json, one per attacher (aid in the
                            #   name); host deletes it after answering
      status.json           # host-owned: {state: running|exited|error, ...}
      out.00000000.log      # host → client framed stream, segmented: rotated
      out.00000001.log      #   at ~8 MB on frame boundaries; consumed
                            #   segments are deleted once acked
      out.sig               # doorbell + stream map (rename-committed JSON):
                            #   {gen, size, prevFinal, total}
      in/
        00000001.f          # client → host chunk file (payload = content)
        00000002-<b64url>/  # …or chunk directory (payload = name; fast lane
                            # for batches ≤180 B, see F10). One sequence space.
      in.<epoch>/           # uplink of the epoch-<N> writer after an attach
                            #   takeover (D18): same chunk rules, fresh
                            #   sequence space; the host consumes ONLY the
                            #   current epoch's dir
```

## Framing

Both the downlink log and each uplink chunk are concatenations of frames:

```
[u32le payload_length][u8 type][payload]
```

| type | name | payload |
|---|---|---|
| 1 | DATA | raw stdio/pty bytes |
| 5 | RPC  | one JSON-RPC 2.0 message — see [Control plane](#control-plane-json-rpc-20) |

Types 2–4 are reserved: they carried early-v0 ad-hoc control messages
(PING/PONG/CTL), replaced by RPC
([D10](DECISIONS.md#d10--json-rpc-20-control-plane-over-rpc-frames)).
They MUST NOT be reused.

Timestamps are `performance.timeOrigin + performance.now()` — epoch-based
ms, comparable across processes on one machine.

## Control plane (JSON-RPC 2.0)

All control messaging is JSON-RPC 2.0
([D10](DECISIONS.md#d10--json-rpc-20-control-plane-over-rpc-frames)).
DATA stays raw bytes in DATA frames — only control rides JSON.

- One JSON-RPC message per RPC frame. Batch arrays MUST NOT be used (the
  chunk layer already batches frames; two batching layers help no one).
- Requests (with `id`) get exactly one response on the opposite stream.
  Notifications (no `id`) are fire-and-forget.
- Responses MAY be duplicated (e.g. a restarted host re-answering spawn on
  re-adoption). A peer MUST ignore responses whose `id` it is not awaiting.
- An unknown method in a request gets error `-32601`; in a notification it
  is ignored (and SHOULD be logged).

Methods (v0, all client → host):

| method | kind | params | result |
|---|---|---|---|
| `spawn` | request (rides `spawn.json`) | session spec, see [Session kinds](#session-kinds-v0) | `{kind, pid, pty?, cmd?}` |
| `ping` | request | `{t0, filler?}` | params echoed + `{t1, t2}` (host read/append times) |
| `resize` | notification | `{cols, rows}` | — |
| `signal` | notification | `{sig}` | — |
| `eof` | notification | `{}` | — |
| `close` | notification | `{}` | — |
| `ack` | notification | `{total}` | — |
| `heartbeat` | notification | `{}` | — |
| `attach` | request (rides `attach.<aid>.json`) | `{aid, client?, origin?}` | spawn-result fields + `{epoch}` |
| `detach` | notification | `{}` | — |

Application error codes (beyond the JSON-RPC predefined range): `1001`
shell-not-allowed, `1002` spawn-failed, `1003` unknown-kind, `1004`
spawn-denied (host policy refused; the message carries the policy's
reason — [D12](DECISIONS.md#d12--spawn-policy-is-a-host-side-hook-confirmation-is-an-async-policy)),
`1005` attach-failed (session exited or not attachable —
[D18](DECISIONS.md#d18--attach-is-takeover-writer-epochs-fence-the-old-client)).

**Spawn bootstrap.** The `spawn` request cannot ride the uplink (the host
only consumes `in/` after adopting the session), so its envelope is the
content of `spawn.json` (conventionally `id: 0`) — the file is the
transport, the semantics are unchanged. The host answers on the out
stream: a result when the session is live, or an error object with a code
(a failed spawn is no longer a `status.json` state the client must poll
for and interpret).

The host MAY delay the spawn answer arbitrarily (policy confirmation — a
human prompt, an allow-list service;
[D12](DECISIONS.md#d12--spawn-policy-is-a-host-side-hook-confirmation-is-an-async-policy))
and MUST NOT consume uplink chunks before answering with a result: a
pending session gets no service. Clients therefore own their spawn
timeouts, and anything sent before `ready` queues rather than fails.

**Fast-lane budget.** Envelope overhead is ~30–40 B per message; every v0
control message fits the 180 B dirname-lane budget with ≥ 70 B to spare
(measured, framed: `ping` 81 B, `ack` 65 B, `resize` 72 B, `close` 39 B).
Only filler-padded pings and DATA batches spill to the file lane.
(F10, [D5](DECISIONS.md#d5--dirname-fast-lane-for-small-uplink-batches))

## Uplink (client → host)

- Chunks are numbered files or directories under `in/`, consumed strictly
  in ascending sequence order.
- A chunk MAY contain multiple frames (the client batches frames queued
  while a previous commit was in flight — the natural write-side
  backpressure/coalescing mechanism). A chunk MUST NOT end mid-frame; if
  the host reads a partial or empty chunk it MUST retry shortly (the
  browser's swap-file commit can appear as create-empty → content-appears).
- A client MUST serialize commits (chunk N fully committed before N+1
  starts) so order of appearance matches order of naming. This is a
  client obligation because it is not host-detectable: the host discovers
  its base sequence from the smallest chunk present (required for restart
  adoption, where earlier chunks were already consumed and deleted), so a
  violating first commit is indistinguishable from a resumed stream. After
  the base is discovered, a sequence gap stalls consumption until filled.
- A corollary: a failed commit MUST NOT abandon its sequence number — the
  gap it would leave wedges the session's uplink permanently. The client
  SHOULD retry the *same* number with bounded backoff before surfacing a
  transport error. A same-seq retry is idempotent by construction: an
  uncommitted swap file was never visible; directory creation is
  create-or-open; and a chunk re-created below the host's consumption
  point is inert (never consumed, removed with the session dir — D6).
  Observed trigger: Chrome aborting `close()` mid-stream
  (`AbortError: Aborted due to security policy`,
  [#37](https://github.com/dglazkov/fsio/issues/37)) — the write-side
  analogue of invariant 3's transient read failures.
- **Two lanes, one sequence space**
  ([D5](DECISIONS.md#d5--dirname-fast-lane-for-small-uplink-batches); F7, F10):
  frame batches ≤180 raw bytes SHOULD be committed as a created directory
  whose name carries the base64url payload (`NNNNNNNN-<b64url>/`) —
  directory creation skips the browser's expensive after-write scan.
  Larger batches use file chunks (`NNNNNNNN.f`). Ordering across lanes is
  preserved by the shared sequence numbers.
- **File chunks are the always-works lane; the dirname lane is an
  optimization** ([#4](https://github.com/dglazkov/fsio/issues/4)): the
  fast lane exploits a non-contractual Chrome asymmetry (F10, confirmed
  Safe Browsing by F13/#11) that any release could close, and encodes
  payload in names, which filesystems constrain (length limits, character
  rules). A consumer MUST accept every chunk sequence as file chunks; a
  client MUST be able to fall back to the file lane at any point
  mid-session and MUST abandon a dirname commit that fails where a file
  commit succeeds. A failed-then-retried seq MAY re-land on the other
  lane; if both commits become visible, the host consumes whichever it
  maps last and the twin is inert below the consumption point (removed
  with the session dir, D6). A client SHOULD also monitor the lane's
  latency advantage (its sole reason to exist) and prefer file chunks
  when it is gone — the reference client times real commits, parks the
  lane after a streak of scan-floor-priced dir commits, and re-probes it
  with one live batch per cooldown window.
- Case-folding filesystems (APFS, NTFS, exFAT are case-insensitive but
  case-PRESERVING) cannot collide dirname chunks: distinct chunks always
  differ in the decimal seq prefix, and a same-seq retry re-creates the
  byte-identical name. Case-DESTROYING filesystems (bare FAT16) would
  corrupt payloads and are out of scope
  ([#4](https://github.com/dglazkov/fsio/issues/4) audit; the
  failure-fallback above is the net).
- The host deletes a chunk after consuming it; deletion **is** the ack.
  Client-side backpressure = cap on outstanding (not-yet-deleted) chunks.
  (Not yet implemented; see open questions.)

## Downlink (host → client)

- The host appends frames to the current log segment
  (`out.<gen>.log`), rotating at ~8 MB on a frame boundary.
- After every append the host MUST bump `out.sig` via temp+rename
  ([D3](DECISIONS.md#d3--rename-committed-doorbell-outsig); F1 — held-fd
  appends are invisible to watchers; renames wake them reliably).
  `out.sig` is both **doorbell** and **stream map**: `gen`/`size` locate
  the write head, `prevFinal` tells a reader when the previous segment is
  fully drained, `total` is cumulative bytes for ack accounting.
- **Flow control**
  ([D9](DECISIONS.md#d9--segmented-log-with-cumulative-ack-flow-control);
  F12): the client acks cumulative consumed bytes (`ack` notification
  `{total}`, riding the dirname fast lane, throttled to 250 ms / 256 KB).
  The host
  pauses the pty when unacked > 4 MB and resumes below 2 MB;
  fully-acked segments are deleted by the host.

## Session lifecycle

- The client creates `sessions/<id>/` with `in/`, then writes `spawn.json`
  (the JSON-RPC spawn request) **last**; its presence means the session is
  ready, so the host adopts only complete sessions. The host answers the
  request on the out stream (see [Control plane](#control-plane-json-rpc-20)).
- The host owns `status.json`: `{state: running|exited|error, ...}` — the
  durable state record (it outlives the spawn response: a late-attaching
  reader or a restarted client can always learn the session's fate).
- Client `close()` sends the `close` notification and stops watching — it
  MUST NOT
  delete anything ([D6](DECISIONS.md#d6--one-writer-per-file-one-cleanup-owner);
  F8). The host deletes the session dir ~500 ms after close, and GCs stale
  exited sessions (>60 s) on adoption.
- Liveness = `host.json` mtime younger than 6 s (3 missed heartbeats).
- **One live host per `.fsio`**
  ([#40](https://github.com/dglazkov/fsio/issues/40); invariant 4 — F8,
  [D6](DECISIONS.md#d6--one-writer-per-file-one-cleanup-owner)): a starting
  host MUST refuse to serve a directory whose `host.json` is live by the
  rule above — a second live host would spawn every adopted session again,
  consume uplink chunks the first host then sees as gaps, write every
  host-owned file alongside it, and grant its own attach epochs
  ([D18](DECISIONS.md#d18--attach-is-takeover-writer-epochs-fence-the-old-client)).
  An explicit takeover override MAY skip the refusal (for a killed host
  whose last heartbeat has not yet gone stale). This is a seatbelt, not a
  distributed lock: two hosts starting within one heartbeat window can
  still collide, and the protocol otherwise assumes they don't.
- **Client presence and detach**
  ([D17](DECISIONS.md#d17--client-heartbeats-opt-in-detached-marking-instead-of-kill); F16):
  a client SHOULD send the `heartbeat` notification periodically (reference
  cadence 20 s; it fits the dirname fast lane). Sending one opts the
  session into vanished-client policy; a client that never does is judged
  only by the legacy idle rules. The host counts any consumed uplink chunk
  as presence. When a heartbeat-aware client is silent past the detach
  window — which MUST exceed 3 minutes' worth of the browser's 1/min
  background timer clamp (F16: a hidden tab beats at 1/min after 5 min,
  through no fault of its own) — the host marks a stateful session
  `detached: true` in `status.json` (state unchanged) and MAY reap
  stateless sessions (echo). The host MUST NOT kill a session's process
  for heartbeat silence alone. Any subsequently consumed uplink chunk
  clears the marker. The `detach` notification marks the session detached
  immediately — the deliberate walk-away needs no silence window.
- **Attach / takeover**
  ([D18](DECISIONS.md#d18--attach-is-takeover-writer-epochs-fence-the-old-client)):
  a new client MAY attach to a running session by committing
  `attach.<aid>.json` — a JSON-RPC `attach` request in a bootstrap file,
  like spawn.json (a would-be writer cannot ask on an uplink it doesn't
  own). `aid` MUST be unique per attempt and appears in the file name, so
  concurrent attachers never share a file. The host answers on the out
  stream (naturally multi-reader), deletes the file after answering
  (deletion = consumption), and judges the request with the same policy
  hook as spawn (`attach: true`, the attacher's identity). A grant bumps
  the **writer epoch**: the uplink moves to `in.<epoch>/` with a fresh
  sequence space, and `status.json` records `writer: {epoch, aid}` and
  clears `detached`. The host MUST consume only the current epoch's
  uplink dir. A client observing a writer epoch above its own has been
  superseded: it MUST stop committing chunks (one writer per file,
  F8/D6) but MAY keep reading. A client whose own attach is pending has
  no epoch to compare yet: it MUST NOT treat a writer record observed in
  that window as a fence — the record may be its own grant landing, or a
  predecessor's stale record (every previously-attached session carries
  one) — and MUST judge the fence once, against the granted epoch, when
  the grant settles; a deduped status stream will not re-emit the record
  (the [#58](https://github.com/dglazkov/fsio/issues/58) loop found the
  reference client fencing itself on both variants — resumed sessions
  accepted keystrokes and silently dropped them). Nothing can be
  committed in that window regardless: the attacher's uplink dir does
  not exist before the grant. Attaching to an exited session gets
  `1005`. Scrollback replay is client-local (the reference client re-reads
  the retained head segment; full multi-segment replay is
  [#57](https://github.com/dglazkov/fsio/issues/57)). Replayed RPC frames
  MUST NOT be re-correlated — the previous writer's response ids can
  collide with live ones. The attacher's acks start at the head it
  attached at, which clears the predecessor's unacked window on first
  ack — a paused pty resumes.

## Session kinds (v0)

Spawn params (the `spawn` request's `params`):

- `{"kind": "echo"}` — host answers `ping` requests with host-side
  timestamps. The latency workbench.
- `{"kind": "shell", cols, rows, cmd?, args?, cwd?}` — host spawns a shell
  under a pty (node-pty if installed; pipe fallback otherwise). DATA frames
  flow both ways; `resize`/`signal`/`close` control it. Gated by the host
  spawn policy ([D12](DECISIONS.md#d12--spawn-policy-is-a-host-side-hook-confirmation-is-an-async-policy)):
  the CLI's `--allow-shell` is the static form (violations get error
  `1001`); embedders install `onSpawnRequest` hooks (denials get `1004`).

Every spawn spec MAY carry two advisory identity fields: `client` (free-form
tag) and `origin`. A client that is a web page SHOULD report its web origin
in `origin`; the reference client library stamps `location.origin` itself,
overriding caller-supplied values, so a page cannot claim a foreign origin
through the API. Hosts MUST treat both fields as unauthenticated
diagnostics — display material, never an authorization input: anything that
can write the shared directory can write any identity it likes
([D15](DECISIONS.md#d15--origin-is-client-stamped-advisory-and-display-only),
[#6](https://github.com/dglazkov/fsio/issues/6)).

Kinds beyond these two are host-defined
([D13](DECISIONS.md#d13--session-kinds-are-a-host-side-registry-echo-is-just-an-entry)):
a host MAY serve additional kinds registered by its embedder, with
kind-specific spawn params and kind-specific extra fields in the spawn
result. The wire behavior is unchanged — DATA frames plus JSON-RPC — and
"unknown kind" (`1003`) means *not in this host's registry*. `ack` and
`close` keep their host-level meaning on every kind; `ping` MUST be
answered on every kind (it is the transport diagnostic).

## Security posture (v0 stance)

Running the host with `--allow-shell` grants any page that can write to the
shared directory the ability to run processes as the user. The *mechanism*
for per-session confirmation and allow-lists now exists — the async
`onSpawnRequest` policy hook sees the resolved command and can take
arbitrarily long to answer
([D12](DECISIONS.md#d12--spawn-policy-is-a-host-side-hook-confirmation-is-an-async-policy))
— and sessions now carry an advisory `origin` a policy or host UI can
display
([D15](DECISIONS.md#d15--origin-is-client-stamped-advisory-and-display-only);
the terminal-demo helper does) — but no shipped policy gates on either, and
`origin` is unauthenticated by design. Still to spec: the allow-list/
confirmation content itself (#6), authenticating origin claims (#6),
`.fsio/` auto-added to `.gitignore`,
scrubbing env in `spawn.json`, and log retention limits (the log contains
full scrollback).

## Open questions

Each unresolved question is tracked by a GitHub issue. Question numbers
are stable — issues cite them — so resolved questions collapse to a
pointer at the decision that settled them; they are never deleted or
renumbered.

1. **out.log growth / backpressure.** Resolved →
   [D9](DECISIONS.md#d9--segmented-log-with-cumulative-ack-flow-control)
   (F12); normative rules under [Downlink](#downlink-host--client).
2. **Chunk-count backpressure** client→host: cap outstanding chunks (host
   deletes = credit returned). Currently unbounded — but the client's
   serialized commits self-throttle (measured, F13: a 400-ping flood
   peaked at 3 outstanding chunks); low priority.
   → [#10](https://github.com/dglazkov/fsio/issues/10)
3. **Out-of-band control?** Control messages currently share the `in/`
   sequence; a huge paste delays a resize. Separate `ctl/` lane, or
   priority chunks?
   → [#10](https://github.com/dglazkov/fsio/issues/10)
4. **Observer latency.** Is FileSystemObserver's wakeup latency acceptable,
   or does the browser client need the hot-poll mode too? (F2 suggests the
   underlying FSEvents stream latency depends on what the watcher requests;
   Chrome may tune it differently than libuv.)
   → [#12](https://github.com/dglazkov/fsio/issues/12)
5. **Multiple clients per session.** The downlink log is naturally
   multi-reader (read-only followers are free); `in/` writes would collide.
   Follower role worth speccing?
   → [#10](https://github.com/dglazkov/fsio/issues/10)
6. **Host restarts.** Currently adopts sessions and resumes echo, but marks
   shell sessions dead. ~~Should shell sessions be resumable (reattach to
   a detached pty à la tmux)?~~ Client-side reattach resolved by
   [D18](DECISIONS.md#d18--attach-is-takeover-writer-epochs-fence-the-old-client)
   (attach/takeover with writer epochs; the epoch is durable in
   status.json, so a restarted host resumes the right uplink lane).
   Remaining: the host-side leg — a pty dies with the host process, so
   surviving a *host* restart needs host-side pty persistence (out of
   scope for v0).
   → [#3](https://github.com/dglazkov/fsio/issues/3)
7. **Windows / network filesystems.** rename atomicity, watch semantics,
   and mtime resolution all differ. Out of scope for v0; spec should state
   assumptions explicitly.
   → [#5](https://github.com/dglazkov/fsio/issues/5)
8. **Uplink floor workarounds.** ~~Resolved by F10~~: the dirname fast lane
   sidesteps the `close()` scan entirely (69 ms → 2.8 ms). ~~Is the trick
   durable?~~ Hardened by
   [#4](https://github.com/dglazkov/fsio/issues/4): file chunks are the
   normative always-works lane (see Uplink); the client falls back on
   dirname failure, parks the lane when its latency advantage disappears
   (the scan-asymmetry regression), and re-probes it periodically. Drift
   in the underlying numbers is
   [#22](https://github.com/dglazkov/fsio/issues/22)'s job. Remaining:
   should bulk file-chunk traffic get local-echo masking for the
   paste-heavy case →
   [#10](https://github.com/dglazkov/fsio/issues/10) (local echo)
9. **Cleanup ownership.** ~~Who deletes finished session dirs?~~ Resolved
   by F8/D6: the host, on CTL `close` and via stale-session GC.
   ~~Remaining: GC for sessions whose client vanished without sending
   `close`~~ — resolved by
   [D17](DECISIONS.md#d17--client-heartbeats-opt-in-detached-marking-instead-of-kill)
   (client heartbeats; vanished stateless sessions reaped, stateful ones
   marked detached). ~~Remaining: reattach to a detached session~~ —
   resolved by
   [D18](DECISIONS.md#d18--attach-is-takeover-writer-epochs-fence-the-old-client)
   (attach/takeover; stale-epoch uplink dirs are removed with the session
   dir, D6).
   → [#3](https://github.com/dglazkov/fsio/issues/3)
