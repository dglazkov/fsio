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

Addendum 2026-07-29 (same day, later — the
[#34](https://github.com/dglazkov/fsio/issues/34)/#64 cooperative run,
same machine, stock Chrome 150.0.0.0): the stall is no longer
intermittent here. Every surviving client log from the run's two shared
folders shows the fallback — 6× the 2 s guard, 1× an immediate
`AbortError` from `observe()`, plus 4/4 fallbacks independently
tallied from a second folder's logs; **zero observer settles observed
across ~11 sessions**. The reproduction-rate question above has an
answer for this environment: effectively always. Sessions ran entirely
on the D16 hot-poll (15 ms) and the demo felt fine — including a
full-TUI `claude` CLI session — which is itself a measured consequence:
the poll floor carries the product experience alone. The targeted probe
page is now worth building; the trigger question (profile state? handle
count? grant age?) is still open.

Consequence shipped with the observation: observer startup no longer
gates session init at all — timers start first, the observer is adopted
when (if) `observe()` settles, and a rejection or a stall past
`observeSettleMs` (default 2 s) downgrades to polling exactly as a
refusal would, disconnecting the straggler if it ever settles. D7's
rule gains the stall case: *an observer that won't start — loudly or
silently — is a downgrade, never fatal.*
→ [D7](DECISIONS.md#d7--observer-failure-downgrades-to-polling), F6, F9,
[#58](https://github.com/dglazkov/fsio/issues/58)

### F20 — a persisted handle with "Allow on every visit" spans browser restarts; revisit is zero-gesture

Measured 2026-07-29 (stock Chrome 150, macOS, the #58 cooperative loop):
the terminal-demo page stashes the picked `FileSystemDirectoryHandle` in
IndexedDB and calls `queryPermission({mode: "readwrite"})` on every
load. Across ~16 page loads in ~90 minutes — including the first load
after a full Chrome quit-and-relaunch — every single load read
`"granted"` and reconnected with **zero clicks and zero prompts**. The
one-click `requestPermission` fallback (needs a user activation, F15)
never had to fire on this profile after the user chose "Allow on every
visit" at the original picker grant. Revisit UX consequence: the wizard
is a first-run-only artifact; after that the folder grant behaves like
an installed capability.

Unmeasured: what plain "Allow" (not every-visit) yields across
restarts; whether Chrome's usage-based permission expiry eventually
decays the grant (worth a check-in weeks, not days); profile-to-profile
variance.

Addendum 2026-07-29 (the [#67](https://github.com/dglazkov/fsio/issues/67)
hub lab, same machine, stock Chrome 150): the durability mechanism is
now correctly attributed — **the picker prompt is a plain allow and its
grant is session-scoped; the three-option prompt ("Allow this time /
Allow on every visit / Don't allow") is offered only by
`requestPermission()` over a restored handle.** Two freshly-picked
origins both dropped to `"prompt"` at the first ⌘Q-relaunch; after
choosing every-visit at the re-prompt, both held `"granted"` across a
subsequent restart with zero gestures. So this finding's original
"chose every-visit at the picker grant" wording was mistaken — the #58
flow must have routed through a re-prompt at some point. Wizard
consequence → F21: a first-run flow MUST deliberately trigger one
`requestPermission` re-prompt to mint the durable grant; the picker
alone cannot.
→ F15, F21, [#58](https://github.com/dglazkov/fsio/issues/58)

### F21 — two origins hold independent grants on one directory; the broker splits throughput fairly; the durable grant is minted at the re-prompt, not the picker

Measured 2026-07-29 (stock Chrome 150, macOS, the
[#67](https://github.com/dglazkov/fsio/issues/67) cooperative run —
D19's gating lab). Rig: `scripts/hub-lab.mjs` +
`packages/workbench/repro/hub-multiorigin.html`; two localhost ports =
two origins, both granted readwrite on the same `~/fsio-hub-lab`. Safe
Browsing is off on this profile, so absolute `close()` numbers are the
F7-off regime; the comparisons are the data.

- **Grants coexist and are fully independent.** Both origins picked and
  held readwrite simultaneously. `chrome://settings/content/filesystem`
  lists each (origin, folder) row separately; removing 8871's row
  dropped that origin to `"prompt"` on next load while 8872 stayed
  `"granted"` — and the revoked origin's *persisted handle still
  worked*: one click re-granted.
- **Concurrent writes don't interfere; broker throughput is conserved
  and split fairly.** Solo: 3,993 ops / 30 s (133 ops/s), close p50
  3.5 ms. Concurrent (28.8 s overlap): 53 + 74 ≈ 127 ops/s combined at
  close p50 2.9–3.0 ms (the 53 carries a partial-hidden-tab caveat).
  **Zero errors across ~8,600 committed writes** in all cells.
  Cross-origin reads of a live-rewritten beacon file: 753 clean, 3
  transient stale-snapshot failures (the F11 class), 30 before the
  other side started. One ~975 ms `close()` outlier hit both origins at
  the same moment — a shared broker stall, tail only.
- **Restart persistence is per-origin and depends on how the grant was
  minted — the picker never offers the durable option.** Both origins'
  initial picker grants died with the Chrome process (both `"prompt"`
  after ⌘Q-relaunch, independently). The three-option prompt ("Allow
  this time / Allow on every visit / Don't allow") appeared only on
  `requestPermission()` over the restored handle; after choosing
  every-visit on both, a second full restart returned `"granted"` on
  load for both, zero gestures (F20 addendum).
- **Explicit revocation downgrades the re-prompt.** After removing an
  origin in settings, its `requestPermission()` showed the *plain*
  allow prompt — no every-visit option. So the durable option is
  offered for grants that expired with the session, but not (at least
  immediately) after a user revoked one — a re-granted-after-revocation
  origin is presumably back to session-scoped until proven otherwise.

Consequences for D19: the hub model's multi-origin assumption **holds**
— the spec chapter can namespace by client/session without per-origin
subdirs (co-writer contention is a posture question, not a platform
one), and the first-run wizard MUST route through one
`requestPermission` re-prompt to mint the durable grant (picker alone
is session-scoped). Unmeasured: durability of a post-revocation
re-grant across restarts; >2 origins; weeks-scale grant decay (F20's
open caveat).
→ [D19](DECISIONS.md#d19--the-hub-pivot-one-transport-folder-as-a-socket-workspaces-as-resources),
F7, F8, F11, F20,
[#67](https://github.com/dglazkov/fsio/issues/67); feeds
[#70](https://github.com/dglazkov/fsio/issues/70) (spec chapter),
[#69](https://github.com/dglazkov/fsio/issues/69) (wizard).

### F22 — the host's idle burn is the hot-poll gate: alive-gated 5 ms scans cost ~60% of a core at 32 idle sessions; idle-gated machinery ~3%; one recursive watcher ~2% with 14 ms wakes

Measured 2026-07-29 (macOS/arm64, node v24.11.0;
`node scripts/hub-scan-lab.mjs`; [#68](https://github.com/dglazkov/fsio/issues/68)
— the D19 hub track's second gate, and F18's deferred host-cost pass).
Method: CPU-time delta over 60 s cells (F18's method), one measured
process per cell, real host CLI at defaults except the named knob.
Idle = N running echo sessions created at the protocol level
(spawn.json bootstrap), zero traffic, no heartbeats (legacy-client
semantics — comparable with F18's pre-D17 numbers).

| config (% of a core) | ×0 | ×1 | ×8 | ×32 |
|---|---|---|---|---|
| A: host, hot poll 5 ms (shipped default) | 1.15 | 10.4 | 38.0 | 59.7 |
| B: host, `--hot 0` (per-dir watchers + 250 ms safety scan) | 0.37 | 0.58 | 1.23 | 3.32 |
| C: probe, ONE recursive watcher + 250 ms scan | — | 0.40 | 0.83 | 1.93 |

- **Mechanism, located in code.** The host's hot poll is gated on
  `started && !done` — session *liveness*, not traffic
  (`host-server.ts` `start()`). N idle-but-running sessions keep the
  5 ms × O(N) `scanOnce()` loop hot forever; the browser client's D4
  activity gate (hot only while traffic flowed in the last 2 s) was
  never ported to the host. F18's "~2–5% native per session" is this,
  remeasured: Δ/session 9.3% (×1) → 4.6 (×8) → 1.8 (×32) — sublinear
  because the scan loop self-saturates exactly like the client's wake
  loop (F18): a 32-session scan costs ~4.7 ms p50, capping the
  effective rate near ~130 scans/s.
- **Idle-gated machinery is ~18× cheaper.** `--hot 0` prices what the
  burn was hiding: 2N+1 per-dir `fs.watch` instances + 250 ms safety
  scans ≈ 0.09%/session at ×32.
- **The fsiod-shaped loop is ~40% cheaper again and wakes faster.**
  One recursive `fs.watch` on `sessions/` + the identical 250 ms scan
  ≈ 0.06%/session at ×32 — and detected 20/20 idle chunk drops at
  **p50 14 ms, max 64 ms**, well under F2's ~50 ms per-dir libuv
  quantization. Recursive FSEvents is both the cheap option and the
  fast one.
- **Safety-scan scaling bound.** Full-scan cost ~717 µs (×1) →
  4.7 ms (×32) ≈ ~140 µs/session; at 4 scans/s the safety scan alone
  nears ~10% of a core around ~180 idle sessions. A hub daemon at that
  scale wants watch-driven dirty-marking instead of full scans;
  nothing measured here forces it below ~100 sessions.

Design constraint delivered to
[#70](https://github.com/dglazkov/fsio/issues/70)/[#71](https://github.com/dglazkov/fsio/issues/71):
fsiod's idle loop = one recursive watcher + 250 ms idempotent safety
scan + a hot poll gated on *recent traffic* (D4's gate, host-side at
last) → idle cost ≈ 0.05–0.1% of a core per session, wake-from-idle
~14 ms p50. Also indicts the shipped one-folder host default — the
gate fix is filed as its own issue.

Addendum 2026-07-30 (the gate fix,
[#73](https://github.com/dglazkov/fsio/issues/73); same machine and
lab, 30 s cells): the host's hot poll is now armed by traffic
(uplink chunks, session adoption, attach bootstraps) and disarmed
after `hotWindowMs` of silence — D4's client-side gate, ported.
Re-measured, with cell B re-run *in the same session* as the control:

| % of a core | ×0 | ×1 | ×8 | ×32 |
|---|---|---|---|---|
| A: `--hot 5` (default), gate fixed | 0.23 | 0.40 | 0.73 | 1.63 |
| B: `--hot 0`, same run | 0.27 | 0.40 | 0.73 | 1.73 |

**A is now B, cell for cell** — which is the whole claim: the default
costs exactly what disabling the hot poll costs, once idle. That
equality is the load-bearing result, because it is measured within one
run. The cross-run headline (A ×32: 59.7% → 1.63%, ~37×) overstates
slightly: this run's B row is also cheaper than 2026-07-29's
(1.73 vs 3.32 at ×32), so the machine was quieter and/or 30 s cells
read low. The price paid is latency, not delivery: the first uplink
chunk after an idle window waits for a watch event (~50 ms, F2) or the
250 ms safety scan (invariant 1), and consuming it re-arms the loop.
→ F2, F18,
[D4](DECISIONS.md#d4--hybrid--adaptive-notification),
[D19](DECISIONS.md#d19--the-hub-pivot-one-transport-folder-as-a-socket-workspaces-as-resources),
[#68](https://github.com/dglazkov/fsio/issues/68); feeds
[#70](https://github.com/dglazkov/fsio/issues/70),
[#71](https://github.com/dglazkov/fsio/issues/71).

### F23 — child confinement is transitive to any depth and cannot be re-entered in either direction; setuid binaries become unexecutable

Measured 2026-07-31 (macOS 26.5/arm64;
`node scripts/confinement-lab.mjs --launchd`;
[#86](https://github.com/dglazkov/fsio/issues/86) OQ6 — "transitive
confinement, or a stated limit?"). Method: the shipped profile
(`packages/terminal-demo/src/profile.ts`) and the shipped argv shape
(`sandbox.ts` `sandboxArgv` — the invocation sessions really use, D12's
no-drift discipline), a scratch ROOT, and a canary directory named in **no**
`-D` parameter. Every case asks one question: did a file appear at the
canary path? **8 escape attempts, 0 escapes.**

| attempt | result |
|---|---|
| direct child writes outside ROOT (baseline) | confined — EPERM |
| grandchild (`sh -c` inside `sh -c`) | confined |
| depth 4 through another interpreter (perl → sh → sh → touch) | confined |
| detached child, parent exits before the write | confined |
| re-enter `sandbox-exec` with `(allow default)` | `sandbox_apply: Operation not permitted` |
| re-enter `sandbox-exec`, same profile, `ROOT=/` | `sandbox_apply: Operation not permitted` |
| `launchctl submit` (launchd spawns for the child) | rc=1, no canary |
| `launchctl bootstrap` of a plist written *inside* ROOT | `Bootstrap failed: 5`, no canary |

- **Transitive by inheritance, at every depth and across detachment.** The
  policy rides the process, so `fork`/`exec` carries it and an orphan keeps
  it. Act 5's mirror hall (an fsio peer spawning the claude CLI as its
  subagent) inherits confinement by construction — R13 is a property, not a
  gap to document.
- **One-shot: `sandbox_apply` fails in the *safe* direction too.** A
  confined process cannot re-enter `sandbox-exec` even to **narrow** itself
  (`(deny default)` → same EPERM). This is the load-bearing result for the
  hub: a profile must be composed into **one** policy and applied by the
  spawner, because no layering is available afterwards, and a nested fsio
  host cannot confine its own children below its own reach — it can only
  pass its confinement down.
- **launchd is not a spawn proxy out.** Both routes an unprivileged child
  has to ask launchd to spawn on its behalf failed under the profile,
  including the realistic one (write the plist into ROOT — which the child
  *may* write — then bootstrap it into `gui/$UID`).
- **setuid/setgid binaries are unexecutable under any Seatbelt profile.**
  `/bin/ps` (4755), `/usr/bin/top` (4555), `/usr/bin/crontab` (4755),
  `/usr/bin/sudo` (4511) all fail exec with EPERM; non-setuid tools
  (`id`, `whoami`, `ssh`, `lsof`) run. The control isolates it to Seatbelt
  rather than to fsio's posture: `/bin/ps` fails identically under
  `-p '(version 1)(allow default)'` and runs unsandboxed. A privilege-
  escalation route is closed for free, and the cost lands on ordinary
  usability — `ps` in a demo shell reports "Operation not permitted", and
  no environment fix reaches it (the R2 lever does not apply here; only
  dropping the sandbox would).
→ [D29](DECISIONS.md#d29--profiles-compose-before-the-spawn-confinement-is-inherited-and-cannot-be-re-entered),
[D22](DECISIONS.md#d22--workspaces-are-session-parameters-resolved-by-a-daemon-private-registry),
[#86](https://github.com/dglazkov/fsio/issues/86); feeds
[#71](https://github.com/dglazkov/fsio/issues/71),
[#77](https://github.com/dglazkov/fsio/issues/77).

### F24 — the wall is a *write* wall: a confined child inherits the host's entire environment (ssh-agent socket included) and reads every file the user can read

Measured 2026-07-31, same lab and run as F23
([#86](https://github.com/dglazkov/fsio/issues/86) OQ4 — "does the read wall
exist, and what does it cost?" — plus the env-policy baseline #86 asked for
as a falsifiable test: not "we intended to scrub", but the bytes the child
got). Canary secrets were exported into the parent and the child's real
`env` was diffed against them.

| what crosses | measured |
|---|---|
| environment variables | **47 of 48** reached the child |
| canary secrets (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, one control) | **4 of 4** reached the child |
| `SSH_AUTH_SOCK` | inherited; `ssh-add -l` inside the sandbox reaches the agent and gets a protocol answer |
| `HOME`, `SHELL`, `TMPDIR`, 21 `PATH` entries | inherited verbatim, including a PATH entry under `~` |
| `~/.ssh/id_ed25519` | readable (411 B) |
| `~/.gitconfig`, `~/.config/gh/hosts.yml`, `/etc/passwd`, every sibling project under `~/Documents` | readable |
| `~/Library/Messages` | denied — **by TCC, not by Seatbelt** |
| network egress (`curl https://example.com`) | HTTP 200, deliberate (the demo allows it: `git pull`, `npm install`) |

- **The honest consent sentence is about writes.** "Sandboxed to this
  folder" is true of modification and false of disclosure: a private key,
  every credential the environment carries, and every sibling repo are all
  in reach, and network egress is on, so read reach *is* exfiltration
  reach. #86's success criterion is "the sentence consent can honestly
  say" — this finding is what makes that sentence checkable, and the spec's
  threat model now states it
  ([What the child sandbox does not bound](PROTOCOL.md#what-the-child-sandbox-does-not-bound)).
- **Env policy has no baseline to improve on — it is pass-everything.**
  Both halves of the R4/R17 program (place child state, then scrub what
  remains) start from zero here; `SSH_AUTH_SOCK` is the sharpest single
  item, because agent forwarding is a *signing capability*, not a
  configuration value.
- **Part of the read wall is already held by someone else.** The
  TCC-protected set (Messages, Photos, Calendar, …) is denied to the child
  without fsio doing anything — the same "do not duplicate a wall another
  party enforces" shape R8 states for the browser's edit boundary, with the
  OS as the other party.
- **Unmeasured, deliberately:** what a read wall would *cost* in practice
  (R2 friction on a real toolchain) — that needs the act-2/act-4 field-test
  re-runs #86 lists, not this lab.
→ F23,
[D20](DECISIONS.md#d20--the-hub-folder-carries-transport-and-advertisement-authority-lives-outside-it),
[#86](https://github.com/dglazkov/fsio/issues/86); feeds
[#71](https://github.com/dglazkov/fsio/issues/71),
[#76](https://github.com/dglazkov/fsio/issues/76),
[#6](https://github.com/dglazkov/fsio/issues/6).

### F25 — a stdio MCP server runs under a deny-default profile in 15 rules, 5 of which are the service's reach; the same server under the shell posture reads everything

Measured 2026-07-31 (macOS 26.5/arm64, node v24.11.0;
`node scripts/service-reach-lab.mjs`;
[#90](https://github.com/dglazkov/fsio/issues/90) act-4 leg, testing
[#77](https://github.com/dglazkov/fsio/issues/77)'s claim that "an MCP
server is narrower than a shell"). Subject:
`@modelcontextprotocol/server-filesystem`, a real stdio MCP server,
deliberately credential-free. Method: build the deny-default profile the
way a profile author would have to — start from nothing, add only rules a
*measured* denial demands (denials read from the unified log; SBPL
`(trace)` no longer produces a file on current macOS). Three rounds of
`deny default` → run → read denials → add.

| | P1 — shell posture (`allow default` + write wall) | P2 — service posture (`deny default`) |
|---|---|---|
| MCP handshake, `tools/list` | ok, 14 tools | ok, **14 tools — identical** |
| read inside workspace | ok | ok |
| `~/.ssh` | reachable | **EPERM** |
| `~/.gitconfig`, `/etc/passwd` | reachable | **EPERM** |
| `~/Documents` (sibling projects) | reachable | **EPERM** |
| DNS / network | reachable | **denied** |
| profile size | 5 rules | 15 rules |

- **#77's claim is true, and the difference is categorical rather than one
  of degree.** The same server, doing the same work with the same 14
  tools, runs with `deny default` and no network at all. That is not
  available to a shell at any profile size — a shell is a universal
  executor, so its allow-list is decoration
  ([#86](https://github.com/dglazkov/fsio/issues/86)'s framing, now with a
  measurement behind it). The unit of the mechanism being a *named
  service* (R10, [D27](DECISIONS.md#d27--reach-attaches-to-the-grant-not-the-workspace))
  is what buys the tighter posture; nothing else in the design does.
- **The profile decomposes, and the per-service part is small.** Of 15
  rules, **9 are node-runtime infrastructure** (`/System/Library`,
  `/usr/lib`, `sysctl-read`, `/dev/urandom`, one `mach-lookup`, …) shared
  by every node-based service, and **5 are this service's reach** — its
  binary, its code, its workspace — of which 3 are parameters. So a
  profile mechanism wants a **runtime base layer plus a per-service
  delta**, composed into one policy before the spawn
  ([D29](DECISIONS.md#d29--profiles-compose-before-the-spawn-confinement-is-inherited-and-cannot-be-re-entered)),
  and the thing a user or consent surface reads is the 5-rule delta, not
  the 15.
- **Two walls fired on the same read, and they are not redundant.** The
  server refused `~/.gitconfig` under *both* postures with its own
  allowed-directories check — an application-level error a driver can
  relay ("Access denied - path outside allowed directories"), which is
  exactly R9's legible-to-a-non-human refusal. Seatbelt refuses the same
  read with `EPERM`. Keep both: the server's wall is *legible but
  bypassable* (it is the server's own code), Seatbelt's is *enforcement
  but opaque*. R8's "do not duplicate a wall another party enforces" needs
  the refinement — do not duplicate another party's wall for
  **enforcement**, but a second wall that exists for **legibility** is
  not duplication.
- **Install-time reach is not run-time reach.** The subject was installed
  with npm before measurement; `npx`-style invocation would need network
  at every start, which is exactly the reach P2 denies. A service profile
  this tight implies the service is *installed*, not fetched per spawn —
  a constraint `fsio expose` (#77) inherits.
- **Unmeasured, and it is the important one:** a *credentialed* server
  (act 4's actual product — the `github` server holding a token). R12
  says the mechanism must tolerate credentials as a deliberate act; this
  subject carries none, so the credential path is untested.
  → [#90](https://github.com/dglazkov/fsio/issues/90)
→ F23, F24,
[D27](DECISIONS.md#d27--reach-attaches-to-the-grant-not-the-workspace),
[D29](DECISIONS.md#d29--profiles-compose-before-the-spawn-confinement-is-inherited-and-cannot-be-re-entered),
[#77](https://github.com/dglazkov/fsio/issues/77),
[#90](https://github.com/dglazkov/fsio/issues/90); feeds
[#71](https://github.com/dglazkov/fsio/issues/71),
[#86](https://github.com/dglazkov/fsio/issues/86).

### F26 — placement moves a child's state but not its identity: the agent CLI's credential lives in the OS keystore, so a deny-default profile silently logs it out

Measured 2026-07-31 (macOS 26.5/arm64, claude CLI 2.1.220;
`node scripts/agent-reach-lab.mjs`;
[#90](https://github.com/dglazkov/fsio/issues/90) act-2 leg). The deliberate
re-run of the organic field test in
[#18](https://github.com/dglazkov/fsio/issues/18#issuecomment-5119402080),
whose accidental result produced "placement over denial" (R4/R17). Subject:
the claude CLI, one headless turn per cell, in a scratch workspace with an
isolated config dir. Denials from the unified log; no credential contents
were read in either location.

| cell | posture | result | distinct denials |
|---|---|---|---|
| 0 | no sandbox, config dir in workspace | ok | 0 |
| A | shipped profile, config dir in workspace (#18's fix) | ok | 2 (both benign) |
| A′ | shipped profile, **default** `~/.claude` | **ok, exit 0** | 7 — incl. `~/.claude/projects/…`, `.claude.json.lock`, `.claude.json.tmp.*` |
| Ak | cell A + `(deny mach-lookup)` | **"Not logged in · Please run /login", exit 1** | 12 — incl. `com.apple.SecurityServer` ×3, `com.apple.securityd.xpc` |
| B | R17 slot (`~/.fsio/state/<ws>/<svc>/`), carve exactly that wide | **"Not logged in", exit 1** — state tree written | 3 (all benign) |
| At | cell A + the agent spawns a child (`Bash(ls)`) | ok | 2 (both benign) |
| C | cell A + synthesized 8-variable environment | **ok — identical** | 2 (both benign) |

- **Placement works, for state.** Pointed at either the in-workspace dir or
  R17's slot, the child writes its whole tree there — config, backups,
  `projects/<ws>/` transcripts, `sessions/`, memory — with **zero
  state-related denials**. R17's carve is exactly wide enough, and needs
  nothing outside itself.
- **Placement does not carry identity, and R17's strongest claim is
  false.** R17 said transcript and token "get the same answer: the slot."
  They do not. The credential lives in the **login Keychain** (item
  `Claude Code-credentials`, created 2025-09-17 — i.e. long before this
  lab); a stale `.credentials.json` sitting in the placed config dir was
  *removed by the CLI during the run* and was never the source of auth. A
  fully-populated slot still reports "Not logged in" (cell B).
- **The keystore is reached by mach-lookup, so a deny-default profile logs
  the child out.** Cell Ak isolates it: denying mach-lookup produces
  `com.apple.SecurityServer` and `com.apple.securityd.xpc` denials and the
  identical "Not logged in" failure. This puts
  [F25](#f25--a-stdio-mcp-server-runs-under-a-deny-default-profile-in-15-rules-5-of-which-are-the-services-reach-the-same-server-under-the-shell-posture-reads-everything)
  in direct tension with act 2: **the tight service posture that makes an
  MCP server safe would silently break a keystore-backed agent.** "Narrow
  the profile" and "let the child keep its credentials" are not
  independent knobs, and #86's conflict list gains one it did not have.
- **The refusal is legible but blames the wrong party.** "Please run
  /login" is exactly R9's relayable, non-human-readable-refusal shape — and
  it is *misleading*: the user who follows it will log in successfully and
  fail again next run, because the cause is the profile, not the session.
  A mechanism that only *applies* policy cannot say this; the host has to
  interpret denials to name the real cause.
- **#18's accident, reproduced exactly — and it is silent.** Cell A′ shows
  the original denial set, and the run still **exits 0 with a correct
  answer**. In headless mode nothing surfaces: the turn succeeds, the
  transcript is simply lost, so resume breaks later with no error at the
  time of the loss. R3 ("a broken confinement must look broken") applies to
  *state placement* too, and today it does not hold.
- **The environment is almost entirely unnecessary.** Cell C ran on 8
  synthesized variables (`PATH`, `HOME`, `TERM`, `LANG`, `USER`,
  `LOGNAME`, `SHELL`, `TMPDIR`) plus `CLAUDE_CONFIG_DIR` and behaved
  identically. None of the other ~39 inherited variables — including
  [F24](#f24--the-wall-is-a-write-wall-a-confined-child-inherits-the-hosts-entire-environment-ssh-agent-socket-included-and-reads-every-file-the-user-can-read)'s
  canary secrets and `SSH_AUTH_SOCK` — are load-bearing for this child.
  Synthesize-then-add is affordable for the act-2 subject, which is the
  concrete answer #71's env-policy slice needed.
- **Transitivity holds on a real workload.** Cell At: the agent used its
  own Bash tool to spawn a child; it stayed confined and succeeded, and the
  CLI's permission layer did not contradict the wall (R6). Every cell also
  shows `forbidden-exec-sugid` (×3–5) — F23's setuid denial, hit by a real
  agent, with no effect on the outcome.

**Method traps, each of which cost a round.** (1) The harness is itself a
Claude Code session exporting 8 `CLAUDE_*` markers; inherited, they steer
the subject — the first A′ run wrote nothing and reported zero denials. The
lab now scrubs `CLAUDE*`/`ANTHROPIC*` before every cell. (2) `log show
--start` parses **local** time; an ISO/UTC stamp puts the window hours in
the future and returns nothing, which reads exactly like "no denials" — the
first three cells all reported 0 for this reason. Same class as F16's
focus-emulation trap: an instrument that fails silently toward the
comfortable answer.
→ F23, F24, F25,
[D29](DECISIONS.md#d29--profiles-compose-before-the-spawn-confinement-is-inherited-and-cannot-be-re-entered),
[#18](https://github.com/dglazkov/fsio/issues/18),
[#90](https://github.com/dglazkov/fsio/issues/90); feeds
[#71](https://github.com/dglazkov/fsio/issues/71),
[#86](https://github.com/dglazkov/fsio/issues/86),
[#76](https://github.com/dglazkov/fsio/issues/76).

### F27 — a read wall costs 21 rules and holds the crown jewels, but the toolchain names its own price: git's identity and npm's cache are exactly what stays readable

Measured 2026-07-31 (macOS 26.5/arm64, node 24.11.0, git 2.50.1;
`node scripts/read-wall-lab.mjs`, ~2 min;
[#90](https://github.com/dglazkov/fsio/issues/90), the leg F25/F26 left open —
[#86](https://github.com/dglazkov/fsio/issues/86) open question 4).
[F24](#f24--the-wall-is-a-write-wall-a-confined-child-inherits-the-hosts-entire-environment-ssh-agent-socket-included-and-reads-every-file-the-user-can-read)
priced what the shipped wall does *not* hold; this prices what closing it
costs. Every width is the shipped profile plus a read wall of increasing
width — the only variable that changes. Rules were added only when a measured
denial demanded one. Subject: the workload act 3 is about — a workspace with a
git repo, a dependency, a compiler and a test.

| | W0 shipped | W1 workspace only | W2 + toolchain | W3 + named user state |
|---|---|---|---|---|
| node runs | ok | **FAIL** | ok | ok |
| read the workspace | ok | **FAIL** | ok | ok |
| compile (tsc) | ok | **FAIL** | ok | ok |
| run tests | ok | **FAIL** | ok | ok |
| `git status` / `git commit` | ok | **FAIL** | **FAIL** | ok |
| `npm ci --offline` | ok | **FAIL** | **FAIL** | ok |
| `~/.ssh` (private keys) | reachable | — | **denied** | **denied** |
| `~/.config`, `~/Documents`, `/etc/passwd` | reachable | — | **denied** | **denied** |
| `~/.gitconfig` | reachable | — | denied | **reachable** |
| `~/.npmrc` + `~/.npm` | reachable | — | denied | **reachable** |
| profile size | 8 rules | 12 | 25 | **29** |

- **The read wall exists and is affordable.** 21 rules over the shipped 8 buy
  a working toolchain with `~/.ssh`, `~/Documents`, `~/.config` and
  `/etc/passwd` all denied — the reach F24 found wide open. #86 worried that
  the shell case produced "a false trade between confinement and utility";
  for act 3's actual workload the trade is real and cheap. **The honest
  consent sentence gets stronger**: not just "writes are limited to this
  folder" but "reads are limited to this folder, your toolchain, and your git
  and npm settings."
- **What survives the wall is exactly the credential-bearing part.** The two
  carve-outs W3 must make are not incidental config. `~/.npmrc` is where a
  registry auth token lives; `~/.npm/_cacache` is a content-addressed store
  of package bodies already fetched, private registries included; `~/.gitconfig`
  routinely carries `[credential]` helpers and `url.*.insteadOf` rewrites. A
  read wall authored from the toolchain's denials converges on *keeping the
  secrets readable and denying the rest* — the opposite of the intuition, and
  it matters most in act 3, where the brain is remote and anything readable
  is anything that leaves.
- **The wall's floor is far above the workspace.** W1 — workspace and scratch
  only, the width the phrase "sandboxed to this folder" implies — does not
  merely fail the toolchain: `/bin/sh` never starts. Denying
  `(literal "/")`, the root directory every absolute path walk reads, aborts
  the process with **SIGABRT before `main()` and no error text at all** (exit
  134, empty stderr; the lab's own denial log named it — one line,
  `file-read-data /`). A too-narrow read wall does not look broken, it looks
  like nothing happened. R3/R18 apply to the read wall, and the failure is
  worse than the write wall's because there is no process left to report it.
- **The runtime lives under `$HOME`.** With a version manager, node is at
  `~/.nvm/versions/node/<v>/` — so "deny `$HOME`" and "run node" are not
  independent knobs. Same shape as F26's keystore collision (narrow the
  profile, log the child out): the profile cannot be authored against a
  mental model in which `$HOME` is user data and `/usr` is the system.
- **Sizing, for the consent surface.** Of W3's 29 rules, 8 are the shipped
  write wall, 4 the workspace and scratch, 13 runtime-and-system
  infrastructure shared by any node service (F25's "base layer" again), and
  **4 are the user state this particular toolchain names**. As with F25, the
  per-subject delta is the small part, and it is the part a consent surface
  has to show (R15).

**Method trap, the third of this class.** Kernel Sandbox denials are stamped
in the unified log when they **flush**, not when they occur, and the lag runs
to several seconds — while a whole width here runs in ~2 s. Unbounded windows
therefore reported one width's denials under the next (`~/.gitconfig` shown as
denied in W3, where git demonstrably worked; `/dev/dtracehelper` carrying a
running total of ×47 then ×97), and tight windows dropped denials the child
had just reported synchronously (W2 showing 1 denial in a cell where git had
printed EPERM). The lab now spaces widths by 10 s, holds each window open 8 s
past its width, and prints every window next to its results so the artifact
can be audited instead of trusted. Same class as F16's focus emulation and
F26's local-time parsing: **an instrument that fails toward a plausible
answer.** Denial counts in the table above are corroborated by the child's own
exit codes, which is the signal that does not depend on the log at all.
→ F23, F24, F25, F26,
[D29](DECISIONS.md#d29--profiles-compose-before-the-spawn-confinement-is-inherited-and-cannot-be-re-entered),
[#90](https://github.com/dglazkov/fsio/issues/90); feeds
[#86](https://github.com/dglazkov/fsio/issues/86),
[#71](https://github.com/dglazkov/fsio/issues/71),
[#74](https://github.com/dglazkov/fsio/issues/74).

### F28 — a second agent keeps its identity *in* its state dir, so placement and login are the same knob; the denial surfaces as a protocol error that names the wrong cause

Measured 2026-08-01 (macOS 26.5/arm64, node 24.11.0, pi-acp 0.0.32 /
`@earendil-works/pi-coding-agent` 0.82.1), spawning the agent exactly as
`packages/acp-demo` does — `sandbox-exec` with the shipped agent profile,
pipes, synthesized environment — and driving two ACP requests per cell:
`initialize`, then `session/new`. No model turn was taken in any cell (no
quota spent, and none needed: the failure lands before inference).

| cell | posture | `initialize` | `session/new` |
|---|---|---|---|
| N | no sandbox, inherited environment | ok | ok |
| E | no sandbox, synthesized 8-variable environment | ok | ok |
| W | write wall (shipped profile), **no state carve** | **ok** | **fails** — JSON-RPC `-32603` |
| Wc | write wall + `~/.pi` carved writable | ok | ok |

- **The identity/state split has a second answer, and it is the opposite
  one.** [F26](#f26--placement-moves-a-childs-state-but-not-its-identity-the-agent-clis-credential-lives-in-the-os-keystore-so-a-deny-default-profile-silently-logs-it-out)
  found the claude CLI's credential in the login Keychain, with its state
  freely placeable. This agent keeps `auth.json` in `~/.pi/agent`, in the
  same directory as `sessions/` and `models-store.json` — so its
  placement variable (`PI_CODING_AGENT_DIR`) moves the credential too, and
  pointing it at an empty slot is indistinguishable from logging out. Two
  subjects, two incompatible postures: **the mechanism cannot hold one
  state policy.** `packages/acp-demo/src/agents.ts` therefore declares
  posture per agent (`place` | `carve`) as a fact about the child, and
  R17's slot becomes the answer for the agents that can use it rather
  than the answer.
- **The denial is loud, and wrong about its cause — R19's second
  instance.** Cell W answers `session/new` with `{code: -32603, message:
  "Internal error: Cannot call write after a stream was destroyed"}`. No
  `EPERM`, no path, no mention of a policy; the same stderr line, and
  nothing else. A page relaying that text tells the human about a stream.
  Compared with F26's cell A′ (exit 0, transcript silently lost) this is
  an improvement bought by *structure*: the write failed inside a request
  the human had made, so the protocol had somewhere to put the error —
  but the cause still has to be supplied by the host, which is the only
  party that knows what it denied.
- **The environment floor holds on a second subject.** Cell E: `PATH`,
  `HOME`, `TERM`, `LANG`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR` — the same
  eight F26 measured — ran the agent identically to full inheritance.
  Synthesize-then-add (R4) is now two-for-two, and `packages/acp-demo`
  ships it as the default rather than inheriting `process.env`.
- **`initialize` proves nothing about a profile.** Every cell passes it,
  including the broken one: the handshake touches no state. A helper that
  preflights an agent by initializing it would report a green chain and
  hand the user a session that dies on its first real request.

**Reproduction.** The mechanism is the repo's: run
`node packages/acp-demo/dist/helper.js <folder>` and drive it with a client
(the B1 suite's rig, or the demo page). Cell W is the shipped code with the
`homeDirs` entry removed from `agents.ts`; cell E is the default, and cell N
requires passing `from` into `synthesizeEnv`.
→ F24, F26,
[D30](DECISIONS.md#d30--acp-is-payload-the-host-frames-the-browser-is-the-client),
[#18](https://github.com/dglazkov/fsio/issues/18); feeds
[#86](https://github.com/dglazkov/fsio/issues/86),
[#71](https://github.com/dglazkov/fsio/issues/71),
[#77](https://github.com/dglazkov/fsio/issues/77).

### F29 — the consent surface fires: 5 permission asks, 10 `fs/*` calls, 2 rejections that wrote nothing — and an `agent_message_chunk` is a fragment, not a line

Measured 2026-08-01 (macOS 26.5/arm64, Chrome; the shipped `/acp` page, the
helper run with `--fixture`, a human answering every card; the page's own
`report.json`). Subject: the **puppet agent**
(`packages/acp-demo/src/fixture-agent.ts`) — a scripted ACP speaker that asks
permission and has no hands, so every file it touches travels as an `fs/*`
request. Written because
[#100](https://github.com/dglazkov/fsio/issues/100) established that no
installed agent exercises this half: pi-acp reads and edits itself and asks
nobody, so the same page measured on the same day scored 52 `session/update`
notifications, 3 prompts, 1 file change, **zero** `session/request_permission`
and **zero** `fs/*`.

| | pi-acp (#100's measurement) | puppet, same page, same day |
|---|---|---|
| `session/request_permission` | 0 | **5** |
| answered allow / reject | — | 3 / 2 |
| `fs/*` | 0 | **10** (7 read, 3 write) |
| files changed through the page's grant | 0 | 3 |
| containment refusals, with text | 0 | 4 |

- **The consent property holds in practice, not just in assertion.** Both
  rejections are followed in the log by the next request with no write
  between them — `permission answered: reject` → nothing. P5's "the party
  asking is not the party deciding" is now a measured behavior of the
  shipped page rather than a claim in a comment.
- **R9's refusals survive contact, and name the boundary *and* the folder.**
  The exact strings, produced in the browser by `containedRelative()` and
  read back out of the agent's transcript for the first time:
  `refused: /etc/passwd is outside the folder this page was granted
  (/Users/…/fsio-acp)`; `refused: .fsio is the transport's own directory,
  owned by the helper`; `path must be absolute: NOTES.md`. Each is
  actionable by the receiving agent, which is what "written to be relayed"
  had always asserted and nothing had ever tested.
- **An `agent_message_chunk` is a *fragment*, not a line — the agent owns
  its terminators.** This cost a bug. A client is correct to concatenate
  consecutive chunks into one flowing block (the page does, `web/agent.ts`),
  so an agent emitting one chunk per line with no trailing newline gets a
  transcript with every line welded to the next
  (`…says back.✓ somewhere outside…`). The rule is not ACP-specific
  guesswork — it follows from "chunk", and it will bite any agent this repo
  writes. Regression-tested in `test-fixture-agent.ts`.
- **A read needs no card.** The `read` scenario drew no permission request
  at all: the human already granted the folder, and re-asking per read would
  be exactly the prompt fatigue P3 says to fight with scope rather than
  breadth.
- **What this does *not* measure.** The puppet writes its own permission
  card, so "does the card carry enough to decide on" is answered here only
  for a card we authored. Whether a *real* agent's request carries the tool,
  the file and the diff — and whether its own permission layer contradicts
  the sandbox (F26 cell At found it did not, for a different agent) — still
  needs a real agent that asks, which is #100's remaining half.
→ [D30](DECISIONS.md#d30--acp-is-payload-the-host-frames-the-browser-is-the-client),
F24, F26,
[#100](https://github.com/dglazkov/fsio/issues/100),
[#18](https://github.com/dglazkov/fsio/issues/18); feeds
[#86](https://github.com/dglazkov/fsio/issues/86).

## Open measurements

- ~~Safe Browsing on vs. off (final F7 attribution).~~ Measured
  2026-07-26: `close()` p50 75.0 → 1.3 ms with protection off; F7
  attributed — table under F7.
  → [#11](https://github.com/dglazkov/fsio/issues/11)
- ~~Dirname-lane throughput under sustained typing/paste load.~~ Measured
  2026-07-26 → F13 (typing: p50 6 ms all-dirname; flood: 1470 msg/s
  self-batched; backlog ≤3).
  → [#4](https://github.com/dglazkov/fsio/issues/4)
- ~~Is child confinement transitive, and what does a confined child still
  hold?~~ Measured 2026-07-31 → F23 (transitive at every depth,
  non-re-enterable, setuid exec denied) and F24 (full env inheritance,
  read-the-world, egress on).
  → [#86](https://github.com/dglazkov/fsio/issues/86)
- ~~The act-2 field test, run deliberately.~~ Measured 2026-07-31 → F26
  (state placement works; identity lives in the OS keystore, so a
  deny-default profile logs the child out; 8 environment variables
  suffice). Its read-wall remainder is folded into the open item below.
  → [#90](https://github.com/dglazkov/fsio/issues/90)
- ~~Does the read wall exist, and what does it cost? (#86 open question
  4.)~~ Measured 2026-07-31 → F27 (it exists, costs 21 rules over the
  shipped 8, denies `~/.ssh`/`~/Documents`/`/etc/passwd` — and keeps
  `~/.gitconfig` and `~/.npm` readable because git and npm name them),
  against a *toolchain*. Its remainder is the open item below.
  → [#90](https://github.com/dglazkov/fsio/issues/90)
- ~~The same for one MCP server (act 4): is #77's "its binary, its working
  state, and nothing else" true?~~ Measured 2026-07-31 → F25 (true, and
  categorical: deny-default in 15 rules, 5 of them the service's).
  → [#90](https://github.com/dglazkov/fsio/issues/90)
- **What a read wall costs the *agent CLI*** — F27 priced one against a
  toolchain, and that subject reads far more widely; every F26 cell left
  reads wide open. **Deferred, not blocked:** act 2 runs unsandboxed for
  now ([#96](https://github.com/dglazkov/fsio/issues/96)), so nothing on
  the demo track waits on this. It is #86 open question 4's remainder.
  → [#86](https://github.com/dglazkov/fsio/issues/86)
- **How a credentialed child receives its credential — two existence
  questions, not a survey.** The acquisition channels are closed by the
  kernel (inherit-at-spawn, `file-read*`, IPC endpoint, network fetch)
  and F24–F27 priced all four, so more subjects can only yield new
  *instances*, which F25 already showed are profile parameters. What is
  genuinely open: (1) does F25's discovery procedure — deny-default, read
  denials, widen — **terminate** on a credentialed child, or can a
  credential denial fail to name itself (F26's near-miss: logged, but the
  child blamed the wrong party)? (2) does the **borrowed-dotfile** mode
  (`~/.aws`, `~/.config/gh`) occur in practice — the one mode with no
  mechanism-level fix, since carving another tool's dotfile is what R2
  forbids? Answerable with already-installed servers; stop at the first
  hit or when every channel seen is already priced. **Deferred (p3)**
  behind spending F25–F27 on #71.
  → [#90](https://github.com/dglazkov/fsio/issues/90)
- **The daemon's own environment under launchd versus a shell launch.** F24
  measured what a child *inherits*; what fsiod itself is handed when
  launchd starts it is the other half, and nobody has looked.
  → [#71](https://github.com/dglazkov/fsio/issues/71)

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
node scripts/hub-scan-lab.mjs   # F22 host idle-cost matrix (~15 min, no browser)
node scripts/service-reach-lab.mjs           # F25 shell vs service posture (~1 min)
node scripts/agent-reach-lab.mjs            # F26 agent CLI under confinement
                                            # (needs the claude CLI + a config
                                            #  dir; --workspace/--config/--slot)
node scripts/read-wall-lab.mjs              # F27 read-wall cost matrix (~2 min;
                                            #  --widths W0,W1,W2,W3  --keep)
node scripts/confinement-lab.mjs --launchd   # F23/F24 child-confinement matrix
                                             # (~30 s; without --launchd it
                                             #  skips the two launchd cases,
                                             #  which mutate launchd state)
```
