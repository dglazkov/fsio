# fsio decisions — why the protocol is shaped this way

ADR-lite, append-only. Each entry records a decision, its context, the
alternatives rejected, and the findings that forced it. Numbers (D1, D2, …)
are stable and never reused; superseded decisions get a note, not an edit.

Companions: [PROTOCOL.md](PROTOCOL.md) (the normative spec),
[FINDINGS.md](FINDINGS.md) (measured platform behaviors, F1–F15).

## D1 — events are wakeups, not messages

**Decision.** Watch/observer events carry no meaning. On any wakeup a peer
runs a full, idempotent scan; a slow safety poll (250–500 ms) backstops
missed events. All meaning lives in file *contents and names*, so the
protocol works identically under pure polling.

**Context.** Every event source we measured coalesces, delays, or gaps:
held-fd appends produce almost no events at all
([F1](FINDINGS.md#f1--held-fd-appends-are-invisible-to-watchers)), libuv
quantizes to 50 ms
([F2](FINDINGS.md#f2--node-fswatch-adds-50-ms)), and Chrome's observer
batches on a ~300 ms timer and can gap for seconds
([F6](FINDINGS.md#f6--chromes-filesystemobserver-delivers-on-a-fixed-300-ms-cadence)).

**Alternatives rejected.** Treating events as a reliable delivery channel
(interpreting *which* path changed, counting events): breaks under
coalescing and duplication on every platform tested.

**Findings.** F1, F2, F6, F9.

## D2 — asymmetric transport: append-only log down, atomic chunks up

**Decision.** Host → client is an append-only framed log the client reads
from a byte offset. Client → host is a sequence of numbered chunk files,
each committed atomically.

**Context.** The runtimes are asymmetric. POSIX appends are cheap and the
host has them; the browser cannot cheaply append —
`FileSystemWritableFileStream` rewrites the whole file via a swap file and
commits on `close()`, which is exactly an atomic commit, so the uplink
leans on it. Native clients emulate the same atomicity with
write-temp-then-rename.

**Alternatives rejected.** Symmetric chunk files both ways (host-side
churn for no benefit; the log is naturally multi-reader). Symmetric
append logs both ways (the browser can't append; every "append" would
rewrite the whole file).

**Findings.** F7 (the cost of the browser's commit path).

## D3 — rename-committed doorbell (`out.sig`)

**Decision.** After every log append the host rewrites `out.sig` via
temp+rename. The file is both doorbell (renames generate immediate,
reliable watcher events) and stream map (locates the write head across
segments).

**Context.** Appends through a held fd are nearly invisible to watchers
([F1](FINDINGS.md#f1--held-fd-appends-are-invisible-to-watchers));
open/append/close per write helps, but renames are the only mutation that
reliably woke every watcher tested.

**Alternatives rejected.** Relying on append events (invisible, F1).
Touching a sentinel file's mtime (mtime-only changes coalesce too).

**Findings.** F1.

## D4 — hybrid / adaptive notification

**Decision.** Peers combine event sources with polling: watch/observer for
idle efficiency, a ~5 ms hot poll while a session is active. Browser
clients go further (*adaptive*): observer as idle sentinel, hot poll only
while traffic flowed in the last 2 s. A safety poll is mandatory in every
mode.

**Context.** Wakeup strategy, not the filesystem, is the entire latency
budget ([F2](FINDINGS.md#f2--node-fswatch-adds-50-ms)): fs.watch floors at
~50 ms, Chrome's observer at ~300 ms with multi-second gaps
([F6](FINDINGS.md#f6--chromes-filesystemobserver-delivers-on-a-fixed-300-ms-cadence)),
while 5 ms polling hits p50 5.5 ms RTT with zero idle cost when gated on
activity ([F3](FINDINGS.md#f3--hybrid-notifier-wins)).

**Alternatives rejected.** Pure events (50 ms / 300 ms floors blow the
terminal budget). Pure always-on polling (constant background cost while
idle). Tuning event sources (libuv's 50 ms and Chrome's 300 ms are not
configurable from user code).

**Findings.** F2, F3, F6.

## D5 — dirname fast lane for small uplink batches

**Decision.** Uplink frame batches ≤180 raw bytes are encoded into a
created directory's *name* (base64url) instead of a file's contents.
Larger batches take file chunks. Both lanes share one sequence space.

**Context.** The browser's file commit costs ~68 ms, all of it in
`close()` — Chrome's after-write scan — and cannot be polled away
([F7](FINDINGS.md#f7--browser-chunk-commit-costs-68-ms-and-it-is-entirely-close)).
Directory creation skips the scan: p50 uplink drops 69 ms → 2.8 ms
([F10](FINDINGS.md#f10--the-dirname-fast-lane-works-53-ms-rtt-from-the-browser)).
Keystrokes, control frames, and acks fit the name budget; pastes and
uploads don't need the latency.

**Alternatives rejected.** Accepting the 70 ms uplink (worse than SSH over
Wi-Fi). Local-echo masking only (hides but doesn't fix latency; still on
the table for bulk file-chunk traffic). Known risk: Chrome could start
scanning or throttling high-rate directory creation; name-length limits
differ on other filesystems.

**Findings.** F7, F10.

## D6 — one writer per file, one cleanup owner

**Decision.** Every file in the protocol has exactly one writer, and
session cleanup has exactly one owner: the host. Client `close()` sends
CTL `close` and stops watching; the host deletes the session directory and
GCs stale sessions.

**Context.** Browser-side recursive deletion raced host writes (doorbell
renames, status.json) and failed with `InvalidModificationError`
([F8](FINDINGS.md#f8--peers-must-not-contend-for-the-same-files)). The
host has POSIX semantics (atomic rename, unlink-while-open), so it gets
cleanup.

**Alternatives rejected.** Client-owned cleanup (races host writes, F8).
Shared files with locking (no usable cross-runtime file locks in the File
System Access API).

**Findings.** F8.

## D7 — observer failure downgrades to polling

**Decision.** Observer/watch startup failure MUST downgrade the peer to
polling; it is never fatal.

**Context.** Chrome's `observe()` fails with `InvalidModificationError`
for directories under `/tmp` on macOS (the `/tmp → /private/tmp` symlink,
[F9](FINDINGS.md#f9--observe-refuses-on-directories-under-tmp-macos)).
Since D1 guarantees the protocol works under pure polling, degradation is
free.

**Alternatives rejected.** Treating observer failure as an error (breaks
on legitimate directories for platform-specific reasons).

**Findings.** F9. Depends on D1.

## D8 — snapshot-read failures are transient

**Decision.** Readers MUST treat a failed snapshot read (`getFile()` →
`NotReadableError`) as transient: the offset hasn't advanced, the next
wakeup re-reads. Never fatal, never skip.

**Context.** Chrome invalidates a `File` snapshot if the underlying file
changes between `getFile()` and the read. Under interactive pty output
this is routine ([F11](FINDINGS.md#f11--getfile-snapshots-go-stale-under-live-writes)).

**Alternatives rejected.** Locking out.log during reads (no cross-runtime
mechanism; would stall the pty). Treating the error as corruption (it
isn't — the log is append-only, the offset is still valid).

**Findings.** F11.

## D9 — segmented log with cumulative-ack flow control

**Decision.** The downlink log is segmented (~8 MB, rotated on frame
boundaries). The client acks cumulative consumed bytes (CTL `ack` on the
dirname lane, throttled). The host pauses the pty above 4 MB unacked,
resumes below 2 MB, and deletes fully-acked segments.

**Context.** A `find .` produced a 60 MB out.log with nothing slowing the
pty ([F12](FINDINGS.md#f12--ack-window-flow-control-works-over-files)).
The fix delivered a 32 MB flood losslessly while disk peaked at 8 MB.

**Alternatives rejected.** Unbounded log (the 60 MB incident; browser
re-reads get slower as the file grows). Truncating in place (breaks the
reader's byte offsets and the one-writer/one-reader offset contract).
Ring buffer in one file (in-place rewrites are invisible to watchers, F1,
and race snapshot reads, F11).

**Findings.** F12; interacts with F1, F11. Settles
[PROTOCOL.md open question 1](PROTOCOL.md#open-questions).

## D10 — JSON-RPC 2.0 control plane over RPC frames

**Decision.** All control messaging is JSON-RPC 2.0, one message per RPC
frame (type 5): `ping` as a request with `id` correlation; `resize`,
`signal`, `eof`, `close`, `ack` as notifications; `spawn` as a request
whose envelope rides `spawn.json` (the file is the bootstrap transport)
and whose response — result or error object with a code — rides the out
stream. DATA stays raw bytes in DATA frames. Frame types 2–4 (PING/PONG/
CTL) are retired and reserved.

**Context.** The ad-hoc control plane had grown implicit conventions about
direction, correlation, and errors: the seq/pending-map idiom was
hand-rolled three separate times (web bench, node bench, observer lab),
and a failed spawn was a `status.json` state the client had to poll for
and interpret. Upcoming work wants standard request/response semantics:
the reattach handshake (#3), capability negotiation (#8), and the
TypeScript schema freeze (#2) — this decision *is* the shape of the
versioned contract. Envelope cost measured: ~30–40 B per message; every
v0 control message fits the 180 B dirname-lane budget with ≥ 70 B to
spare (`ping` 81 B framed, `ack` 65 B, `resize` 72 B, `close` 39 B), so
the fast lane is unaffected. Bench confirmation: node-client p50 5.46 ms
RTT post-migration vs. 5.53 ms before — envelope cost is invisible at
stdio scale (consistent with F4).

**Alternatives rejected.** Status quo ad-hoc `{op}` messages (correlation
and error handling reinvented per message and per client). A custom
minimal envelope (saves ~20 B over JSON-RPC but loses the standard error
model and every existing tool/library that speaks JSON-RPC). JSON-RPC
batch arrays (the frame/chunk layer already batches; a second batching
layer complicates parsing for zero benefit — banned in the spec). Routing
DATA through JSON-RPC (terminal throughput through base64'd JSON would be
silly; layering keeps bytes raw and the control plane out of the hot
path).

**Findings.** None directly; the envelope budget leans on F10 (dirname
lane) and the latency neutrality on F4. Settles issue
[#14](https://github.com/dglazkov/fsio/issues/14); feeds #2 and #8.

## D11 — client library surface: events, synchronous construction, structural FS types

**Decision.** `@fsio/client`'s public surface (extracted from the workbench,
[#17](https://github.com/dglazkov/fsio/issues/17) slice 2):

1. **Events over constructor callbacks.** `session.on(type, listener)`
   returns the unsubscribe function; event types are `frame` (every
   delivered frame), `data` (DATA payloads — the one obvious way to consume
   output), `status`, `note`, `error`. RPC responses are consumed by the
   control plane and never surface as events. `close()` drops all
   listeners. Listener exceptions are isolated: they route to the `error`
   event (and to a fresh stack if unobserved) instead of unwinding the
   drain loop — a throwing consumer can no longer lose the rest of a
   segment's frames, which the old `onFrame` callback silently could.
2. **`createSession()` is synchronous.** Construction performs no I/O; all
   init failures (session-dir creation, spawn.json commit) reject
   `session.ready`. This makes the listener-attachment race unrepresentable:
   no event can fire before the caller's synchronous window closes. (The
   race was real: the D7 observer-refusal `note` fired *during* the old
   async `createSession`, before any caller could have subscribed.)
3. **The FS dependency is a structural type** (`FsDirectory`/`FsFile`/
   `FsSnapshot`/`FsWritable` — the exact subset of the File System Access
   API the client uses). Real `FileSystemDirectoryHandle`s satisfy it
   as-is; so does a Node shim over real `fs`, which is what makes the
   client testable per push (TESTING.md B1). Internals are ES `#private`
   fields so the published `.d.ts` stays lib.dom-free.

**Context.** The pre-extraction client mixed three callback registration
styles (`onFrame`/`onError`/`onNote` in options, `onStatus` as a mutable
public field), exposed its reader state (`gen`, `offset`, `queue`…) as
public fields, and required `FrameType` filtering just to read terminal
output. [#17](https://github.com/dglazkov/fsio/issues/17) called for a
deliberate pass before [#8](https://github.com/dglazkov/fsio/issues/8)
freezes anything. Verified by the B1 conformance tier
(`packages/bench/src/test-client.ts`): 8 scenarios, real client against
real in-process host, ~0.5 s.

**Alternatives rejected.** DOM `EventTarget`/`CustomEvent` (wraps every
payload in `.detail`, drags lib.dom into the public types, and buys nothing
— no bubbling or composition applies here). Keeping constructor callbacks
(single-consumer; the workbench already wanted the terminal *and* the
reporter on one session). Async `createSession` with callbacks in options
(the only other race-free shape — but it welds subscription to
construction). A `dispose()`/`Symbol.dispose` object per subscription
(heavier than returning the unsubscriber; revisit if `using` becomes
idiomatic). Exposing the DOM handle types directly in the API (kills B1:
Node consumers would need lib.dom or casts).

**Findings.** F9/D7 motivated the race analysis in (2); F10 lane stats
stay observable via `session.stats` and `uplinkBacklog()` (the labs'
surface, [#4](https://github.com/dglazkov/fsio/issues/4)). Feeds #8 (this
is the surface a freeze would freeze) and #16 (the workbench now consumes
the library it demos).

## D12 — spawn policy is a host-side hook; confirmation is an async policy

**Decision.** Every spawn request — every kind — passes a policy before
anything starts. `HostServerOptions.onSpawnRequest(spec, info)` receives
the raw spec plus the *resolved* command (what would actually run: `cmd`
defaulted to `$SHELL`, cwd resolved, pty availability — one shared
resolver, so the judged command cannot drift from the executed one) and
returns allow/deny, optionally with a client-visible reason; hook denials
travel as JSON-RPC error `1004`. A promise-returning policy *is* the
confirmation mechanism: the spawn answer waits, and a pending session
gets no service (no pings answered, no DATA consumed — uplink chunks
queue until the verdict). Rules: validity precedes policy (unknown kinds
are `1003`, the hook is never consulted); a throwing policy denies —
fail-safe, never fail-open; `allowShell` remains as sugar for the static
default policy (legacy `1001` + message preserved); host.json advertises
shells as askable whenever a hook is present (clients should try and get
the policy's real answer, not self-censor). Restart re-adoption re-judges:
a confirmation hook will re-prompt for sessions that survived a host
restart — for a security gate, re-asking is the correct default.

**Context.** #17 slice 3, and the mechanism half of
[#6](https://github.com/dglazkov/fsio/issues/6)'s "command allow-list /
confirmation" and [#16](https://github.com/dglazkov/fsio/issues/16)'s
host-side confirmation (settles #17 open API question 7). The wire sees
only coded errors — policy content stays out of the protocol. Enforced by
five B1 scenarios in `packages/bench/src/test-client.ts` (real client,
real host: deny-with-reason reaches `ready`, async confirm delays it,
hook overrides the boolean, throw = deny, validity ordering).

**Alternatives rejected.** A `pending-approval` state in `status.json`
(schema growth; the unanswered spawn request already models the wait —
revisit only if #16's UX needs the wait to be *visible*). AND-ing the hook
with `allowShell` (two knobs answering one question; the hook is the
policy when present). Client-side policy (the client is the untrusted
party by definition). Sync-only hooks (kills confirmation — the entire
point is that a human can be in the loop). Serving the uplink while
pending (leaks echo/ping service to sessions that may be about to be
denied).

**Findings.** None measured; behavioral rules enforced by the B1 tier.
Feeds #6 (policy content), #16 (confirmation UX), #8 (freeze surface).
