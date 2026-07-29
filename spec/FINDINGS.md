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
([packages/workbench/repro/observer-tmp.html](../packages/workbench/repro/observer-tmp.html)):
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

### F16 — FileSystemObserver is not throttled in hidden tabs; adaptive mode degrades to observer cadence in the background and recovers instantly

Background lab (`npm run bg-lab`, 2026-07-29, CfT 151.0.7922.34, Safe
Browsing off, macOS): 1 Hz host-stamped stream through a pty-less shell;
tab hidden for 8 min (crossing Chrome's 5-min intensive-throttling
boundary); delivery latency = page receipt − host stamp, same machine.
Backgrounding verified per sample via `document.visibilityState` (100%
hidden).

Delivery latency (ms), mode=adaptive (observer sentinel + 5 ms hot poll):

| regime | n | p50 | p95 | max |
|---|---|---|---|---|
| foreground | 31 | 3 | 7 | 7 |
| bg 0–60 s | 60 | 376 | 662 | 702 |
| bg 60 s–5 min | 239 | 354 | 674 | 702 |
| bg >5 min | 179 | 354 | 676 | 703 |
| recovery | 31 | 4 | 7 | 216 |

Observer-only mode measured the same background distribution (p50
351–353 ms) — i.e. **backgrounded adaptive IS observer mode**: the hot
poll's timers get clamped, but observer callbacks keep firing at the F6
~300 ms cadence through the entire intensive-throttling regime. The
predicted stall shape (1 s clamp → 1/min collapse, ack starvation, pty
pause) never materialized at this stream rate; recovery after refocus was
first-delivery-in-329 ms with zero backlog. **No mitigation needed for
tab backgrounding** — D4's observer-as-idle-sentinel is also the
background-survival mechanism, for free.

