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
idle efficiency, a hot poll while a session is active (default cadence
settled in [D16](#d16--default-pollms-is-15-ms-half-the-burn-still-under-one-frame)). Browser
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

**Measured cost (2026-07-29,
[F17](FINDINGS.md#f17--the-5-ms-hot-poll-costs-52-of-a-core-across-three-processes-the-fsa-brokering-burn-lands-in-the-browser-process)).**
The hot poll's active-state burn is ~38% browser-process + ~13.5%
renderer CPU while a stream flows (observer-only: ~4.5% + 1.9% at
~350 ms latency). The gated idle state measures ≈ **0.75% of a core per
session** browser-side, linear to ×8, plus ~2–5% native in the host —
small, not zero
([F18](FINDINGS.md#f18--idle-sessions-cost-075session-in-chrome-linear-to-8-and-more-in-the-host-the-pollms-curve-the-wake-loop-self-saturates-at-pollms--wake-duration)).
F18's sweep also bounds the knob: RTT p50 ≈ pollMs, 15 ms halves the
streaming burn, and the wake loop self-saturates when pollMs falls
below the wake duration (~4 ms here) — on slower machines the RTT floor
is the wake duration, not the configured poll. The observer
sentinel also turns out to be the background-tab survival mechanism:
Chrome does not throttle FileSystemObserver in hidden tabs
([F16](FINDINGS.md#f16--filesystemobserver-is-not-throttled-in-hidden-tabs-adaptive-mode-degrades-to-observer-cadence-in-the-background-and-recovers-instantly)),
so backgrounded adaptive degrades to observer cadence instead of
stalling.

**Findings.** F2, F3, F6, F16, F17, F18.

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

## D13 — session kinds are a host-side registry; echo is just an entry

**Decision.** `host.registerKind(name, handler)`: the handler runs once
per allowed spawn (after the D12 policy) and returns the session's
behavior — `{result?, onData?, methods?, onClose?}` plus a context with
`write()`/`exit()`. A kind is a set of RPC methods plus a DATA
sink/source — the unit D10 made natural. Rules: `ack`/`close` are
host-reserved and never dispatched to kinds; methods a kind doesn't
define fall through to the builtins (`ping` answers on every kind — it's
the transport diagnostic), then `-32601`; a throwing handler fails the
spawn (`1002`); `exit()` publishes the exited status and stops delivery,
but the client's `close` still drains (cleanup stays host-owned, D6).
"Unknown kind" now means "not in this host's registry" — still `1003`,
still checked before the policy runs. **echo migrated to the registry**
(the trivial `() => ({})` handler), so the mechanism is exercised by
every workbench bench run, not just by exotic embedders. **shell stays
native**: pty handling and pause/resume flow control have no kind-API
hooks. Schema impact: `SpawnSpec` admits `{kind: string, …params}`
(`KindSpawn`); `SpawnResult` admits kind-specific extra fields.

**Context.** The final #17 slice — the platform claim ("stdio-shaped
bridge over files, bring your own semantics"). The immediate consumer is
[#18](https://github.com/dglazkov/fsio/issues/18)'s ACP demo (an agent
protocol as a kind). Enforced by four B1 scenarios (real client ↔ real
host: DATA roundtrip + custom method + extra result fields; policy
applies to registered kinds; handler throw → 1002; exit()/onClose
lifecycle; namespace guards).

**Alternatives rejected.** Subclassing `HostServer` (couples embedders to
scan internals). Kind-as-child-process (that's what `shell` *is*; the
registry is for in-process semantics). Routing kind DATA through JSON-RPC
(rejected once already in D10 — bytes stay raw). Flow-control/
backpressure hooks in the kind API now (no consumer streams enough to hit
the 4 MiB ack window yet, and
[#10](https://github.com/dglazkov/fsio/issues/10)'s chunk credits may
reshape the mechanism — design it once, there).

**Findings.** None; behavior enforced by the B1 tier. Feeds #18 (first
real kind), #8 (freeze surface), #10 (backpressure hook design).

## D14 — host embedder surface: introspection, leveled log lines, awaited close, injected pty

**Decision.** Settles the four open questions #26 carried out of the #17
inversion:

1. **`listSessions(): SessionInfo[]`** — read-only snapshots: `{id, kind,
   client, phase, pid?, pty?, bytesOut, bytesAcked, lastActivityAt}` with
   `phase: adopted → pending (D12) → running → exited | done`. Session
   map entries now GC with their dirs — introspection made visible that
   the map only ever grew for the life of the host.
2. **Logger is a leveled line sink** `{info, warn, error}`, structurally
   satisfied by `console`. Lines are for humans; the machine-readable
   surface is the protocol files plus `listSessions()` — not a log
   taxonomy. Scan-loop errors go to `error` (settles the "structured
   error hook" half of old question 3 host-side).
3. **`close()` returns a promise** that resolves when children have
   actually exited: SIGTERM → `killGraceMs` (default 3000, injectable) →
   SIGKILL, with an absolute cap and unref'd timers. All teardown stays
   synchronous, so un-awaited calls behave exactly as before. Kind
   `onClose` (D13) remains sync fire-and-forget — kinds own their async
   cleanup.
4. **pty is injectable**: `pty?: PtyModule | false` (default: auto-load
   node-pty). A fake module makes the pty branch of `startShell`
   CI-testable — the one path B1 could never reach.

**Context.** [#26](https://github.com/dglazkov/fsio/issues/26);
`listSessions` was the last library-side blocker on #16's host-side
confirmation UX. Enforced by B1 (phase transitions through a gated D12
policy; fake-pty spawn/data/resize/kill) and a lifecycle test (awaited
close SIGKILLs a TERM-trapping child in ~killGraceMs). Two *test-side*
races were measured and pinned in comments there: `sh -c` exec()s a lone
trailing command (discarding the trap), and "running" status precedes
trap arming.

**Alternatives rejected.** A structured event log (premature taxonomy —
files + `listSessions` are the structured surface; #8 owns freezing).
Exposing the live `Session` objects or the map (mutable internals;
snapshots keep invariants host-owned). An EventEmitter host (no consumer
needs push — confirmation UIs poll at human timescales; revisit with
#16). `close()` awaiting kind `onClose` (kinds own their async cleanup).

**Findings.** None platform-measured. Feeds #16 (confirmation UI reads
`listSessions`), #3 (reattach needs the same view), #8 (freeze surface).

## D15 — origin is client-stamped, advisory, and display-only

**Decision.** Spawn specs carry an optional `origin` field naming the web
origin of the page that created the session. The reference client stamps
`location.origin` in the library, **overriding caller-supplied values** —
an app cannot claim a foreign origin through the API. Hosts surface it
(`SpawnRequestInfo` for D12 policies, `SessionInfo` for D14 introspection,
the spawn-request log line) and MUST treat it as unauthenticated display
material: the transport is a shared directory, so any writer can forge any
identity by writing `spawn.json` directly. Authorization stays with the
spawn policy — and, for the terminal demo, the sandbox
([#16](https://github.com/dglazkov/fsio/issues/16)); authenticating origin
claims remains [#6](https://github.com/dglazkov/fsio/issues/6)'s problem.

**Context.** [#16](https://github.com/dglazkov/fsio/issues/16) S3: the
demo helper narrates *which page* is driving the shell ("● page connected
— origin: …") — the first, display-only step of #6's "origin
identification in the protocol". Enforced by a B1 test: the stamp
overrides a spoofed caller value, and both host surfaces (policy info,
`listSessions`) see the stamped origin.

**Alternatives rejected.** Reusing the free-form `client` tag (identity
worth displaying deserves defined semantics; `client` is caller-controlled
by design). Signed/verified origins (nothing to anchor trust to in a
filesystem transport; #6 owns whatever answer exists). Requiring an origin
(Node embedders — bench, the ACP demo
[#18](https://github.com/dglazkov/fsio/issues/18) — have none; absence is
information too).

**Findings.** None platform-measured. Feeds #6 (posture), #16 (helper
display), #18 (Node-side sessions legitimately originless).

## D16 — default pollMs is 15 ms: half the burn, still under one frame

**Decision.** The browser client's default hot-poll cadence is **15 ms**
(was 5). Per-session override stays first-class: latency-critical
embedders pass `pollMs: 5` and get exactly the old behavior — the knob
moved, nothing was removed.

**Flip-back trigger (read this first if you came here wanting speed).**
This is a default, not a capability. If interactive feel ever needs the
old cadence — user reports, a latency-sensitive embedder, a demo that
must win a benchmark — flip the one constant in
`packages/client/src/index.ts` (`pollMs = 15`) back to 5, or pass
`pollMs: 5` per session. Before flipping, know what F18 measured: RTT
p50 ≈ pollMs, so 5 buys ~10 ms of p50 at roughly **double** the
streaming CPU burn (58% vs 34% of a core, browser+renderer, on a fast
2026 arm64 Mac) — and the wake loop self-saturates at pollMs ≈ wake
duration (~4 ms there), so on slower machines 5 ms mostly buys burn,
not latency: their RTT floor is their wake duration regardless.

**Context.** 5 ms was chosen on the latency axis alone
([F2](FINDINGS.md#f2--node-fswatch-adds-50-ms)); the cost axis had no
numbers until
[F18](FINDINGS.md#f18--idle-sessions-cost-075session-in-chrome-linear-to-8-and-more-in-the-host-the-pollms-curve-the-wake-loop-self-saturates-at-pollms--wake-duration).
At 15 ms the p50 (14.8 ms) is still under one 60 Hz display frame — the
workbench's own verdict tier calls both "instant" — while the streaming
burn nearly halves and the default moves off the measured saturation
edge. The burn lands in the *browser process* (F17), invisible to the
page's DevTools, i.e. it reads as "Chrome is eating my battery" and gets
blamed on nothing in particular; a default should not do that for a
latency margin nobody can feel.

**Alternatives rejected.** Keeping 5 (pays double burn for sub-frame
latency nobody perceives; worse on slow machines, where it saturates).
50 ms (p50 ≈ 50 ms is a felt sluggishness — F18's own verdict tiers say
so). Making the default adaptive-by-machine (measuring wake duration at
startup is attractive but speculative; revisit if slow-machine reports
arrive — the per-op constant in F18 is the calibration a future
auto-tuner would use).

**Findings.** F2, F17, F18.

## D17 — client heartbeats: opt-in, detached marking instead of kill

**Decision.** Clients send a `heartbeat` JSON-RPC notification every 20 s
(client option `heartbeatMs`, 0 = off). It is a *quiet* send: it rides the
normal uplink (~44 B framed → always the dirname fast lane) but does not
re-arm the adaptive hot poll — a beacon must not buy 2 s of hot polling
per beat (F18's idle economics). On the host, any consumed uplink chunk
counts as client presence; the first `heartbeat` marks the session
heartbeat-aware, opting it into vanished-client policy. After
`detachAfterMs` (default 180 s) of silence from a heartbeat-aware client:
echo sessions are reaped (stateless workbench artifacts, GC'd precisely
instead of via the blunt 5-minute idle window); everything else — shells,
registered kinds — is **marked** `detached: true` in `status.json`, with
state, process, and stream untouched. Any consumed uplink chunk clears
the marker. `heartbeat` is host-reserved alongside `ack`/`close` (never
dispatched to registered kinds). Legacy clients that never beat keep the
exact pre-D17 behavior.

**Why the window is 180 s** (F16, measured): a hidden tab's timers clamp
to 1/min under Chrome's intensive throttling, so a healthy backgrounded
client beats at 60 s cadence — 180 s is three clamped beats of margin. A
frozen tab (battery saver, unmeasured — #50 territory) will false-detach,
which is exactly why detach is a marker and not a kill: the cost of a
wrong verdict is one status flip that self-heals on return, not a dead
shell. Getting this wrong the other way — GC'ing on a 1-minute window —
would kill the session out from under every user who switches tabs.

**Why opt-in via first-heartbeat** rather than a capability flag or
protocol bump: the host cannot distinguish "old client" from "quiet
client" any other way without a handshake (#8, future), and false
detachment of legacy clients would be a silent behavior change for every
existing embedder and test rig.

**Alternatives rejected.** Client-owned heartbeat *file* (mtime-based):
another file with another writer, and a browser rewrite pays the
swap-commit cost for no reason when the dirname lane already carries
40-byte notifications for ~3 ms (F10). Heartbeats riding something
unthrottled (the FileSystemObserver survives backgrounding, F16 — but it
is a *read-side* mechanism; there is no unthrottled write-side timer to
ride, so tolerate the clamp instead). Kill-after-grace for shells
(rejected in #3 from the start: they may hold real user processes).

**Findings.** F10, F16, F18.

## D18 — attach is takeover: writer epochs fence the old client

**Decision.** Reattach (tmux-lite, #3 phase 2) is a *takeover*, arbitrated
by the host with **writer epochs**. The attacher commits
`attach.<aid>.json` — a JSON-RPC `attach` request in a bootstrap file,
same trick as spawn.json, because a would-be writer cannot ask on an
uplink it doesn't own; the unique `aid` in the file name keeps concurrent
attachers off each other's files (F8/D6). The host consults the spawn
policy (same hook, `attach: true`, the attacher's identity — taking over
a shell is judged like spawning one), then grants: epoch++, uplink moves
to `in.<epoch>/` with a fresh sequence space, `status.json` records
`writer: {epoch, aid}` (durable — a restarted host resumes the right
lane) and clears `detached`. The grant answer rides the out stream, which
is naturally multi-reader. The superseded client's fence is that same
status record: on observing a higher epoch it stops committing (send()
poisons, heartbeats stop), while reads may continue. Scrollback replay is
client-local — the attacher re-reads the retained head segment and
re-emits DATA frames only; replayed RPC frames are never re-correlated
(the predecessor's response ids would collide with live requests). The
`detach` notification is the deliberate walk-away: detached marking now,
no D17 silence window. Attaching to an exited session is error `1005`.

**Why takeover, not detached-only attach:** the driving case is a page
refresh — the old client is gone but its silence hasn't reached the D17
window yet, so an attach gated on `detached: true` would make the user
wait ~3 minutes to get their shell back. Takeover with a clean, observable
fence makes the wrong-guess cost one status flip (the losing tab shows
"superseded" and can re-attach), not a wedged uplink.

**Why epoch dirs, not epoch-prefixed chunk names:** the sequence-gap rule
(a gap stalls consumption forever) makes any shared namespace between two
writers a wedge hazard the moment ordering is ambiguous; a fresh dir per
epoch resets the sequence space atomically with the grant, and stale-epoch
dirs are swept with the session dir (D6) like any other consumed debris.

**Alternatives rejected.** Single `attach.json` (last-writer-wins on one
file = exactly the F8 violation this protocol is built to avoid).
Attach-on-uplink (circular: no lane before the grant). Detached-only
grants (see above). Host-killed old clients (there is no channel to a
vanished tab — fencing via observable state is the only mechanism that
works for both live and dead predecessors).

**Findings.** F8 (one writer per file), F16 (why the refresh case can't
wait out the silence window), F13 (serialized commits bound the fenced
client's stranded chunks to a handful).
