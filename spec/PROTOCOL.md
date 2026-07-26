# fsio protocol — v0 (working draft)

A filesystem-based bridge between stdio and the Web Platform File System API.
Two peers share a directory:

- **client** — typically a web page holding a `FileSystemDirectoryHandle`
  (user-picked, `mode: "readwrite"`), watching with `FileSystemObserver` or
  polling.
- **host** — a native process (Node prototype in `host/fsio-host.js`) with
  ordinary POSIX file access, watching with `fs.watch`.

All protocol state lives under `<shared-dir>/.fsio/`. The transport is "just
files"; every mechanism below exists to survive the constraints of the two
runtimes (atomicity, append semantics, event coalescing).

## Design rules

1. **Events are wakeups, not messages.** Watch/observer events may be
   coalesced, duplicated, or dropped. On any wakeup a peer runs a full,
   idempotent scan. A slow safety poll (250–500 ms) backstops missed events.
2. **Never encode meaning in file events.** All meaning is in file *contents
   and names*. The protocol must work identically under pure polling.
3. **Readers must tolerate torn state.** A trailing partial frame or an empty
   chunk file means "in progress" — wait, never skip.
4. **The transport is asymmetric because the runtimes are.**
   - Host → client: **append-only log** (`out.log`). POSIX appends are cheap;
     the client reads from a byte offset.
   - Client → host: **numbered chunk files** (`in/NNNNNNNN.f`). The browser
     cannot cheaply append (`FileSystemWritableFileStream` rewrites the whole
     file via a swap file and commits on `close()` — which is exactly an
     atomic commit, so we lean on it). Native clients emulate the same
     atomicity with write-temp-then-rename.

## Directory layout

```
<shared-dir>/.fsio/
  fsio.json                 # { protocol: 0 }
  host.json                 # host heartbeat; rewritten (atomically) every 2s
  client/                   # client-owned diagnostics (not protocol): the web
    log.txt                 # workbench mirrors its log, errors, and bench
    report.json             # results here so the native side can read them
  sessions/
    <session-id>/           # created by client; id = s-<ts36>-<rand>
      spawn.json            # written LAST by client; presence = session is ready
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
```

- `spawn.json` is written after `in/` exists, so the host adopts only
  complete sessions.
- `out.sig` is both **doorbell** (rename-committed so watchers reliably wake;
  see F1) and **stream map**: `gen`/`size` locate the write head, `prevFinal`
  tells a reader when the previous segment is fully drained, `total` is
  cumulative bytes for ack accounting.
- **Flow control**: the client acks cumulative consumed bytes
  (CTL `{op:"ack", total}`, riding the dirname fast lane, throttled to
  250 ms / 256 KB). The host pauses the pty when unacked > 4 MB and resumes
  below 2 MB; fully-acked segments are deleted. See F12.
- Deleting a consumed chunk **is** the ack. Client-side backpressure = cap on
  outstanding (not-yet-deleted) chunks. (Not yet implemented; see open
  questions.)
- Liveness = `host.json` mtime younger than 6 s (3 missed heartbeats).

## Framing

Both `out.log` and each chunk file are concatenations of frames:

```
[u32le payload_length][u8 type][payload]
```

| type | name | payload |
|---|---|---|
| 1 | DATA | raw stdio/pty bytes |
| 2 | PING | JSON `{seq, t0, filler?}` |
| 3 | PONG | JSON `{seq, t0, t1, t2}` — t1 host-read, t2 host-append |
| 4 | CTL  | JSON `{op, ...}`: `resize{cols,rows}`, `signal{sig}`, `eof`, `close` |

A chunk file MAY contain multiple frames (the client batches frames queued
while a previous commit was in flight — this is the natural write-side
backpressure/coalescing mechanism). A chunk MUST NOT end mid-frame; if a host
reads a partial or empty chunk it retries shortly (the browser's swap-file
commit can appear as create-empty → content-appears).

Chunks are consumed strictly in ascending sequence order. A client MUST
serialize commits (chunk N fully committed before N+1 starts) so order of
appearance matches order of naming.

Timestamps are `performance.timeOrigin + performance.now()` — epoch-based ms,
comparable across processes on one machine.

## Session kinds (v0)

- `{"kind": "echo"}` — host echoes PING→PONG with timestamps. The latency
  workbench.
- `{"kind": "shell", cols, rows, cmd?, args?, cwd?}` — host spawns a shell
  under a pty (node-pty if installed; pipe fallback otherwise). DATA frames
  flow both ways; CTL `resize`/`signal`/`close` control it. Gated behind
  `--allow-shell`.

## Security posture (v0 stance)

Running the host with `--allow-shell` grants any page that can write to the
shared directory the ability to run processes as the user. Mitigations to
spec later: explicit allow-list of commands, per-session user confirmation on
the host side, `.fsio/` auto-added to `.gitignore`, scrubbing env in
`spawn.json`, and log retention limits (out.log contains full scrollback).

## Measurements