Caveats: 1 Hz is a light stream — a flood in the background (budget
exhaustion, tab freezing, 4 MB ack window) is unmeasured; sleep/wake is
the remaining cooperative leg
([#42](https://github.com/dglazkov/fsio/issues/42)). Method note for
future agent-driven runs: an attached Playwright/CDP automation session
force-emulates focus (covered tabs stay `visible`, timers unthrottled),
and Playwright's default switches include
`--disable-background-timer-throttling` — background measurements are
only valid from a manually-spawned stock Chrome, driven via
`connectOverCDP`, with the connection **dropped** during measurement
phases (scripts/harness-rig.mjs `detachable`).
→ F6, [D4](DECISIONS.md#d4--hybrid--adaptive-notification),
[#42](https://github.com/dglazkov/fsio/issues/42)

### F17 — the 5 ms hot poll costs ~52% of a core across three processes; the FSA brokering burn lands in the browser process

Same rig and runs as F16, native `ps` sampling of the full Chrome process
tree every 5 s (a DevTools profile of the tab undercounts by
construction — the broker does not run in the renderer). Streaming 1
line/s, %CPU mean over each 30 s+ phase:

| mode / phase | browser | renderer | gpu | fsio-host |
|---|---|---|---|---|
| adaptive, foreground | 38.0 | 13.5 | 0.9 | 3.0 |
| adaptive, hidden (throttled) | 2.7 | 1.0 | 0.1 | 6.8 |
| observer-only, foreground | 4.5 | 1.9 | 1.8 | 5.2 |

- The hot-poll burn is real and mostly *outside* the renderer: ~38%
  browser-process CPU for ~200 wakeups/s × ≥2 FSA reads each. The
  storage-service utility process stayed at ~0% — on macOS the FSA
  brokering cost lands in the **browser process** itself.
- Observer-only delivers ~350 ms latency (F6) at roughly **10× less
  browser-process CPU** — the latency/burn trade D4 buys with the 2 s
  activity gate, now with numbers on both axes.
- Chrome's own background throttling cuts the adaptive stack to
  2.7%/1.0% — what a visibility-aware cadence would save is bounded by
  the same numbers.
- D4's "zero idle cost" claim remains unmeasured on this axis: these are
  *streaming* numbers; the idle ×N-session matrix and `pollMs` sweep are
  [#43](https://github.com/dglazkov/fsio/issues/43)'s remaining half.
→ [D4](DECISIONS.md#d4--hybrid--adaptive-notification),
[#43](https://github.com/dglazkov/fsio/issues/43),
[#42](https://github.com/dglazkov/fsio/issues/42)

### F18 — idle sessions cost ~0.75%/session in Chrome (linear to ×8) and more in the host; the pollMs curve; the wake loop self-saturates at pollMs ≈ wake duration

Cost lab (`npm run cost-lab`, 2026-07-29, CfT 151.0.7922.34, Safe
Browsing off, macOS/arm64). Method: one knob per cell, cost = CPU-*time*
delta over a 60 s cell (macOS `ps %cpu` is a decaying average, too
smeared for idle magnitudes), reported relative to a zero-session
baseline (page connected, reporter running: browser 1.30%, renderer
0.72%).

**Idle matrix** (echo sessions, adaptive 5 ms, no traffic; Δ = minus
baseline, %CPU):

| cell | Δbrowser | Δrenderer | host |
|---|---|---|---|
| idle ×1 | 0.63 | 0.12 | 5.61 |
| idle ×8 | 4.63 | 1.52 | 16.54 |
| idle ×8 hidden | 2.36 | 0.30 | 18.47 |

- D4's "zero idle cost": measured ≈ **0.75% of a core per idle session**
  browser-side (observer watch + 2 safety wakes/s × ~6 brokered ops),
  and it is **exactly linear** (×1: 0.75, ×8: 0.77%/session) — #34's
  8-tab wall costs ~6% visible, ~2.7% hidden (the 1 s background clamp
  on the safety poll, F16).
- The *host* is the bigger idle burner: ~2–5% native CPU per session
  (its own per-session polling). Worth its own pass if idle N grows.

**pollMs sweep** (1 Hz stream held constant; latency from a 100-ping
bench in the same config):

| config | browser | renderer | wakes/s | µs CPU/wake | rtt p50 | p95 (ms) |
|---|---|---|---|---|---|---|
| adaptive 5 ms | 42.65 | 15.39 | 204 | 2838 | 5.20 | 10.70 |
| adaptive 15 ms | 25.00 | 9.18 | 72 | 4758 | 14.80 | 19.40 |
| adaptive 50 ms | 12.74 | 4.51 | 25 | 6884 | 49.90 | 53.10 |
| poll-pinned 5 ms | 42.73 | 15.39 | 202 | 2883 | 5.50 | 10.80 |
| saturation probe 1 ms | 47.76 | 17.24 | 254 | 2556 | 6.80 | 9.20 |

- RTT p50 ≈ pollMs across the sweep; 15 ms nearly halves the burn
  (58% → 34% Chrome-side) for +10 ms RTT — still under one display
  frame. The default (5 ms, chosen on the latency axis alone, F2) sits
  at this machine's saturation edge.
- **Self-saturation, confirmed:** at pollMs 1 the client reaches only
  254 wakes/s — the wake itself takes ~4 ms, and the `#wake`
  re-entrancy guard degrades by *skipping wakes*, so RTT rises (6.8 ms)
  instead of CPU running away. Structural consequence for slow machines:
  the RTT floor is the wake *duration*, CPU pegs near one core's worth
  of wake work, and sub-wake-duration pollMs values buy nothing.
- Adaptive ≡ poll-pinned under a continuous stream (42.65 vs 42.73%):
  the observer's ~10× saving (F17) is entirely an idle-state effect.
- **Portable constant:** ~2.8 ms CPU per wake at full rate ≈ **~0.5 ms
  CPU per brokered FSA op** (idle cells cross-check: 12 ops/s ≈ 0.75% ≈
  0.6 ms/op). Burn on another machine ≈ our wake rate × *its* per-op
  cost; the rate is workload, only the constant is hardware.

Unmeasured, deliberately deferred: package power (`powermetrics`, needs
sudo — the cooperative leg kept open in
[#43](https://github.com/dglazkov/fsio/issues/43)); GC/heap churn (no
observed jank to chase).
→ [D4](DECISIONS.md#d4--hybrid--adaptive-notification), F16, F17,
[#43](https://github.com/dglazkov/fsio/issues/43),
[#34](https://github.com/dglazkov/fsio/issues/34)

### F19 — `observe()` can stall for tens of seconds without rejecting; a stall is not a refusal

First observed 2026-07-29 (stock Chrome 150.0.0.0, macOS, terminal-demo
cooperative run — the #58 loop's first click), and **recurring**: the
same run's later passes tripped the 2 s guard on every reattach in one
tab (three downgrades in 15 s of clicking) while other tabs' observers
settled fine — so the stall is common enough that observer startup can
never sit on the session-init path. Original timeline: on the
first session after a fresh picker grant, `FileSystemObserver.observe()`
on the just-created session dir neither resolved nor rejected for
**~49 s**, then resolved. Timeline pinned by three independent clocks:
spawn.json committed and answered at 20:04:37 (host log; the response
and the shell's prompt bytes on disk in `out.00000000.log`), the page's
8 s ready-timeout fired at 20:04:45, and the `close` notification —
queued behind the same await — reached the host at 20:05:26. Everything
gated on the stalled await (`ready`, the uplink pump, heartbeats);
everything not gated on it worked the whole time (status reads, and
frame delivery via the hot-poll that a queued resize had armed). The
same page spawned a second session 4 s after the stall broke:
`observe()` settled instantly. Not a blanket Chrome-150 regression —
the cost lab (F18, CfT 151, one day earlier) ran 8 adaptive sessions
with working observers.

Unmeasured: reproduction rate, the trigger (first-observe-after-grant?
concurrent native writes during setup? profile state?), and whether the
49 s is a fixed internal timeout. Worth a targeted probe page if it
recurs (the F9 repro-page pattern).

Consequence shipped with the observation: observer startup no longer
gates session init at all — timers start first, the observer is adopted
when (if) `observe()` settles, and a rejection or a stall past
`observeSettleMs` (default 2 s) downgrades to polling exactly as a
refusal would, disconnecting the straggler if it ever settles. D7's
rule gains the stall case: *an observer that won't start — loudly or
silently — is a downgrade, never fatal.*
→ [D7](DECISIONS.md#d7--observer-failure-downgrades-to-polling), F6, F9,
[#58](https://github.com/dglazkov/fsio/issues/58)

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
npm run bg-lab   # F16/F17 (one grant click; ~18 min; raw JSON beside ~/.fsio-harness)
```
