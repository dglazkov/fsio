# fsio findings — lab notebook

Measured platform behaviors that shaped the protocol. Each finding has a
stable number (F1, F2, …) — commit messages, code comments, and the spec
cite them by number, so **numbers are never reused or renumbered**. New
findings append at the end.

Companions: [PROTOCOL.md](PROTOCOL.md) (the normative spec),
[DECISIONS.md](DECISIONS.md) (why the protocol is shaped the way it is).

Environment for all measurements unless noted: macOS 26.5 (arm64),
Node v24.11.0, APFS, local disk, Chrome 150. Host at defaults
(fs.watch + 5 ms hot poll).

## Headline measurements

Goal: does the terminal feel live? Budget ≈ 50 ms keystroke→echo RTT.

RTT legs reported by the bench: `up` = client commit → host read;
`host` = host processing; `down` = host append → client read.

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

## Findings (2026-07, macOS)

### F1 — held-fd appends are invisible to watchers

Appending to out.log through a long-held fd produced almost no FSEvents;
watchers saw the write only at file close or seconds of coalescing later.
Fix: host does open/append/close per write **and** bumps `out.sig` via
temp+rename — renames generate immediate, reliable events. With either fix,
event latency at the FS layer is ~0 ms. → [D1](DECISIONS.md#d1--events-are-wakeups-not-messages),
[D3](DECISIONS.md#d3--rename-committed-doorbell-outsig)

### F2 — Node fs.watch adds ~50 ms

libuv registers its FSEvents stream with 50 ms latency, quantizing every
watch-driven leg to ~50 ms (p50 ≈ 50.6 RTT). The transport floor is far
lower: 1 ms polling gives p50 1.35 ms RTT (sub-ms per leg). Conclusion:
**wakeup strategy, not the filesystem, is the entire latency budget.**
→ [D4](DECISIONS.md#d4--hybrid--adaptive-notification)

### F3 — hybrid notifier wins

Watch events for idle efficiency + a 5 ms hot poll while a session is
active → p50 5.5 ms RTT, p95 11 ms. Well inside the 50 ms terminal budget,
with zero idle cost. Both host and clients now default to this.
→ [D4](DECISIONS.md#d4--hybrid--adaptive-notification)

### F4 — payload size is irrelevant at stdio scale

4 KB pings cost the same as empty ones (p50 5.38 ms).

### F5 — end-to-end shell works

spawn → DATA both ways → CTL close → status transitions verified over the
protocol (pipes; pty untested until node-pty is installed).

### F6 — Chrome's FileSystemObserver delivers on a fixed ~300 ms cadence

(Refined by the observer lab.) Isolated events — file create/write, dir
create/remove — arrive at almost exactly 299–300 ms; a 20-mkdir burst
coalesces into ~2 callback batches at the same cadence; yet a fresh
observer's *first* event can arrive in 12 ms. So the ~300 ms is a batching
timer, not transport latency, and no amount of churn-shaping fixes it.
End-to-end confirmation (observer lab part D, host in a $HOME dir, safety
poll disabled): isolated echo pings land at p50 300 ms — and one of 15 took
3.1 s (ten cadence cycles) while none were lost, so observer delivery can
also *gap* for seconds. Clients MUST keep a safety poll even in
observer-assisted modes. Design consequence: **adaptive notification** —
observer as idle sentinel (zero cost, ≤300 ms wake-from-idle, bounded
anyway by the safety poll), hot poll only while traffic flowed in the last
2 s. Browser clients default to this (`mode: "adaptive"`).
→ [D4](DECISIONS.md#d4--hybrid--adaptive-notification)

### F7 — browser chunk commit costs ~68 ms, and it is entirely `close()`

Confirmed by the write microbench (Chrome 150, 50 files × 64 B):
open 0.4 ms · createWritable 0.3 ms · write 0.3 ms · **close 67.7 ms**
(p95 73.8). Matches the live `up` leg (p50 70.8 ms). This is consistent
with Chrome's Safe Browsing after-write checks on every commit into a
user-visible directory (final attribution: rerun with Safe Browsing set to
"No protection"). Unlike F1/F2/F6 this cannot be polled away — it is the
browser uplink floor for *file-based* chunks; see F10.
→ [D5](DECISIONS.md#d5--dirname-fast-lane-for-small-uplink-batches)

### F8 — peers must not contend for the same files

Browser-side recursive session deletion raced with host writes (doorbell
renames, status.json) and failed with `InvalidModificationError`. Rule
adopted: **every file has exactly one writer, and cleanup has exactly one
owner** — the host (the side with POSIX semantics). Client `close()` just
sends CTL `close` and stops watching; the host deletes the session dir
~500 ms later, and GCs stale exited sessions (>60 s) on adoption.
→ [D6](DECISIONS.md#d6--one-writer-per-file-one-cleanup-owner)

### F9 — `observe()` refuses on directories under /tmp (macOS)

Solved by the observer lab differential: the full observe() matrix
(3 handles × recursive on/off) succeeds for a folder under `$HOME` and
fails with `InvalidModificationError` for the same code against `/tmp/...`
— almost certainly the `/tmp → /private/tmp` symlink. Clean Chromium repro
candidate. Spec rule stands regardless: observer startup failure MUST
downgrade to polling, never be fatal. (Practical corollary: don't demo out
of /tmp.) → [D7](DECISIONS.md#d7--observer-failure-downgrades-to-polling)

### F10 — the dirname fast lane works: 5.3 ms RTT from the browser

Encoding small frame batches as created directory *names* drops the web
uplink from p50 69 ms to 2.8 ms — confirming that Chrome's after-write
scan hooks file commits but not directory creation. Adopted as a
first-class uplink: batches ≤180 raw bytes take the dirname lane
(keystrokes, control, acks); larger batches take file chunks (pastes,
uploads). Both share one sequence space, so ordering is preserved across
lanes. Browser clients default to this (`uplink: "auto"`).
→ [D5](DECISIONS.md#d5--dirname-fast-lane-for-small-uplink-batches)

### F11 — `getFile()` snapshots go stale under live writes

If the host appends to out.log between the client's `getFile()` and the
actual read, Chrome throws `NotReadableError` ("modified after a reference
was acquired"). Under interactive pty output this is routine, not
exceptional. Spec rule: readers MUST treat snapshot-read failures as
transient — the offset hasn't advanced, so the next wakeup simply
re-reads. → [D8](DECISIONS.md#d8--snapshot-read-failures-are-transient)

### F12 — ack-window flow control works over files

Motivating incident: a `find .` in the web terminal produced a 60 MB
out.log with nothing slowing the pty down. With segmented logs +
cumulative acks: a 32 MB flood (3 M lines) against a deliberately lazy
consumer delivered every line, peaked at 8 MB on disk (≤2 segments), and
the host cleanly oscillated pause(4 MB unacked)/resume(ack) throughout.
Sustained throughput ≈ 2.6–3.7 MB/s through the file transport — plenty
for terminal scrollback. Reproduce: `node packages/bench/firehose.mjs <dir>
--lines 3000000 --slow`.
→ [D9](DECISIONS.md#d9--segmented-log-with-cumulative-ack-flow-control)

## Open measurements

- Safe Browsing on vs. off (final F7 attribution).
  → [#11](https://github.com/dglazkov/fsio/issues/11)
- Dirname-lane throughput under sustained typing/paste load.
  → [#4](https://github.com/dglazkov/fsio/issues/4)

## Reproduce

```sh
npm run host -- /tmp/fsio-bench --fresh                 # terminal 1
npm run bench -- /tmp/fsio-bench --count 500            # terminal 2
npm run bench -- /tmp/fsio-bench --poll 5               # polling variant
npm run bench -- /tmp/fsio-bench --poll 5 --uplink dirname
# browser: npm run serve → http://localhost:8765/web/ → pick /tmp/fsio-bench
# (not /tmp for observer tests — see F9)
node packages/bench/firehose.mjs /tmp/fsio-bench --lines 3000000 --slow  # F12
```