Goal: does the terminal feel live? Budget ≈ 50 ms keystroke→echo RTT.

RTT legs reported by the bench: `up` = client commit → host read;
`host` = host processing; `down` = host append → client read.

Environment: macOS 26.5 (arm64), Node v24.11.0, APFS, local disk.
Host at defaults (fs.watch + 5 ms hot poll) unless noted.

| client | notify mode | pings | payload B | min | p50 | p95 | max (ms) |
|---|---|---|---|---|---|---|---|
| node client | fs.watch | 300 | 0 | 4.29 | 50.59 | 51.34 | 58.19 |
| node client | poll 5ms | 500 | 0 | 4.19 | 5.53 | 11.21 | 17.58 |
| node client | poll 5ms | 200 | 4096 | 2.58 | 5.38 | 6.31 | 7.24 |
| node client | poll 1ms | 500 | 0 | 0.43 | 1.35 | 2.51 | 2.68 |
| web client | observer | 200 | 0 | 75.90 | 342.40 | 531.30 | 571.80 |
| web client | poll 5ms | 200 | 0 | 63.60 | 74.60 | 108.90 | 160.50 |
| web client | poll 5ms + dirname-up | 200 | 0 | 1.50 | 5.30 | 10.90 | 13.50 |
| web client | observer-only, isolated pings | 15 | 0 | 295 | 300 | 709 | 3062 |

Web leg breakdowns (Chrome 150): file uplink — up p50 69–71 ms · host
0.07 ms · down 2.6–3.1 ms. Dirname uplink — up p50 2.8 ms · down 3.3 ms.
The fast lane is 13× faster end-to-end and within 4× of the native-client
floor.

### Findings (2026-07, macOS)

- **F1 — held-fd appends are invisible to watchers.** Appending to out.log
  through a long-held fd produced almost no FSEvents; watchers saw the write
  only at file close or seconds of coalescing later. Fix: host does
  open/append/close per write **and** bumps `out.sig` via temp+rename —
  renames generate immediate, reliable events. With either fix, event
  latency at the FS layer is ~0 ms.
- **F2 — Node fs.watch adds ~50 ms.** libuv registers its FSEvents stream
  with 50 ms latency, quantizing every watch-driven leg to ~50 ms
  (p50 ≈ 50.6 RTT). The transport floor is far lower: 1 ms polling gives
  p50 1.35 ms RTT (sub-ms per leg). Conclusion: **wakeup strategy, not the
  filesystem, is the entire latency budget.**
- **F3 — hybrid notifier wins.** Watch events for idle efficiency + a 5 ms
  hot poll while a session is active → p50 5.5 ms RTT, p95 11 ms. Well
  inside the 50 ms terminal budget, with zero idle cost. Both host and
  clients now default to this.
- **F4 — payload size is irrelevant at stdio scale.** 4 KB pings cost the
  same as empty ones (p50 5.38 ms).
- **F6 — Chrome's FileSystemObserver delivers on a fixed ~300 ms cadence.**
  (Refined by the observer lab.) Isolated events — file create/write, dir
  create/remove — arrive at almost exactly 299–300 ms; a 20-mkdir burst
  coalesces into ~2 callback batches at the same cadence; yet a fresh
  observer's *first* event can arrive in 12 ms. So the ~300 ms is a
  batching timer, not transport latency, and no amount of churn-shaping
  fixes it. End-to-end confirmation (observer lab part D, host in a $HOME
  dir, safety poll disabled): isolated echo pings land at p50 300 ms — and
  one of 15 took 3.1 s (ten cadence cycles) while none were lost, so
  observer delivery can also *gap* for seconds. Clients MUST keep a safety
  poll even in observer-assisted modes. Design consequence: **adaptive notification** — observer as
  idle sentinel (zero cost, ≤300 ms wake-from-idle, bounded anyway by the
  safety poll), hot poll only while traffic flowed in the last 2 s. Browser
  clients default to this (`mode: "adaptive"`).
- **F7 — browser chunk commit costs ~68 ms, and it is entirely `close()`.**
  Confirmed by the write microbench (Chrome 150, 50 files × 64 B):
  open 0.4 ms · createWritable 0.3 ms · write 0.3 ms · **close 67.7 ms**
  (p95 73.8). Matches the live `up` leg (p50 70.8 ms). This is consistent
  with Chrome's Safe Browsing after-write checks on every commit into a
  user-visible directory (final attribution: rerun with Safe Browsing set
  to "No protection"). Unlike F1/F2/F6 this cannot be polled away — it is
  the browser uplink floor for *file-based* chunks; see the dirname-uplink
  experiment.
- **F10 — the dirname fast lane works: 5.3 ms RTT from the browser.**
  Encoding small frame batches as created directory *names* drops the web
  uplink from p50 69 ms to 2.8 ms — confirming that Chrome's after-write
  scan hooks file commits but not directory creation. Adopted as a
  first-class uplink: batches ≤180 raw bytes take the dirname lane
  (keystrokes, control, acks); larger batches take file chunks (pastes,
  uploads). Both share one sequence space, so ordering is preserved across
  lanes. Browser clients default to this (`uplink: "auto"`).
