# fsio protocol — v0 (working draft)

Normative spec for a filesystem-based bridge between stdio and the Web
Platform File System API. Changes to this document track protocol versions.

Companions (non-normative):

- [FINDINGS.md](FINDINGS.md) — measured platform behaviors (F1–F22) behind
  the rules here. Rules that exist because of a finding cite it.
- [DECISIONS.md](DECISIONS.md) — the decision log (D1–D26): why the protocol
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
  services.json             # capability document, if the host publishes one
                            #   (D24): rewritten ONLY when its content
                            #   changes; host.json's servicesRev is the
                            #   doorbell. See "Service directory"
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
[D18](DECISIONS.md#d18--attach-is-takeover-writer-epochs-fence-the-old-client)),
`1006` unknown-workspace (no such name in this host's registry, or not
visible to this client —
[D22](DECISIONS.md#d22--workspaces-are-session-parameters-resolved-by-a-daemon-private-registry)),
`1007` grant-required (no valid grant covers this request; absent, expired,
invalid, and revoked are deliberately one code —
[D23](DECISIONS.md#d23--consent-is-host-served-and-grants-are-proof-of-possession-capabilities)).
`1006`/`1007` are hub-deployment codes (see [Hub deployment](#hub-deployment));
a one-folder host never emits them.

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
- **The bootstrap commits are covered by that rule too, with their own
  retry keys** ([#116](https://github.com/dglazkov/fsio/issues/116)). This
  was left implicit and cost a live session: the rule above was read as
  being about chunk sequence numbers, so `spawn.json` and
  `attach.<aid>.json` shipped as one-shot commits, and a single abort on
  the attach bootstrap rejected an attach to a running, attachable session.
  They are *more* exposed than chunks, not less — single files on the
  critical path, no pump behind them, and both are file-lane writes (a real
  `close()`, the operation Chrome aborts).
  - `spawn.json` retries the **same file**: the host reads it and never
    deletes it, and start is guarded, so a re-commit of identical bytes is
    inert whether or not the first became visible.
  - `attach.<aid>.json` MUST retry with a **fresh `aid`**, never the same
    one. The host unlinks it *before* deciding — that delete is its
    consumption ack — so a same-aid retry after a "landed but still threw"
    abort produces a second grant and a second epoch bump, and the attacher,
    still writing to the first grant's `in.<epoch>/`, reads the higher epoch
    from `status.json` and fences *itself*
    ([D18](DECISIONS.md#d18--attach-is-takeover-writer-epochs-fence-the-old-client)).
    A superseded attempt's grant resolves an expectation nobody awaits.
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
  fully-acked segments are deleted by the host. Deletion-on-ack is also
  the retention rule — the log is scrollback, and the host MUST NOT
  retain acked history beyond the current segment
  ([Scrollback hygiene](#scrollback-hygiene)).

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
  F8). The host deletes the session dir ~500 ms after close, and removes
  sessions in a terminal state whose client has been silent past the stale
  grace window (60 s) — on adoption and continuously while running
  ([Scrollback hygiene](#scrollback-hygiene)).
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

Every spawn spec MAY additionally carry `workspace` — a registry *name*, not
a path, resolved host-side under [Hub deployment](#hub-deployment). A host
that cannot resolve the name MUST fail the spawn with `1006`, including the
one-folder host (a registry of one: the shared directory, under whatever name
that host advertises). Silently substituting a different subject for the one
the client named is the one behavior a workspace parameter MUST NOT have.

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

## Hub deployment

Everything above describes one shared directory with two peers. The **hub**
model ([D19](DECISIONS.md#d19--the-hub-pivot-one-transport-folder-as-a-socket-workspaces-as-resources))
keeps that transport byte for byte and changes only who owns the directory
and what a directory *means*: a long-lived daemon (`fsiod`,
[#71](https://github.com/dglazkov/fsio/issues/71)) owns one well-known
directory (working name `~/fsio`), a page grants that directory once per
origin ever
([F20](FINDINGS.md#f20--a-persisted-handle-with-allow-on-every-visit-spans-browser-restarts-revisit-is-zero-gesture)),
and the folders people actually work on stop being transport media and become
session *parameters*.

These rules are **additive and optional**. A one-folder host with no daemon,
no registry, and no consent server remains fully conformant — the hub is that
case generalized, not a replacement for it — and clients MUST feature-detect
hub facilities through the [service directory](#service-directory) rather
than assume them. `protocol` stays `0`: nothing here changes a frame, a file
name, or a byte on disk
([D25](DECISIONS.md#d25--capabilities-are-feature-detected-names-protocol-is-the-on-disk-version)).

### The hub folder is transport and advertisement only

[D20](DECISIONS.md#d20--the-hub-folder-carries-transport-and-advertisement-authority-lives-outside-it).
A granted origin holds readwrite on the *whole* hub directory — Chrome grants
folders, not subtrees — so every file in it is readable and writable by every
granted origin, and by every local process running as the user. The layout
above is therefore unchanged, and:

- **No per-origin namespacing.** Session and client ids stay client-minted
  and globally unique (`s-`/`c-` + timestamp + random), and sessions from
  different origins interleave in one `sessions/`. F21 measured that grants
  on one directory are independent per (origin, folder) and that concurrent
  writers do not interfere, so subdirectories buy no correctness — and they
  would confine nothing, since a co-tenant handle reaches the whole tree.
- **Nothing inside the hub may be a security or safety mechanism.** Anything
  a co-tenant page can forge or delete cannot be one. Authoritative state —
  the workspace registry, grant records, profiles, the daemon's exclusion
  lock — MUST live outside the granted directory, in daemon-private state.
- **Secrets MUST NOT transit the hub folder.** Not grant secrets, not tokens,
  not environment carrying credentials. A file in the hub is a broadcast to
  every tenant.
- **Co-tenancy is a trust decision, and it is made at the grant.** One
  origin's session dirs — including full scrollback in `out.*.log` — are
  readable by every other granted origin. The isolation unit is the folder,
  because that is the unit Chrome enforces: a user who needs two origins
  isolated gives them two hub folders. A daemon MUST be able to show which
  origins hold grants (the grants/audit view,
  [#46](https://github.com/dglazkov/fsio/issues/46)), so co-tenancy is at
  least legible.

### Daemon singleton

[D21](DECISIONS.md#d21--the-daemon-is-a-singleton-enforced-by-an-os-lock-the-heartbeat-stays-advisory).
Exactly one daemon MAY serve a hub directory at a time, enforced by an
OS-level exclusive lock (`flock`-class) held for the process lifetime and
keyed by the hub's absolute path, in daemon-private state. A daemon that
cannot take the lock MUST exit non-zero without touching the hub — under a
supervisor (launchd) that is the whole mechanism, since the survivor already
holds it.

`host.json`'s heartbeat keeps its meaning for *clients* (liveness =
mtime younger than 6 s) but MUST NOT be the exclusion mechanism in hub mode:
it is a file in the hub, so a co-tenant could delete it and a stale one could
be mistaken for a corpse. The one-folder rule stands unchanged for one-folder
hosts ([#40](https://github.com/dglazkov/fsio/issues/40); a
launched-per-folder host has no daemon-private state to lock and no
supervisor to lose the race to).

### Workspaces are session parameters

[D22](DECISIONS.md#d22--workspaces-are-session-parameters-resolved-by-a-daemon-private-registry).
`workspace` names an entry in a daemon-private registry (`fsio share .`); the
host resolves it to an absolute path. **Paths never appear on the wire.** The
page cannot supply one (D19's decisive wall: a picked handle has no path) and
the host MUST NOT disclose one — the hub is co-tenant-readable, and a path
leaks the user's home directory and project layout.

- A process-spawning kind MUST name a workspace when the host serves more
  than one; unresolvable names, names the client may not see, and omission
  where a name is required all get `1006` — the host never picks a subject
  on the client's behalf. `cwd` is resolved *relative to the workspace root*
  and MUST NOT escape it: a `cwd` that resolves outside is `-32602`
  (invalid params — the subject was named and understood, the location
  inside it was not), and the check MUST survive symlinks, which means
  comparing resolved real paths and not just strings.
- Resolution happens **before the policy hook**, like the unknown-kind
  check: a request whose subject the host cannot resolve is not a request a
  [D12](DECISIONS.md#d12--spawn-policy-is-a-host-side-hook-confirmation-is-an-async-policy)
  policy can meaningfully judge. A refusal MUST NOT enumerate the
  workspaces the client did not name (advertisable names are what
  `services.json` is for) and MUST NOT contain a path.
- A registry entry is a **naming record** — name, path, label — and carries
  no reach
  ([D27](DECISIONS.md#d27--reach-attaches-to-the-grant-not-the-workspace)).
  The profile — spawn allow-list, sandbox template, env policy
  ([#46](https://github.com/dglazkov/fsio/issues/46)) — attaches to the
  named service, and authorization binds (principal × service × workspace)
  in the grant. The reach of a spawned child is the intersection of the
  service's profile and the grant's scope. Profile directories govern the
  *child process*; they are not browser permissions, which remain exactly
  the picked handle and nothing else.
- **Direct file access composes, it does not merge.** A page MAY hold its own
  FS Access grant on a workspace folder and read and write it directly, with
  fsio uninvolved (the zero-install rungs of
  [#74](https://github.com/dglazkov/fsio/issues/74)'s ladder). That grant and
  the hub grant are independent per (origin, folder) — F21 — so holding both
  costs exactly one extra gesture, ever. A host MUST NOT require workspaces
  to live inside the hub, and MUST NOT make direct file I/O route through
  sessions: the files-only mode and the hub mode use the same code path on
  the page side, which is what keeps the degenerate mode playable.

### Consent and grants

[D23](DECISIONS.md#d23--consent-is-host-served-and-grants-are-proof-of-possession-capabilities).
Two authorizations, deliberately not one: a **grant** is standing authority
("this origin may use these workspaces for this class of action"), minted by
a human at a host-served consent page and revocable; the
[D12](DECISIONS.md#d12--spawn-policy-is-a-host-side-hook-confirmation-is-an-async-policy)
policy is the per-request judgment ("this command, now"). Execution needs
both. Collapsing them in either direction is the failure mode
[#76](https://github.com/dglazkov/fsio/issues/76) exists to design against —
a grant broad enough to skip prompts, or prompts frequent enough to become
click-through.

1. A session that names a workspace or spawns a process MUST present a valid
   grant. Kinds confined to the hub itself (`echo` — the transport
   diagnostic) MAY be served ungranted.
2. **The host draws the consent pixels.** The requesting page MUST NOT be
   able to render, overlay, or style them; they name the origin, the
   workspace, and the reach in plain language.
3. **The request rides the folder, the answer does not have to.** The client
   writes `consent/<rid>.json` (one writer per file — D6 — like
   `attach.<aid>.json`); the host deletes it when answered. Writing the
   request needs no user gesture; the navigation to the consent endpoint MUST
   be user-initiated and MUST follow the host publishing that endpoint (F15:
   the gesture cannot be synthesized, so the flow must not race a transient
   activation).
4. **Grants are proof-of-possession, never bearer.** A bearer token in
   `spawn.json` is readable by every co-tenant origin, which is the hub's
   defining difference from the one-folder case. The secret MUST reach the
   requesting origin out of band of the folder, and each request MUST be
   bound to the session it authorizes, so a copied `spawn.json` cannot be
   re-aimed at a new session. Verification failure is `1007`.
5. **What lands in the folder is a receipt** — `{grantId, scope, expiry}`,
   no secret — for the page to observe with the watch machinery it already
   has. The authoritative record lives in daemon-private state; revocation
   deletes it there and MUST take effect at the next policy judgment, not at
   the next daemon restart.
6. **The consent server is consent-only.** Loopback bind, up only while a
   request is pending, URL carrying a per-boot unguessable nonce published in
   the hub (so only a folder-holder can construct it). HTTP carries consent
   and grant administration; **the folder remains the only data plane.**

**First visit and return.** The durable grant is minted at a deliberate
`requestPermission()` re-prompt over a restored handle, not at the picker —
picker grants die with the browser session (F21, F20 addendum). The
re-prompt belongs to the **return visit**
([D28](DECISIONS.md#d28--durable-grants-are-minted-on-return-not-first-run)):
a first visit ends session-scoped by design — pick, use, walk away, no
residue beyond the handle the origin persisted — and a flow MUST NOT
request durability before the origin has been revisited. The return
visit's *welcome back — make this permanent* re-prompt is where returning
has earned the ask. A flow that stops at the picker MUST NOT be described
to the user as installed.
[#69](https://github.com/dglazkov/fsio/issues/69) measures the two-visit
flow's ergonomics (including the post-revocation downgrade); the rules do
not wait on it.

**Unmeasured, and marked as such.** The reference transport for the consent
answer — a user-opened loopback tab that hands the secret to its opener via
`postMessage` with the requesting origin as `targetOrigin`, the browser again
being the enforcer — rests on two platform behaviors nobody has measured:
navigation to loopback from a public origin under Chrome's Local Network
Access tightening, and opener retention under default COOP. That is
[open question 10](#open-questions) →
[#79](https://github.com/dglazkov/fsio/issues/79). Rules 1–6 are
transport-independent and hold whatever that lab settles.

### Service directory

[D24](DECISIONS.md#d24--the-service-directory-is-the-origin-facing-capability-document).
`host.json` stays the hot, tiny heartbeat (rewritten every 2 s) and gains
`servicesRev`. The capability document is a separate host-owned file:

```
<hub>/.fsio/
  services.json             # host-owned capability document, temp+renamed
                            #   ONLY when its content changes:
                            #   {rev, protocol, capabilities: [name…],
                            #    kinds: [{name, needsGrant?, detail?}],
                            #    workspaces: [{name, label?}],   # names only
                            #    consent?: {url}}
  consent/
    <rid>.json              # client-written grant request; host deletes it
                            #   after answering (deletion = consumption)
    <rid>.receipt.json      # host-written outcome: {grantId, scope, expiry}
                            #   — never a secret (D20)
```

Same doorbell discipline as `out.sig`
([D3](DECISIONS.md#d3--rename-committed-doorbell-outsig)): the hot file
carries a revision counter, the cold file carries the state, so a client
already statting the heartbeat learns when to re-read the larger document
without diffing it. `kinds` is
[D13](DECISIONS.md#d13--session-kinds-are-a-host-side-registry-echo-is-just-an-entry)'s
registry surfaced to pages — the substrate the later bus slices
([#18](https://github.com/dglazkov/fsio/issues/18),
[#44](https://github.com/dglazkov/fsio/issues/44),
[#45](https://github.com/dglazkov/fsio/issues/45)) enumerate.

`services.json` is one file for all tenants, so it can advertise only what
every granted origin may see: workspace **names** the user marked
advertisable, never paths, never the full registry. A grant's own receipt
names the workspaces that grant covers — per-origin visibility is a property
of the grant, not of the directory. `host.json`'s `allowShell`/`pty` stay for
one-folder compatibility; hub clients read `capabilities`.

Publishing rules:

- A host that publishes the document MUST mirror its `rev` into every
  `host.json` beat as `servicesRev`, and MUST write the document before the
  first beat that names it — a doorbell MUST NOT point at a document that is
  not there.
- `rev` MUST increment on every content change and MUST NOT move otherwise;
  a beat, and a restart that changes nothing, are not content changes.
  A host that finds a higher `rev` already on disk MUST carry it forward
  rather than rewind it: the document is co-tenant-writable (D20), clients
  compare revisions rather than contents, and a rewind would strand a cached
  copy. A host MAY leave the document in place when it stops (absence of the
  heartbeat already reads as host-gone) — one-folder hosts and hubs alike.
- The document is not a security mechanism (D20): it is advertisement, and
  every claim in it is re-judged at spawn time by resolution (D22) and the
  policy hook (D12).
- A `kinds` entry MAY carry `detail`, a JSON object the embedder supplies
  and the host transcribes verbatim
  ([D31](DECISIONS.md#d31--a-kind-may-carry-embedder-detail-transcribed-never-interpreted-detected-by-presence)).
  A host MUST NOT interpret it, MUST drop a `detail` that is not a JSON
  object and one naming a kind it does not serve, and MUST move `rev` when
  it changes. Its keys are a contract between one embedder and its own
  client, so a client MUST detect it by **presence** and MUST read an absent
  or unrecognized `detail` as "this host says nothing" rather than as an
  error. It is subject to every rule above, the privacy line included: one
  file serves every granted origin, so `detail` carries no paths and no
  secrets. The `/acp` demo's agent roster is the first consumer
  ([#102](https://github.com/dglazkov/fsio/issues/102)).

**The initial capability names.** Stable and never reused
([D25](DECISIONS.md#d25--capabilities-are-feature-detected-names-protocol-is-the-on-disk-version));
[#8](https://github.com/dglazkov/fsio/issues/8) keeps the job of growing the
list as facilities land.

| name | the host serves |
|---|---|
| `shell` | `kind: "shell"` may be *requested* — the D12 policy still judges each one, and a grant may still be required (`kinds[].needsGrant`) |
| `pty` | shell sessions get a real pty rather than the pipe fallback ([D14](DECISIONS.md#d14--host-embedder-surface-introspection-leveled-log-lines-awaited-close-injected-pty)) |
| `attach` | `attach`: takeover with writer epochs and head-segment replay ([D18](DECISIONS.md#d18--attach-is-takeover-writer-epochs-fence-the-old-client)) |
| `workspaces` | `workspace` names resolve to roots this host serves ([D22](DECISIONS.md#d22--workspaces-are-session-parameters-resolved-by-a-daemon-private-registry)) |

A host MUST advertise a name only while the facility behind it works —
`shell` is absent from a host that refuses shells outright, `workspaces`
from one that resolves no names — and a client MUST read an absent or
unknown name as "not supported", never as an error.

### Version and capability handshake

[D25](DECISIONS.md#d25--capabilities-are-feature-detected-names-protocol-is-the-on-disk-version).
An installed daemon meets pages of every vintage and neither side can be
upgraded on the other's schedule, so skew is permanent, not a migration
([#8](https://github.com/dglazkov/fsio/issues/8)).

- `protocol` is the **on-disk** version: frames, file names, layout. It
  increments only on a change that would make an older peer misread bytes.
  Everything else is a named capability in `services.json`.
- Unknown JSON fields MUST be ignored, in both directions and every file.
  Unknown capability names MUST NOT be fatal.
- Clients MUST feature-detect by capability name and MUST NOT gate behavior
  on a `protocol` range where a name would do.
- Capability names are stable and never reused, the same discipline as F and
  D numbers: a capability that is withdrawn leaves its name burned.
- A peer that reads a `protocol` higher than it implements MUST NOT create
  sessions; it SHOULD surface an upgrade path. A daemon MUST leave session
  directories it cannot parse alone (age-based GC only, D6) — a future
  client's session is not garbage.

## Threat model

What holding the shared folder *is*, and against whom the design does and
does not defend
([#81](https://github.com/dglazkov/fsio/issues/81), the posture half of
[#6](https://github.com/dglazkov/fsio/issues/6)). Enforcement lives in the
decisions this chapter cites; the chapter's job is to trace every rule with
a security consequence to a named adversary — and to write down what is
*not* defended, so it is stated rather than discovered.

### The capability: what holding the folder is

Write access to the shared directory — a browser grant or plain POSIX
access — is one capability with three legs:

- **Transport.** The holder mints sessions and, past the
  [D12](DECISIONS.md#d12--spawn-policy-is-a-host-side-hook-confirmation-is-an-async-policy)
  policy, runs what policy allows.
- **Readback.** Every out segment is readable: full scrollback, everything
  typed or echoed into the terminal, secrets included, for as long as
  segments are retained ([Scrollback hygiene](#scrollback-hygiene) bounds
  that window).
- **Adoption.** Attach is takeover
  ([D18](DECISIONS.md#d18--attach-is-takeover-writer-epochs-fence-the-old-client)),
  so the capability includes adopting a *live, already-approved* session —
  live stdin control of a running shell, not just readback. Attach re-runs
  the spawn policy with the attacher's identity, and the takeover is
  observable: the fenced client sees `writer: {epoch, aid}` in
  `status.json` and can alarm. Silent hijack therefore requires the victim
  tab to be gone.

Under the hub
([D19](DECISIONS.md#d19--the-hub-pivot-one-transport-folder-as-a-socket-workspaces-as-resources),
[D20](DECISIONS.md#d20--the-hub-folder-carries-transport-and-advertisement-authority-lives-outside-it))
the same capability is **multi-tenant**: every granted origin holds all
three legs over every other origin's sessions, and any file in the folder
is forgeable by any of them. The isolation unit is the folder, because that
is the unit Chrome enforces; isolation means a second hub, and co-tenancy
is a trust decision made at the grant — which is why the hub chapter
requires it stay legible (the grants/audit view, D20,
[#46](https://github.com/dglazkov/fsio/issues/46)).

### Threat shapes

Four adversaries, kept distinct: they hold different capabilities, have
different identity anchors, and get different answers.

**1. A malicious granted origin.** The shape most of the machinery was
built against. A granted page can mint sessions, write any file in the
folder, and claim any identity — `origin` is client-stamped and
unauthenticated
([D15](DECISIONS.md#d15--origin-is-client-stamped-advisory-and-display-only)).
The defenses compose: nothing inside the folder is authoritative, so
forging files captures no authority and no secrets (D20); execution
requires a grant the page can only obtain from a human at host-drawn
pixels, proof-of-possession and session-bound so a copied `spawn.json` is
inert
([D23](DECISIONS.md#d23--consent-is-host-served-and-grants-are-proof-of-possession-capabilities));
every spawn *and attach* is judged by the D12 policy; and what an allowed
command can reach is bounded by the child sandbox and the profile of the
service the grant names
([D27](DECISIONS.md#d27--reach-attaches-to-the-grant-not-the-workspace)).
Revocation is two-sided and independent: the browser grant (per-origin, in
browser settings —
[F21](FINDINGS.md#f21--two-origins-hold-independent-grants-on-one-directory-the-broker-splits-throughput-fairly-the-durable-grant-is-minted-at-the-re-prompt-not-the-picker))
and the host grant (deleted daemon-side, effective at the next policy
judgment).

**2. A malicious local binary.** A process already running as the user.
**The protocol does not defend against it, and does not claim to**: it
holds everything the folder grants and more — daemon-private state, the
host process itself, every workspace, the browser profile storing the
handles. The sandbox story (Seatbelt profiles, D22) is about *spawned
children* — bounding the blast radius of a command the user approved — not
about hostile peers. Defense against already-running local malware is the
operating system's job, and a design that claimed it here would be
theater.

**3. Delegated prompting.** Another person's prompt driving your agent
with your local capabilities through your open tab — the shape any
cloud layer built above this transport takes, stated here because the
transport's boundary is what it tests: a confused deputy,
with the twist that the driver may themselves be relaying injected content
they did not author. The transport can never authenticate this principal —
D15's rationale: nothing in a filesystem to anchor trust to — but the
cloud layer that introduces the threat also supplies the anchor: real
authenticated principals from *outside* the transport, so consent prompts
can name a person, not an origin ("Alice wants to run `npm test` in
workspace X"). The mitigation surface is the existing spine with a person
dimension added: per-person × per-workspace × shape grants
([#76](https://github.com/dglazkov/fsio/issues/76)), with prompts rendered
in the owner's tab — where the owner is.

**4. Agent spawn cadence.** A threat shape with no attacker: an agent
chatty enough that per-command consent becomes prompt fatigue, and fatigue
decays granular control into click-through theater
([#76](https://github.com/dglazkov/fsio/issues/76)). The failure lands in
the human, which is what makes it a threat shape rather than a UX
footnote — every defense above that ends in "a human judges the prompt"
inherits it. D23's two-authorization split is the frame (standing grant
vs. per-request judgment), and shape-scoped grants — between per-command
prompts and allow-all — are the designed middle ground.

### Two lines users will otherwise misread

- **Anything in the folder is a broadcast.** Every tenant — granted
  origins and local processes alike — reads every file. That one rule
  generates D20's containment (authority and secrets live outside the
  granted directory) and D23's grant shape (proof-of-possession, never
  bearer; what lands in the folder is a secret-free receipt). There is no
  partial version: a secret that transits the folder is disclosed to every
  present and future tenant of it.
- **Profile directories are not browser permissions.** The browser's reach
  is exactly the picked handle, full stop; nothing the host or a profile
  does widens or narrows it. Profile directories govern the *spawned
  child's* sandbox reach (D22). A consent UI that blurs this teaches users
  that grants scope the browser, and they do not.

### $HOME carve-outs are delayed sandbox escapes

A child sandbox that walls off `$HOME` generates pressure to carve
exceptions for shell conveniences — history, completion caches, session
restore. The carve-outs are the escape: `~/.zsh_history` is *replayed* by
real shells, and `~/.zcompdump` is *sourced* by future ones — a write
inside the sandbox becomes execution outside it, later. The measured
posture (the terminal demo's profile,
[#32](https://github.com/dglazkov/fsio/issues/32)): fix the friction in
the child's environment (`SHELL_SESSIONS_DISABLE=1`, `HISTFILE` redirected
into the workspace), never by widening the write wall. Profiles SHOULD
treat any `$HOME` path that a future unsandboxed process reads or executes
as non-carvable.

### What the child sandbox does not bound

The child sandbox is a **write** wall, and its measured shape is narrower
than the sentence "sandboxed to this folder" implies
([F24](FINDINGS.md#f24--the-wall-is-a-write-wall-a-confined-child-inherits-the-hosts-entire-environment-ssh-agent-socket-included-and-reads-every-file-the-user-can-read),
`scripts/confinement-lab.mjs`). Under the shipped posture a confined child
still holds: the host's **entire environment** (47 of 48 variables,
including every exported credential and `SSH_AUTH_SOCK` — agent forwarding
is a signing capability, not a setting); **read access to every file the
user can read** — private keys, `~/.gitconfig`, every sibling project — and
**network egress**, which the demo allows deliberately. Read reach is
therefore exfiltration reach.

Two consequences are normative for consent surfaces:

- A consent surface MUST NOT describe child confinement in terms broader
  than modification. "Writes are limited to this folder; this program can
  still read your files and reach the network" is the honest sentence; "the
  shell is sandboxed" is not.
- What the sandbox *does* hold is worth stating too, because it is stronger
  than usually assumed
  ([F23](FINDINGS.md#f23--child-confinement-is-transitive-to-any-depth-and-cannot-be-re-entered-in-either-direction-setuid-binaries-become-unexecutable),
  [D29](DECISIONS.md#d29--profiles-compose-before-the-spawn-confinement-is-inherited-and-cannot-be-re-entered)):
  the write wall is inherited by every descendant at any depth, survives
  detachment, cannot be widened from inside, and is not escapable by asking
  launchd to spawn on the child's behalf. Setuid binaries (`sudo`, `ps`,
  `crontab`) simply do not execute — a closed escalation route whose cost
  is ordinary usability, not security.

Narrowing the read wall or the environment is
[#71](https://github.com/dglazkov/fsio/issues/71)'s profile-content slice,
designed in [#86](https://github.com/dglazkov/fsio/issues/86); what a read
wall *costs* a real toolchain is unmeasured.

### Accepted and out of scope

Stated so they are read, not discovered:

- **Co-tenant scrollback reads** are accepted (D20): granted origins share
  one hub, and the folder cannot hide files from its own tenants. The
  mitigation is hygiene, not access control — retention bounded to the
  replay window, terminal sessions swept
  ([Scrollback hygiene](#scrollback-hygiene)).
- **`origin` absent a grant** authenticates nothing (D15): display
  material only; any folder writer can claim any origin. A D23 grant is
  what makes an origin claim checkable.
- **Local processes** (shape 2 above): everything in this chapter assumes
  the local machine is not already hostile.

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
`origin` is unauthenticated by design.
[D23](DECISIONS.md#d23--consent-is-host-served-and-grants-are-proof-of-possession-capabilities)
closes the design gap — a grant is what makes an origin claim checkable,
and profiles carry the allow-list and env-policy content, bound per
(principal × service × workspace)
([D27](DECISIONS.md#d27--reach-attaches-to-the-grant-not-the-workspace))
— but nothing ships it yet
([#71](https://github.com/dglazkov/fsio/issues/71)). The
[threat model](#threat-model) above names the adversaries these mechanisms
answer; [scrollback hygiene](#scrollback-hygiene) below bounds what a
session leaves behind.

[Hub deployment](#hub-deployment) raises the stakes rather than the posture:
a daemon serving every registered workspace concentrates blast radius, and
one hub folder is multi-tenant by construction — co-tenant origins read each
other's scrollback, and any file in the folder is forgeable by all of them.
D20's containment (authority and secrets outside the granted directory) and
D23's two-authorization split are the mechanism half; the
[threat model](#threat-model) is the map. The shipped policy content
([#71](https://github.com/dglazkov/fsio/issues/71)) remains open under
[#6](https://github.com/dglazkov/fsio/issues/6)'s umbrella, and no hub
facility should ship ahead of it.

### Scrollback hygiene

[D26](DECISIONS.md#d26--scrollback-hygiene-retention--the-replay-window-terminal-sessions-are-swept-fsio-is-git-ignored)
([#82](https://github.com/dglazkov/fsio/issues/82)). The out log is full
scrollback — everything typed or echoed, secrets included — and under the
hub it is co-tenant-readable ([D20](DECISIONS.md#d20--the-hub-folder-carries-transport-and-advertisement-authority-lives-outside-it)).
Three rules bound its life:

1. **Retention is the replay window.** The host MUST delete fully-acked
   non-current segments (the
   [D9](DECISIONS.md#d9--segmented-log-with-cumulative-ack-flow-control)
   mechanism already does), so the bytes on disk are exactly the current
   segment plus unacked backlog — what delivery and
   [D18](DECISIONS.md#d18--attach-is-takeover-writer-epochs-fence-the-old-client)'s
   head-segment replay need, nothing more. If replay is ever extended to
   all retained segments
   ([#57](https://github.com/dglazkov/fsio/issues/57)), it MUST serve what
   retention already keeps, never widen what retention keeps: replay
   window = retention window, and the arrow points from retention to
   replay.
2. **Terminal sessions do not linger.** Clean close already deletes the
   session dir (~500 ms). A session in a terminal state — exited or
   error — whose client has been silent past the stale grace window
   (60 s) MUST be removed, at adoption *and* continuously while the host
   runs: a crashed tab must not leave scrollback on disk for the life of
   the host. Detached running sessions are exempt — their scrollback *is*
   the [D17](DECISIONS.md#d17--client-heartbeats-opt-in-detached-marking-instead-of-kill)/D18
   reattach promise. Removal is unlink-level, not anti-forensic: the
   adversary is the folder's readers ([threat model](#threat-model)), not
   disk forensics.
3. **Version control never sees `.fsio/`.** A host serving a shared
   directory that lies inside a git repository SHOULD ensure `.fsio/` is
   ignored — the reference host appends it to the shared directory's own
   `.gitignore` at start, once — and MUST warn loudly when it cannot.
   The sharp case is the one-folder mode, where `.fsio/` sits inside the
   user's project; a hub folder is daemon-owned and outside any repo by
   construction ([D19](DECISIONS.md#d19--the-hub-pivot-one-transport-folder-as-a-socket-workspaces-as-resources)).

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
10. **Consent-flow transport.** [D23](DECISIONS.md#d23--consent-is-host-served-and-grants-are-proof-of-possession-capabilities)'s
    requirements are transport-independent, but its reference mechanism rests
    on two unmeasured platform behaviors: top-level navigation to loopback
    from a public origin under Chrome's Local Network Access tightening, and
    cross-origin `opener` retention (default COOP) for the `postMessage` that
    delivers the grant secret out of band of the folder. Labs before code:
    nothing in [#71](https://github.com/dglazkov/fsio/issues/71) should
    implement the answer channel until this settles.
    → [#79](https://github.com/dglazkov/fsio/issues/79)
