# fsio decisions — why the protocol is shaped this way

ADR-lite, append-only. Each entry records a decision, its context, the
alternatives rejected, and the findings that forced it. Numbers (D1, D2, …)
are stable and never reused; superseded decisions get a note, not an edit.

Companions: [PROTOCOL.md](PROTOCOL.md) (the normative spec),
[FINDINGS.md](FINDINGS.md) (measured platform behaviors, F1–F12).

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