- **F12 — ack-window flow control works over files.** Motivating incident: a
  `find .` in the web terminal produced a 60 MB out.log with nothing
  slowing the pty down. With segmented logs + cumulative acks: a 32 MB
  flood (3 M lines) against a deliberately lazy consumer delivered every
  line, peaked at 8 MB on disk (≤2 segments), and the host cleanly
  oscillated pause(4 MB unacked)/resume(ack) throughout. Sustained
  throughput ≈ 2.6–3.7 MB/s through the file transport — plenty for
  terminal scrollback. Reproduce: `node bench/firehose.mjs <dir> --lines
  3000000 --slow`.
- **F11 — `getFile()` snapshots go stale under live writes.** If the host
  appends to out.log between the client's `getFile()` and the actual read,
  Chrome throws `NotReadableError` ("modified after a reference was
  acquired"). Under interactive pty output this is routine, not
  exceptional. Spec rule: readers MUST treat snapshot-read failures as
  transient — the offset hasn't advanced, so the next wakeup simply
  re-reads. (Resolves open measurement (c): yes, snapshots go stale.)
- **F9 — `observe()` refuses on directories under /tmp (macOS).** Solved by
  the observer lab differential: the full observe() matrix (3 handles ×
  recursive on/off) succeeds for a folder under `$HOME` and fails with
  `InvalidModificationError` for the same code against `/tmp/...` — almost
  certainly the `/tmp → /private/tmp` symlink. Clean Chromium repro
  candidate. Spec rule stands regardless: observer startup failure MUST
  downgrade to polling, never be fatal. (Practical corollary: don't demo
  out of /tmp.)
- **F8 — peers must not contend for the same files.** Browser-side recursive
  session deletion raced with host writes (doorbell renames, status.json)
  and failed with `InvalidModificationError`. Rule adopted: **every file has
  exactly one writer, and cleanup has exactly one owner** — the host (the
  side with POSIX semantics). Client `close()` just sends CTL `close` and
  stops watching; the host deletes the session dir ~500 ms later, and GCs
  stale exited sessions (>60 s) on adoption.
- **F5 — end-to-end shell works.** spawn → DATA both ways → CTL close →
  status transitions verified over the protocol (pipes; pty untested until
  node-pty is installed).

Open measurements: Safe Browsing on vs. off (final F7 attribution), and
dirname-lane throughput under sustained typing/paste load.

Reproduce:

```sh
node host/fsio-host.js /tmp/fsio-bench --fresh          # terminal 1
node bench/node-client.js /tmp/fsio-bench --count 500   # terminal 2
node bench/node-client.js /tmp/fsio-bench --poll 5      # polling variant
node bench/node-client.js /tmp/fsio-bench --poll 5 --uplink dirname
# browser: npm run serve → http://localhost:8765/web/ → pick /tmp/fsio-bench
```

## Open questions

1. **out.log growth / backpressure.** ~~Resolved by F12~~: segmented log,
   cumulative acks, 4 MB pause window, ack-driven segment GC.
2. **Chunk-count backpressure** client→host: cap outstanding chunks (host
   deletes = credit returned). Currently unbounded — but in practice the
   client's serialized commits self-throttle; low priority.
3. **Out-of-band control?** CTL currently shares the `in/` stream; a huge
   paste delays a resize. Separate `ctl/` lane, or priority chunks?
4. **Observer latency.** Is FileSystemObserver's wakeup latency acceptable,
   or does the browser client need the hot-poll mode too? (F2 suggests the
   underlying FSEvents stream latency depends on what the watcher requests;
   Chrome may tune it differently than libuv.)
5. **Multiple clients per session.** out.log is naturally multi-reader
   (read-only followers are free); `in/` writes would collide. Follower role
   worth speccing?
6. **Host restarts.** Currently adopts sessions and resumes echo, but marks
   shell sessions dead. Should shell sessions be resumable (reattach to a
   detached pty à la tmux)?
7. **Windows / network filesystems.** rename atomicity, watch semantics,
   and mtime resolution all differ. Out of scope for v0; spec should state
   assumptions explicitly.
8. **Uplink floor workarounds.** ~~Resolved by F10~~: the dirname fast lane
   sidesteps the `close()` scan entirely (69 ms → 2.8 ms). Remaining
   sub-questions: is the trick durable (could Chrome start scanning/blocking
   high-rate directory creation? name-length limits on other filesystems?),
   and should bulk file-chunk traffic get local-echo masking anyway for the
   paste-heavy case.
9. **Cleanup ownership.** ~~Who deletes finished session dirs?~~ Resolved by
   F8: the host, on CTL `close` and via stale-session GC. Remaining: GC for
   sessions whose client vanished without sending `close` (needs client
   heartbeats).
