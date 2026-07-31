# fsio decisions — why the protocol is shaped this way

ADR-lite, append-only. Each entry records a decision, its context, the
alternatives rejected, and the findings that forced it. Numbers (D1, D2, …)
are stable and never reused; superseded decisions get a note, not an edit.

Companions: [PROTOCOL.md](PROTOCOL.md) (the normative spec),
[FINDINGS.md](FINDINGS.md) (measured platform behaviors, F1–F22).

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

**Addendum (2026-07-30, [F22](FINDINGS.md#f22--the-hosts-idle-burn-is-the-hot-poll-gate-alive-gated-5-ms-scans-cost-60-of-a-core-at-32-idle-sessions-idle-gated-machinery-3-one-recursive-watcher-2-with-14-ms-wakes),
[#73](https://github.com/dglazkov/fsio/issues/73)).** The adaptive gate is
now both peers' rule, not just the browser's. The host had shipped a
*liveness* gate (`started && !done`) since before the client's activity gate
existed, which is a different claim: idle-but-running sessions kept the
5 ms × O(N) scan loop hot forever. Ported host-side with the same 2 s window
(`timings.hotWindowMs`), armed by uplink chunks, session adoption, and attach
bootstraps. Idle wake-up falls back to what invariant 1 always required — a
watch event (~50 ms, F2) or the 250 ms safety scan — and the first consumed
chunk re-arms the loop.

**Findings.** F2, F3, F6, F16, F17, F18, F22.

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
polling; it is never fatal. Failure includes *stalling*: startup that
has not settled within a bounded window is treated as failed
(2026-07-29, after
[F19](FINDINGS.md#f19--observe-can-stall-for-tens-of-seconds-without-rejecting-a-stall-is-not-a-refusal):
`observe()` stalled ~49 s without rejecting, gating everything behind
session init).

**Context.** Chrome's `observe()` fails with `InvalidModificationError`
for directories under `/tmp` on macOS (the `/tmp → /private/tmp` symlink,
[F9](FINDINGS.md#f9--observe-refuses-on-directories-under-tmp-macos)).
Since D1 guarantees the protocol works under pure polling, degradation is
free.

**Alternatives rejected.** Treating observer failure as an error (breaks
on legitimate directories for platform-specific reasons). Awaiting
startup unboundedly (F19: a silent stall then poisons `ready` while the
host's answers sit on disk).

**Findings.** F9, F19. Depends on D1.

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

## D19 — the hub pivot: one transport folder as a socket, workspaces as resources

**Decision.** fsio's deployment model pivots from folder-as-connection
(one host launched per project folder) to a **hub singleton**: a
long-lived daemon (`fsiod`,
[#71](https://github.com/dglazkov/fsio/issues/71)) serves exactly one
well-known directory (working name `~/fsio`). A page grants that one
directory **once per origin, ever**
([F20](FINDINGS.md#f20--a-persisted-handle-with-allow-on-every-visit-spans-browser-restarts-revisit-is-zero-gesture))
— the folder stops being the thing you work on and becomes a socket that
happens to be a directory. Working folders demote from transport *medium*
to session *parameters*: `{workspace: name}` in the spawn spec, resolved
by a daemon-side workspace registry (`fsio share .`), judged by the
[D12](#d12--spawn-policy-is-a-host-side-hook-confirmation-is-an-async-policy)
policy, sandboxed per registry profile
([#46](https://github.com/dglazkov/fsio/issues/46)). The one-folder mode
remains supported as the degenerate case (hub = workspace, registry of
one): the library stays folder-agnostic, the daemon is an embedder
([D13](#d13--session-kinds-are-a-host-side-registry-echo-is-just-an-entry)/[D14](#d14--host-embedder-surface-introspection-leveled-log-lines-awaited-close-injected-pty)),
and the existing CLI keeps working. Sequencing is gated — labs before
spec before code: multi-origin behavior
([#67](https://github.com/dglazkov/fsio/issues/67)), hub-scale host cost
([#68](https://github.com/dglazkov/fsio/issues/68)), picker navigation
([#69](https://github.com/dglazkov/fsio/issues/69)) → the hub spec
chapter ([#70](https://github.com/dglazkov/fsio/issues/70), producing
D20+) → fsiod ([#71](https://github.com/dglazkov/fsio/issues/71)) → the
demo port with a measured gesture-count verdict
([#72](https://github.com/dglazkov/fsio/issues/72)). This entry records
direction; the hub's normative rules land with #70's decisions.

**Context.** The per-folder flow taxes every connection with a
three-artifact rendezvous — create a folder, launch a host on it, grant
it in the page — because the folder conflates *transport* (where `.fsio/`
lives) with *subject* (what the shell works on and is sandboxed to). The
grant gesture cannot be automated
([F15](FINDINGS.md#f15--browser-write-access-is-gated-per-session-and-cannot-be-automated-one-gesture-unlocks-the-whole-session),
by Chrome's design), so gesture *count* is the only ergonomic lever — and
F20 measured the grant as durable across browser restarts ("Allow on
every visit" + persisted handle = zero-gesture revisits), which makes
one-grant-per-origin-ever feel like an installed capability. The
decisive platform wall: **a page cannot reveal the absolute path of a
picked folder**, so a daemon can never be told which arbitrary folder to
adopt — discovery of page-picked transport folders is unsolvable, while
a hub the daemon owns and natively watches has no discovery problem at
all. Independently,
[F18](FINDINGS.md#f18--idle-sessions-cost-075session-in-chrome-linear-to-8-and-more-in-the-host-the-pollms-curve-the-wake-loop-self-saturates-at-pollms--wake-duration)
indicted the host's per-session idle burn (~2–5% of a core per session)
and deferred the scan-loop redesign the daemon now requires (#68). The
pivot promotes parked issues to core: #46 (consent/profiles become the
security spine), [#6](https://github.com/dglazkov/fsio/issues/6)
(ship-prerequisite: a daemon serving every registered workspace cannot
keep the v0 thin posture),
[#8](https://github.com/dglazkov/fsio/issues/8) (an installed daemon
meeting evolving pages makes version skew real),
[#7](https://github.com/dglazkov/fsio/issues/7) (the daemon is the
packaging story). Known risks, each with a lab or an escape hatch:
multi-origin contention on one hub (#67; fallback — origin-scoped hub
subdirs cost zero extra gestures, since grants are per-(origin, folder));
the picker-navigation wart on first grant (#69; `startIn` accepts only
well-known directories); security blast radius concentrating in daemon
policy (#6/#46 before anything ships).

**Alternatives rejected.** Status quo per-folder (the rendezvous tax
scales with folders; fine for a measurement workbench, hostile as a
product). A daemon multiplexing arbitrary page-picked folders — the
idea's first form (dies on the no-absolute-path wall: neither side can
tell the daemon where a picked folder lives, and every workaround is a
registry hack on both sides; the hub dissolves the discovery problem
instead of solving it). A localhost WebSocket server — the obvious rival
(no picker, no 180 B dirname budget — but ambient authority: any page or
local process can knock, auth must be homegrown, and an open port brings
CORS/DNS-rebinding surface; the hub delegates its entire auth model to
the browser's permission system — per-origin, user-visible, revocable in
chrome://settings, gated by F15's unautomatable gesture — plus 0700 file
permissions beat localhost's any-local-user reachability, and sessions
are durable files: scrollback, reattach,
[D17](#d17--client-heartbeats-opt-in-detached-marking-instead-of-kill)/[D18](#d18--attach-is-takeover-writer-epochs-fence-the-old-client)
for free). A big-bang rewrite (D1–D11 are folder-agnostic and carry over
untouched; staged slices keep main green and the one-folder mode alive
as the fallback if a hub assumption cracks late).

**Findings.** F15, F18, F20 (motivating); F8/[D6](#d6--one-writer-per-file-one-cleanup-owner)
(the namespacing question #67 prices). Depends on D12 (policy), D13/D14
(embedder surface). Feeds #67–#72; promotes #46, #6, #8, #7; supersedes
[#65](https://github.com/dglazkov/fsio/issues/65) (closed → #72).

## D20 — the hub folder carries transport and advertisement; authority lives outside it

**Decision.** In hub mode
([D19](#d19--the-hub-pivot-one-transport-folder-as-a-socket-workspaces-as-resources))
the granted directory holds transport files and public advertisement, and
nothing else. The layout is the one-folder layout unchanged — one
`sessions/`, one `client/`, client-minted globally unique ids, **no
per-origin subdirectories**. Everything authoritative lives in
daemon-private state outside the grant: the workspace registry, grant
records, profiles, the singleton lock. Two rules follow and are stated
normatively in the spec's hub chapter: **no file inside the hub may be a
security or safety mechanism** (a co-tenant can forge or delete it), and
**no secret may transit the hub folder** (a file there is a broadcast to
every tenant). Co-tenancy itself is accepted, not engineered away: one
origin's session dirs, scrollback included, are readable by every other
granted origin; the isolation unit is the folder, so isolation means a
second hub. A daemon MUST be able to enumerate which origins hold grants,
so the co-tenancy a user accepted stays legible.

**Context.** [#70](https://github.com/dglazkov/fsio/issues/70)'s layout
bullet, answered by its gating lab. F21 measured grants as independent per
(origin, folder) with fair-share broker throughput and zero errors across
~8,600 concurrent writes, which removes the *correctness* motive for
origin-scoped subdirs (D19's named escape hatch). The security motive
dissolves separately and more decisively: Chrome grants folders, not
subtrees, so a co-tenant's handle reaches every subdirectory anyway —
namespacing would have been isolation theater. Inverting that observation
is what produces the chapter's spine: if the folder confines nothing, then
authority must not live in it. This is a real hardening of
[#46](https://github.com/dglazkov/fsio/issues/46)'s sketch, which wrote
grants *into* `.fsio/` — safe when one folder meant roughly one page,
unsafe the moment the folder is a shared socket.

**Alternatives rejected.** Origin-scoped subdirs (D19's hatch: no
correctness benefit per F21, no isolation benefit per Chrome's grant
granularity, and a permanent fork in the layout the one-folder mode would
not share). Encrypting per-origin state in the folder (key distribution has
the same out-of-band problem the secret does, and it would make the hub
opaque to the local tools that make "just files" debuggable). Making the
daemon the only writer, with pages posting intents (that is a localhost
server with extra steps — D19 rejected it once already). Per-origin
retention/scrubbing of scrollback to blunt co-tenant reads (mechanism
without a threat model; [#6](https://github.com/dglazkov/fsio/issues/6)
owns retention).

**Findings.** [F21](FINDINGS.md#f21--two-origins-hold-independent-grants-on-one-directory-the-broker-splits-throughput-fairly-the-durable-grant-is-minted-at-the-re-prompt-not-the-picker)
(independence, fair sharing, per-origin revocation),
[F8](FINDINGS.md#f8--peers-must-not-contend-for-the-same-files)/[D6](#d6--one-writer-per-file-one-cleanup-owner)
(one writer per file survives co-tenancy only because ids are unique).
Feeds #71, #46, #6.

## D21 — the daemon is a singleton enforced by an OS lock; the heartbeat stays advisory

**Decision.** One daemon per hub directory, enforced by an OS-level
exclusive lock (`flock`-class) keyed by the hub's absolute path, held for
the process lifetime, living in daemon-private state (D20). A daemon that
cannot acquire it exits non-zero without touching the hub. `host.json`'s
heartbeat keeps its client-facing meaning (liveness = mtime younger than
6 s) but is no longer the mutual-exclusion mechanism in hub mode.
[#40](https://github.com/dglazkov/fsio/issues/40)'s refuse-over-a-live-
`host.json` rule stays normative for one-folder hosts.

**Context.** #40's rule was always described in the spec as "a seatbelt,
not a distributed lock" — two hosts starting inside one heartbeat window
still collide. A hub makes both halves of that worse: a supervisor
(launchd) restarts the daemon precisely in the window where the old
heartbeat is fresh, so the seatbelt fires against a corpse; and the
heartbeat file now sits in a multi-tenant directory where any granted
origin can delete or backdate it, which by D20's rule disqualifies it from
being a safety mechanism at all. An OS lock has neither problem and needs
no heuristic. The one-folder case keeps the seatbelt because it has no
daemon-private state to lock and no supervisor racing it.

**Alternatives rejected.** Keeping the heartbeat as the only gate (D20:
forgeable, and it loses the launchd restart race). A pidfile in the hub
(same forgeability, plus pid reuse). A lock file inside the hub (a
co-tenant deletes it; `O_EXCL` creation without a kernel-held lock also
strands the hub after a crash). launchd exclusivity alone (macOS-only,
and it does not stop a hand-started daemon from serving the same hub —
[#5](https://github.com/dglazkov/fsio/issues/5) wants a mechanism that
ports).

**Findings.** None measured; the F8/D6 one-writer invariant is what the
lock protects — a second daemon would re-spawn every adopted session,
consume uplink chunks the first then sees as gaps, and mint competing
[D18](#d18--attach-is-takeover-writer-epochs-fence-the-old-client) epochs.
Feeds #71 (launchd install), #7.

## D22 — workspaces are session parameters resolved by a daemon-private registry

**Decision.** `workspace` in a spawn spec names a registry entry, never a
path; the host resolves the name against a daemon-private registry
(`fsio share .`) and answers `1006` when it cannot, including the
one-folder host (a registry of one). Absolute paths never appear on the
wire in either direction. A process-spawning kind MUST name a workspace
when the host serves more than one; `cwd` resolves relative to the
workspace root and MUST NOT escape it. Each entry carries a profile
(allow-list, sandbox template, env policy —
[#46](https://github.com/dglazkov/fsio/issues/46)); a spawned child's reach
is the intersection of profile and grant scope, and profile directories
govern the *child*, never the browser's reach. **Direct file access
composes rather than merges**: a page MAY hold its own FS Access grant on a
workspace folder and read/write it directly with fsio uninvolved; hosts
MUST NOT require workspaces to live inside the hub, and MUST NOT route
direct file I/O through sessions.

**Context.** D19 demoted working folders from transport medium to session
parameter; this is that rule made normative, plus the answer to the
grant-composition fork [#70](https://github.com/dglazkov/fsio/issues/70)
inherited from the agent demos
([#74](https://github.com/dglazkov/fsio/issues/74),
[#78](https://github.com/dglazkov/fsio/issues/78)): in hub topology #74's
capability ladder spans two grants on two different folders — rungs 1–2
(see/edit, zero-install) on the repo itself, rung 3 (run) on the hub. F21
prices holding both at exactly one extra gesture, ever, because grants are
independent per (origin, folder). The alternative readings were filed with
that fork and are rejected below. Name-not-path is forced twice over: the
page cannot supply a path (D19's decisive wall — a picked handle has none),
and the host must not disclose one, because the hub is co-tenant-readable
(D20) and a path leaks the user's home directory and project layout.

**Alternatives rejected.** Fork option (b), **workspaces physically inside
`~/fsio`** so one grant covers direct access too (relocates people's repos
to serve the transport; the tail wags the dog). Fork option (c), **all file
I/O routed through fsiod sessions** with the page dropping its direct
handle (clean layering, but the files-only degenerate mode and the hub mode
would then use disjoint code paths on the page side — and NARRATIVE.md's
standing constraint is that every act stays playable without the daemon).
Paths on the wire as a convenience for display (leaks by default; a `label`
in the registry covers the legitimate need). Silently substituting the
default workspace for an unresolvable name (the one behavior a subject
parameter must never have — the client would be told it ran somewhere it
did not).

**Findings.** [F21](FINDINGS.md#f21--two-origins-hold-independent-grants-on-one-directory-the-broker-splits-throughput-fairly-the-durable-grant-is-minted-at-the-re-prompt-not-the-picker)
(independent grants make option (a) cost one gesture),
[F20](FINDINGS.md#f20--a-persisted-handle-with-allow-on-every-visit-spans-browser-restarts-revisit-is-zero-gesture)
(each grant, once durable, is zero-gesture on revisit). Depends on
[D12](#d12--spawn-policy-is-a-host-side-hook-confirmation-is-an-async-policy).
Feeds #71 (registry + profiles), #74, #72.

## D23 — consent is host-served, and grants are proof-of-possession capabilities

**Decision.** Makes [#46](https://github.com/dglazkov/fsio/issues/46)'s
device-grant sketch normative, hardened for multi-tenancy. Two
authorizations, kept separate: a **grant** is standing authority for an
origin over named workspaces and a class of action, minted by a human at a
host-drawn consent page and revocable; the
[D12](#d12--spawn-policy-is-a-host-side-hook-confirmation-is-an-async-policy)
policy is the per-request judgment. Execution requires both. Rules: only
hub-confined kinds (`echo`) may be served ungranted; the host draws the
consent pixels, never the requesting page; the request rides the folder
(`consent/<rid>.json`, one writer per file, host deletes on answer) and
needs no gesture, while the navigation to the endpoint MUST be
user-initiated and MUST follow publication of that endpoint; **grants are
proof-of-possession, never bearer** — the secret reaches the origin out of
band of the folder and each request is bound to the session it authorizes;
what lands in the folder is a secret-free receipt, with the authoritative
record daemon-private and revocation effective at the next policy judgment;
the consent server binds loopback, only while a request is pending, behind
a per-boot unguessable nonce, and carries consent and grant administration
only — **the folder remains the only data plane**. First-run flows MUST
route through one deliberate `requestPermission()` re-prompt to mint a
durable grant. The reference answer channel (a click-opened loopback tab
delivering the secret by `postMessage` to its opener) is explicitly
unmeasured and gated on [#79](https://github.com/dglazkov/fsio/issues/79);
the rules above are transport-independent.

**Context.** D19 concentrated the blast radius in daemon policy and
promoted #46/#6 from parked to core; this is the promotion. Two changes to
the sketch, both forced by the hub: grants cannot live *in* `.fsio/` (D20),
and a bearer token in `spawn.json` — which #46 flagged as acceptable if the
threat model were "web origins only" — is exactly wrong here, because the
hub's co-tenants *are* web origins and can read it. Proof-of-possession
plus session binding makes a copied `spawn.json` inert: it cannot be
re-aimed at a session id the MAC does not cover, and the session it does
cover has already been adopted. The bearer/PoP question was #46's first
hard constraint; the hub answers it. The two-authorization split is what
keeps [#74](https://github.com/dglazkov/fsio/issues/74)'s ladder honest at
rung 3 — "execution in principle" (the grant, installed once) is a
different consent from "this command, now" (the D12 prompt) — and
[#76](https://github.com/dglazkov/fsio/issues/76) is the design space
between them, where an agent chatty enough to cause prompt fatigue meets a
grant broad enough to stop asking.

**Alternatives rejected.** Bearer tokens in `spawn.json` (readable by every
co-tenant — the hub's defining difference from one folder). Grant records
in the hub (forgeable and readable; D20). A redemption code in the receipt,
exchanged for the secret over loopback (a co-tenant reads the receipt and
races the redemption; it also needs `fetch()` to loopback, the leg most
likely to be blocked). Origin claims as authorization
([D15](#d15--origin-is-client-stamped-advisory-and-display-only) stands:
unauthenticated, display-only — the grant is what makes an origin claim
checkable). A page-drawn consent dialog (clickjackable by construction; the
whole point is pixels the requester cannot reach). One authorization
instead of two (either prompts on every command — click-through theater —
or a standing grant that silently authorizes tomorrow's commands).
Long-lived HTTP for anything beyond consent (an open data-plane port
forfeits the "no server" claim; #46's own hard constraint).

**Findings.** [F21](FINDINGS.md#f21--two-origins-hold-independent-grants-on-one-directory-the-broker-splits-throughput-fairly-the-durable-grant-is-minted-at-the-re-prompt-not-the-picker)
and [F20](FINDINGS.md#f20--a-persisted-handle-with-allow-on-every-visit-spans-browser-restarts-revisit-is-zero-gesture)'s
addendum (the durable grant is minted at the re-prompt, so a first-run flow
that stops at the picker is session-scoped),
[F15](FINDINGS.md#f15--browser-write-access-is-gated-per-session-and-cannot-be-automated-one-gesture-unlocks-the-whole-session)
(the gesture is unautomatable, so the flow must not race activation).
Unmeasured, filed: #79 (answer channel), #69 (first-run ergonomics).
Depends on D12, D20. Feeds #6, #46, #71, #76.

## D24 — the service directory is the origin-facing capability document

**Decision.** `host.json` stays the hot 2 s heartbeat and gains
`servicesRev`. The capability document is a separate host-owned file,
`services.json`, temp+renamed only when its content changes:
`{rev, protocol, capabilities, kinds, workspaces, consent?}`. A client
already statting the heartbeat learns from `servicesRev` when to re-read —
the [D3](#d3--rename-committed-doorbell-outsig) doorbell discipline, hot
pointer plus cold state. `kinds` is
[D13](#d13--session-kinds-are-a-host-side-registry-echo-is-just-an-entry)'s
registry surfaced to pages. Because one file serves all tenants, it
advertises only what every granted origin may see: workspace **names** the
user marked advertisable — never paths, never the full registry. Per-origin
visibility is a property of the grant, carried by its receipt (D23).
`allowShell`/`pty` stay in `host.json` for one-folder compatibility; hub
clients read `capabilities`.

**Context.** [#70](https://github.com/dglazkov/fsio/issues/70)'s service-
directory bullet, and the substrate the later bus slices enumerate
([#18](https://github.com/dglazkov/fsio/issues/18),
[#44](https://github.com/dglazkov/fsio/issues/44),
[#45](https://github.com/dglazkov/fsio/issues/45)). Splitting hot from cold
is not premature: `host.json` is rewritten every 2 s forever, and a hub's
directory grows with registered workspaces and kinds, so merging them would
rewrite the largest document on the fastest cadence and hand every client a
re-parse per beat. The privacy line is the same one D22 draws — a roster of
workspace names is a smaller leak than paths, but it is still a leak to
*ungranted* origins, and the grant is the right place to widen it.

**Alternatives rejected.** Growing `host.json` itself (couples a growing
document to a 2 s rewrite; also mixes a forgeable-liveness file with the
capability contract). Per-origin directory files (a file per origin in a
folder every origin can read is not per-origin anything — D20). An RPC
method for enumeration (a client would need a session to learn what
sessions it may create — a bootstrap circle; files are readable before
anything is spawned). Advertising the full registry to everyone (leaks the
user's project roster to any granted origin, and to ungranted ones that
merely hold the folder).

**Findings.** None measured. Depends on D3, D13, D20. Enforced by the B1
battery (`test-client.ts`: doorbell, write-on-change, names-never-paths) and
the fsiod tier (`test-services.ts`). Feeds #8, #18, #44, #45, #71.

## D25 — capabilities are feature-detected names; `protocol` is the on-disk version

**Decision.** `protocol` versions the **bytes on disk** — frames, file
names, layout — and increments only when an older peer would misread them.
Everything else is a named capability advertised in `services.json` and
feature-detected. Rules: unknown JSON fields are ignored in both directions
and in every file; unknown capability names are never fatal; clients gate
behavior on capability names, not `protocol` ranges; capability names are
stable and never reused, exactly like F and D numbers (a withdrawn
capability burns its name); a peer reading a `protocol` higher than it
implements MUST NOT create sessions and SHOULD surface an upgrade path; a
daemon leaves session directories it cannot parse alone, GC'ing them only
by age. Adding the hub chapter therefore does not bump `protocol`: every
hub facility is additive.

**Context.** [#8](https://github.com/dglazkov/fsio/issues/8), pulled by
D19. Until now both sides shipped together — the workbench and the host
come out of one repo at one commit — so skew was a theory. An *installed*
daemon meets pages of every vintage, on the user's upgrade schedule for one
and the deployer's for the other, in both directions (old daemon/new page
is the common case; new daemon/old page happens on every restart). That is
a permanent condition, not a migration, and permanent skew is what named
capabilities are for. This entry sets the discipline; #8 keeps the concrete
job of freezing schemas and enumerating the first capability names.

**Alternatives rejected.** Semantic versioning of the whole protocol with
range checks (invites "if version ≥ N" branches that break the moment a
facility is backported or withdrawn). Negotiation handshakes (there is no
connection to negotiate over — the client reads a file before it writes
anything, which is strictly simpler). Failing closed on unknown fields
(guarantees that every additive change breaks every old peer — the exact
outcome this is meant to prevent). Bumping `protocol` for the hub (nothing
on disk changed; a bump would strand every existing client for a facility
they need not use).

**Findings.** None measured. Depends on D24. The first four capability names
(`shell`, `pty`, `attach`, `workspaces`) are listed in the spec's
[service directory](PROTOCOL.md#service-directory) section; enforced by the
B1 battery (unknown names are a no, not a throw). Feeds #8, #7, #71.

## D26 — scrollback hygiene: retention = the replay window, terminal sessions are swept, `.fsio/` is git-ignored

**Decision.** Three rules bounding what a session leaves behind
([#82](https://github.com/dglazkov/fsio/issues/82); normative text in the
spec's Scrollback hygiene section). (1) **Retention is the replay
window**: fully-acked non-current segments are deleted (the
[D9](#d9--segmented-log-with-cumulative-ack-flow-control) mechanism,
now stated as the retention rule), so disk holds exactly the current
segment plus unacked backlog — what delivery and
[D18](#d18--attach-is-takeover-writer-epochs-fence-the-old-client)'s
head-segment replay need. Extending replay
([#57](https://github.com/dglazkov/fsio/issues/57)) must serve what
retention keeps, never widen it. (2) **Terminal sessions are swept**: a
session that is exited or errored, whose client has been silent past
`staleGraceMs` (60 s), is removed — previously only at adoption, now also
continuously by the idle sweep, because a crashed tab otherwise left
scrollback on disk for the life of the host. Presence is measured by
consumed uplink chunks (a client still draining the final out log keeps
acking and is never swept mid-read); detached *running* sessions are
exempt (their scrollback is the reattach promise). (3) **`.fsio/` is
auto-git-ignored**: a host whose shared directory lies inside a git
repository appends `.fsio/` to that directory's own `.gitignore` at
start, once, and warns loudly when it cannot (`gitignore: false` /
`--no-gitignore` opts out).

**Context.** Split from [#6](https://github.com/dglazkov/fsio/issues/6)
as its one implementation-shaped bullet; D20 parked retention here
("mechanism without a threat model") and the threat-model chapter
([#81](https://github.com/dglazkov/fsio/issues/81)) then supplied the
model: co-tenant scrollback reads are accepted, so the mitigation is
bounding what exists to read, and the sweep answers the readback leg of
the capability inventory. The #57 tension (replay wants more retained,
retention wants fewer) dissolves once the arrow is fixed: retention is
sized by flow control and the head-replay promise, and replay may only
grow up to it. The gitignore rule's sharp case is one-folder mode —
`.fsio/` sits inside the user's project, and one `git add -A` would
commit scrollback; appending to the shared dir's *own* `.gitignore` is
correct for nested dirs (git reads one at every level) and never touches
files outside the directory the user handed the host.

**Alternatives rejected.** Time-based retention caps on live segments
(the ack window already bounds them; a cap under it would break delivery,
over it is dead letter). Secure-erase shredding (the adversary is the
folder's readers, not disk forensics — unlink ends folder visibility,
and on modern SSDs overwrite-in-place is theater anyway). Sweeping
unstarted session dirs (no spawn.json = no scrollback, and a
backgrounded tab mid-create — F16's 1/min clamp — could legitimately
pause that long between mkdir and spawn.json; removing the dir under it
would strand the commit). Writing to the repo root's `.gitignore` or
`.git/info/exclude` (touches files outside the granted directory;
exclude is invisible to collaborators who also run hosts). A
`core.excludesFile` recommendation (per-user config cannot protect a
shared repo).

**Findings.** None newly measured; F8/[D6](#d6--one-writer-per-file-one-cleanup-owner)
(host owns cleanup), F16 (why unstarted dirs are exempt),
[F21](FINDINGS.md#f21--two-origins-hold-independent-grants-on-one-directory-the-broker-splits-throughput-fairly-the-durable-grant-is-minted-at-the-re-prompt-not-the-picker)/D20
(co-tenant readability raising the stakes). Enforced by the lifecycle
tier (`test-lifecycle.ts`: sweep scenarios, gitignore scenarios). Feeds
#6 (close condition), #57 (the retention ceiling replay may grow into),
#71 (the daemon inherits all three rules).
