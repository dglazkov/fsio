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
| web client | adaptive 5ms, file up | 200 | 0 | 64.30 | 90.50 | 196.30 | 225.70 |
| web client | adaptive 5ms, file up, Safe Browsing OFF | 200 | 0 | 2.90 | 5.10 | 10.60 | 19.50 |

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
(p95 73.8). Matches the live `up` leg (p50 70.8 ms).

**Attributed: it is Safe Browsing.** A/B against
`chrome://settings/security` (2026-07-26, Chrome 150, same machine,
[#11](https://github.com/dglazkov/fsio/issues/11)):

| Safe Browsing | close p50 | p95 | min | max (ms) |
|---|---|---|---|---|
| Standard protection | 75.0 | 101.3 | 66.2 | 204.9 |
| No protection | **1.3** | 2.1 | 0.9 | 13.1 |

Open/start/write stayed sub-millisecond in both runs; only `close()`
moved, by ~58×. The live echo bench over the file uplink moved with it:
RTT p50 90.5 → 5.1 ms, up leg p50 87.1 → 2.4 ms — with protection off,
the file lane lands within ~2× of the dirname lane (F10). So the file
uplink floor is Chrome's Safe Browsing after-write check, entirely.
Unlike F1/F2/F6 it cannot be polled away, and "turn off Safe Browsing"
is not a deployable answer — the floor stands for *file-based* chunks at
default browser settings; see F10. Also the clean-repro basis for the
Chromium conversation in
[#9](https://github.com/dglazkov/fsio/issues/9).
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
— almost certainly the `/tmp → /private/tmp` symlink. Confirmed
(2026-07-26) by a dependency-free standalone page
([packages/web/repro/observer-tmp.html](../packages/web/repro/observer-tmp.html)):
all five observe() variants (dir/subdir/file × recursive) succeed under
`$HOME` and all five throw `InvalidModificationError` under `/tmp` — same
code, same gesture, only the path differs. That page is the Chromium bug
attachment ([#9](https://github.com/dglazkov/fsio/issues/9)). Spec rule
stands regardless: observer startup failure MUST downgrade to polling,
never be fatal. (Practical corollary: don't demo out of /tmp.)
→ [D7](DECISIONS.md#d7--observer-failure-downgrades-to-polling)

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

### F13 — dirname lane under sustained load: typing never leaves it; floods self-batch onto the file lane and win anyway

Workbench throughput lab (2026-07-26, Chrome 150, adaptive 5 ms,
uplink auto):

- **Paced** (1 ping / 15 ms × 3 s, 195 pings): RTT p50 6.0 ms · p95
  10.8 · max 13.4; **207/207 chunks dirname**. Typing-rate traffic stays
  on the fast lane indefinitely — F10's number holds under sustained use.
- **Flood** (400 pings queued back-to-back; queueing itself took 2 ms):
  commit serialization coalesced the queue into **4 chunks** — 3 dirname +
  1 file chunk carrying ~399 messages (≈34 KB, far over the 180 B name
  cap). All 400 answered in 272 ms ≈ **1470 msg/s round-trip**; per-message
  p50 250 ms; max `in/` backlog **3 chunks**. The F7 cost amortizes over
  the batch: bulk throughput is good *because* the flood falls off the
  fast lane into one big file commit.
- **Paste-sized** (5 × 4 KB filler, serial): RTT p50 80.7 ms — the F7
  `close()` floor, as expected; max 239 ms (scan variance).

Design consequence: the auto lane's size threshold plus serialized commits
are **self-regulating** — no chunk-credit backpressure was needed even
under flood (spec open question 2's "self-throttles" is now measured, not
assumed: backlog never exceeded 3). Paste UX wants local-echo masking
([#10](https://github.com/dglazkov/fsio/issues/10)), not lane changes.
→ [D5](DECISIONS.md#d5--dirname-fast-lane-for-small-uplink-batches)

### F14 — a CDP synthesized directory drop mints a real (read-only) directory handle; the picker itself has no automatable answer

Measured with Playwright 1.62 driving Chrome for Testing 151.0.7922.34
(stable Chrome on the same box was 150.0.7871.187), spike for
[#19](https://github.com/dglazkov/fsio/issues/19). The three picker-bypass
routes, in the issue's preference order:

- **Fake-picker flag** — absent. Grepped the CfT binary: no
  `--use-fake-ui-for-file-system-access`. Chrome only fakes File System
  Access in `content_shell`/web-tests.
- **CDP `Page.setInterceptFileChooserDialog`** — dead in Chromium 151. The
  event fires for `showDirectoryPicker()` but carries **no `backendNodeId`**
  (there is no `<input>`), so `DOM.setFileInputFiles` has nothing to target
  and the picker aborts (`AbortError: Intercepted by …`).
- **CDP `Input.dispatchDragEvent` with `{files:[path]}`** → 
  `DataTransferItem.getAsFileSystemHandle()` → **mints a real
  `FileSystemDirectoryHandle`.** Verified headed **and** headless: it
  enumerates entries, reads files, and sees **live host writes** (host
  rewrote `out.sig` after the handle existed; the page read the new value).

The minted handle is **read-only**: `queryPermission({mode:"readwrite"})`
returns `"prompt"`. So this route alone drives the **downlink** direction
(host writes → browser observes, e.g. F6) with zero permission — but not
the write-heavy client (see F15).
→ downlink drift half of
[#22](https://github.com/dglazkov/fsio/issues/22); mechanism for the
harness [#21](https://github.com/dglazkov/fsio/issues/21).

### F15 — browser write access is gated per session and cannot be automated; one gesture unlocks the whole session

Same rig as F14. The write grant is a **designed invariant**, not an
unautomated gap — every lever preserves it:

- **No CDP descriptor.** `Browser.setPermission` rejects `file-system` and
  `file-handling` (`Invalid PermissionDescriptor name`).
- **No policy allow.** The CfT binary exposes only
  `DefaultFileSystem{Read,Write}GuardSetting` (ask/block) and
  `FileSystem{Read,Write}AskForUrls` (force-*ask*) — there is no
  allow-list. Policy cannot silently grant filesystem write.
- **Persistent "Allow on every visit" does not silently reactivate across
  process launches.** After granting once (headed, one human click), a
  **new process** on the same persistent profile — even with the handle
  restored from IndexedDB (the canonical flow) — returns
  `queryPermission → "prompt"`, and `requestPermission({readwrite})` stayed
  **unresolved past 8000 ms with no human** (i.e. a prompt was on screen).
- **Within a session, one grant covers everything.** After the click, a
  second handle showed `queryPermission → "granted"` and
  `requestPermission → "granted" in 0 ms`.
- **Headless auto-denies:** `queryPermission → "denied"` (matches #19's
  "headed under xvfb" note).

Consequence: unattended browser **write** — F7 `close()` cost, F10 dirname
uplink — is impossible on stable/CfT Chrome by design. The cost falls
*exactly* on the browser-only platform truth; everything unattended-able is
served by a no-write path (client logic via #17's node shim; downlink via
F14; OPFS). Each verification session costs **one human gesture**, after
which the agent drives unattended — the basis for the one-click harness
[#21](https://github.com/dglazkov/fsio/issues/21) and why the uplink drift
job [#22](https://github.com/dglazkov/fsio/issues/22) can't run on
ephemeral CI.

## Open measurements

- ~~Safe Browsing on vs. off (final F7 attribution).~~ Measured
  2026-07-26: `close()` p50 75.0 → 1.3 ms with protection off; F7
  attributed — table under F7.
  → [#11](https://github.com/dglazkov/fsio/issues/11)
- ~~Dirname-lane throughput under sustained typing/paste load.~~ Measured
  2026-07-26 → F13 (typing: p50 6 ms all-dirname; flood: 1470 msg/s
  self-batched; backlog ≤3).
  → [#4](https://github.com/dglazkov/fsio/issues/4)

## Reproduce

```sh
npm run host -- /tmp/fsio-bench --fresh                 # terminal 1
npm run bench -- /tmp/fsio-bench --count 500            # terminal 2
npm run bench -- /tmp/fsio-bench --poll 5               # polling variant
npm run bench -- /tmp/fsio-bench --poll 5 --uplink dirname
# browser: scripts/dev.sh → http://localhost:8765/ → pick ~/fsio-demo
# (not /tmp for observer tests — see F9)
node packages/bench/firehose.mjs /tmp/fsio-bench --lines 3000000 --slow  # F12
```
