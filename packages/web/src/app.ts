import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  FsioClient,
  FsioSession,
  FrameType,
  now,
  hasObserver,
  op,
  type NotifierMode,
  type UplinkMode,
  type PingResult,
} from "./fsio.js";

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const $in = (id: string): HTMLInputElement => $(id) as HTMLInputElement;

// ---------------------------------------------------------------- logging & errors

const logEl = $("logview");
function log(...a: unknown[]): void {
  const line = a.map((x) => (x instanceof Error ? (x.stack ?? x.message) : String(x))).join(" ");
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
  console.log(...a);
  reporter.log(line);
}

// ------------------------------------------------------------------
// Reporter: mirrors everything the page knows — log lines, errors, bench
// results — into <folder>/.fsio/client/ so whoever is on the native side
// (a human, or an agent debugging this very page) can read it without
// copy-paste. The shared directory is the communication channel; use it.
class Reporter {
  lines: string[] = [];
  events: Record<string, unknown>[] = [];
  dirty = false;
  dir: FileSystemDirectoryHandle | null = null;
  flushing = false;
  lastWrite = 0;
  timer: ReturnType<typeof setInterval> | undefined;

  async attach(fsioDir: FileSystemDirectoryHandle): Promise<void> {
    this.dir = await fsioDir.getDirectoryHandle("client", { create: true });
    clearInterval(this.timer);
    this.timer = setInterval(() => this.flush(), 1000);
    this.dirty = true;
    this.flush();
  }

  log(line: string): void {
    this.lines.push(`${new Date().toISOString()} ${line}`);
    if (this.lines.length > 500) this.lines.splice(0, this.lines.length - 500);
    this.dirty = true;
  }

  event(type: string, data: Record<string, unknown> = {}): void {
    this.events.push({ at: new Date().toISOString(), type, ...data });
    if (this.events.length > 100) this.events.splice(0, this.events.length - 100);
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dir || this.flushing) return;
    if (!this.dirty && Date.now() - this.lastWrite < 5000) return; // 5s heartbeat when idle
    this.flushing = true;
    this.dirty = false;
    this.lastWrite = Date.now();
    try {
      await this._write("log.txt", this.lines.join("\n") + "\n");
      await this._write(
        "report.json",
        JSON.stringify(
          {
            updated: new Date().toISOString(),
            userAgent: navigator.userAgent,
            hasObserver,
            currentStep: lastStep,
            events: this.events,
          },
          null,
          2
        )
      );
    } catch {
      // Reporting must never break the thing it reports on.
    } finally {
      this.flushing = false;
    }
  }

  async _write(name: string, text: string): Promise<void> {
    const fh = await this.dir!.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>);
    await w.close();
  }
}
const reporter = new Reporter();

function showError(msg: string, hint = ""): void {
  $("error-msg").textContent = msg;
  $("error-hint").textContent = hint;
  $("error").hidden = false;
  $("error").scrollIntoView({ behavior: "smooth", block: "nearest" });
  reporter.event("error", { msg, hint, step: lastStep });
}
function clearError(): void {
  $("error").hidden = true;
}

type FriendlyError = Error & { friendly?: { msg: string; hint?: string } };

/** Throw a user-facing error. */
function fail(msg: string, hint?: string): never {
  const e: FriendlyError = new Error(msg);
  e.friendly = { msg, ...(hint !== undefined && { hint }) };
  throw e;
}

// Breadcrumbs: the banner always says what we were in the middle of.
let lastStep = "";
function step(s: string, { quiet = false } = {}): void {
  lastStep = s;
  if (!quiet) log("→ " + s);
}

/** Wrap an event handler: surface every failure on the page, never hang silently. */
function guard(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    clearError();
    lastStep = "";
    try {
      await fn();
    } catch (e) {
      const err = e as FriendlyError | undefined;
      if (err?.name === "AbortError") return; // user closed the picker — not an error
      const f = err?.friendly ?? {
        msg: `While ${lastStep || "working"}: ${err?.message ?? e}`,
        hint: "Please copy the nerd log below and report this — it now names the exact operation that failed.",
      };
      showError(f.msg, f.hint);
      log("ERROR:", err?.stack ?? e);
    }
  };
}

function setCheck(id: string, state: string, text: string, hint = ""): void {
  const li = $(id);
  li.className = state;
  li.textContent = text;
  if (hint) {
    const s = document.createElement("span");
    s.className = "hint";
    s.textContent = hint;
    li.appendChild(s);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Background failures (async send loops etc.) must never be console-only.
window.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
  const reason = ev.reason as FriendlyError | undefined;
  showError("A background task failed: " + (reason?.message ?? ev.reason), "Details in the nerd log below.");
  log("UNHANDLED:", reason?.stack ?? ev.reason);
});

// ---------------------------------------------------------------- static bits

setCheck(
  "chk-notify",
  "note",
  hasObserver
    ? "this browser can watch folders for changes (we still poll — it's faster; see the spec)"
    : "this browser can't watch folders (FileSystemObserver missing) — using fast polling, which works fine"
);

$("copy-cmd").onclick = () => navigator.clipboard.writeText($("host-cmd").textContent ?? "");
$("copy-log").onclick = () => navigator.clipboard.writeText(logEl.textContent ?? "");

// ---------------------------------------------------------------- connect

let client: FsioClient | null = null;
let hostTimer: ReturnType<typeof setInterval> | undefined;

$("pick").onclick = guard(async () => {
  step("opening the folder picker", { quiet: true });
  const root = await showDirectoryPicker({ mode: "readwrite" });
  step("setting up .fsio in the folder");
  client = new FsioClient(root);
  await client.connect();
  await reporter.attach(client.fsioDir);
  reporter.event("connected", { folder: root.name });
  setCheck("chk-dir", "ok", `folder chosen: ${root.name}/`);
  await refreshHostCheck();
  clearInterval(hostTimer);
  hostTimer = setInterval(refreshHostCheck, 2000);
  $in("run-bench").disabled = false;
  $in("run-commit").disabled = false;
  $in("run-observer-lab").disabled = false;
  $in("run-throughput-lab").disabled = false;
  $in("open-term").disabled = false;
  log(`connected to ${root.name}/.fsio`);
});

async function refreshHostCheck() {
  const host = await client!.hostInfo();
  if (host.alive && host.info) {
    const extras = [
      host.info.pty ? "full terminal support" : "basic terminal (no pty)",
      host.info.allowShell ? "shell allowed" : "shell disabled",
    ].join(", ");
    setCheck("chk-host", "ok", `helper is running (${extras})`);
  } else {
    setCheck(
      "chk-host",
      "bad",
      "no helper heartbeat in this folder",
      "Make sure the helper from step 1 is running, and that its folder is exactly the one you picked. It writes a heartbeat file every 2 seconds; we're not seeing it."
    );
  }
  return host;
}

// ---------------------------------------------------------------- shared helpers

interface Stats {
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

function stats(xs: number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { min: s[0]!, p50: q(0.5), p95: q(0.95), max: s[s.length - 1]!, mean: s.reduce((a, b) => a + b, 0) / s.length };
}
const ms = (x: number) => (x >= 100 ? x.toFixed(0) : x.toFixed(1));
const pad = (x: number) => ms(x).padStart(7);

function verdictFor(p50: number): [string, string, string] {
  if (p50 < 16) return ["🚀", "instant", "faster than one frame of your display"];
  if (p50 < 50) return ["✨", "snappy", "you won't feel it while typing"];
  if (p50 < 150) return ["🐢", "usable, but you'll feel it", "fine for output, sluggish for typing"];
  return ["🐌", "sluggish", "too slow for an interactive terminal"];
}

// ---------------------------------------------------------------- latency bench

$("run-bench").onclick = guard(async () => {
  const btn = $in("run-bench");
  btn.disabled = true;
  $("verdict").hidden = true;
  $("bench-details").hidden = true;
  $("progress").hidden = false;
  const progress = (frac: number, text: string) => {
    $("progress-bar").style.width = `${Math.round(frac * 100)}%`;
    $("progress-text").textContent = text;
  };

  let session: FsioSession | null = null;
  try {
    // --- preflight: is anyone listening?
    step("checking the helper is there");
    progress(0, "checking the helper is there…");
    const host = await refreshHostCheck();
    if (!host.alive) {
      fail(
        "The helper doesn't seem to be running in this folder.",
        "Start it with the command from step 1 (pointed at the folder you picked), wait a couple of seconds, and try again."
      );
    }

    const count = Number($in("b-count").value) || 200;
    const payload = Number($in("b-payload").value) || 0;
    const warmup = Math.min(20, count);
    step("creating a test session");
    session = await client!.createSession(
      { kind: "echo", client: "web-bench" },
      {
        mode: $in("b-mode").value as NotifierMode,
        pollMs: Number($in("b-poll").value) || 5,
        uplink: $in("b-uplink").value as UplinkMode,
        onError: (e) => log("send failed:", e.message),
        onNote: (m) => log("note:", m),
      }
    );

    // --- wait for the helper to answer the spawn request
    step("waiting for the helper to pick up the session");
    progress(0, "waiting for the helper to notice us…");
    await Promise.race([session.ready, sleep(4000).then(() => Promise.reject(new Error("spawn timeout")))]).catch(() => {
      fail(
        "The helper is running, but it never picked up our test session (waited 4 s).",
        "This usually means the helper is watching a different folder than the one you picked. Double-check the path in its terminal, or restart it pointed at the right folder."
      );
    });

    // --- ping-pong
    const total = warmup + count;
    const results: { rtt: number; up: number; host: number; down: number }[] = [];
    const rtts: number[] = [];
    for (let i = 0; i < total; i++) {
      step(`sending message ${i + 1} of ${total}`, { quiet: i % 50 !== 0 });
      const r = await session
        .request<PingResult>("ping", { t0: now(), filler: "x".repeat(payload) }, { timeoutMs: 5000 })
        .then(({ result, rx }) => ({ ...result, t3: rx }), () => null);
      if (r === null) {
        fail(
          `Message ${i + 1} never came back (waited 5 s).`,
          "Check the helper's terminal for errors. If it's fine, this is exactly the kind of bug the workbench exists to find — the nerd log below may help."
        );
      }
      if (i >= warmup) {
        results.push({ rtt: r.t3 - r.t0, up: r.t1 - r.t0, host: r.t2 - r.t1, down: r.t3 - r.t2 });
        rtts.push(r.t3 - r.t0);
        const sofar = stats(rtts);
        progress((i + 1) / total, `message ${i + 1} of ${total} · median so far: ${ms(sofar.p50)} ms`);
      } else {
        progress((i + 1) / total, `warming up… ${i + 1} of ${total}`);
      }
    }

    // --- verdict
    const s = stats(rtts);
    const [emoji, word, meaning] = verdictFor(s.p50);
    $("verdict").innerHTML =
      `${emoji} <span class="big">${ms(s.p50)} ms</span> median round trip — <strong>${word}</strong><br>` +
      `<span style="color:#9aa5b8">${meaning} · 95% of messages under ${ms(s.p95)} ms</span>`;
    $("verdict").hidden = false;

    // --- details
    const legNames = {
      rtt: "full round trip    ",
      up: "this page → helper ",
      host: "helper processing  ",
      down: "helper → this page ",
    } as const;
    const effMode =
      (session.mode === "observer" ? "observer" : `${session.mode} ${session.pollMs}ms`) +
      (session.uplink === "file" ? "" : " +dirname-up");
    let text = `mode=${effMode} · ${count} messages · ${payload}B extra payload\n\n`;
    text += `leg                   median     95th    worst   (ms)\n`;
    for (const key of ["rtt", "up", "host", "down"] as const) {
      const st = stats(results.map((r) => r[key]));
      text += `${legNames[key]} ${pad(st.p50)}  ${pad(st.p95)}  ${pad(st.max)}\n`;
    }
    const row = `| web client | ${effMode} | ${count} | ${payload} | ${s.min.toFixed(2)} | ${s.p50.toFixed(2)} | ${s.p95.toFixed(2)} | ${s.max.toFixed(2)} |`;
    text += `\n${row}`;
    reporter.event("bench", {
      mode: effMode,
      count,
      payload,
      legs: Object.fromEntries((["rtt", "up", "host", "down"] as const).map((k) => [k, stats(results.map((r) => r[k]))])),
      markdownRow: row,
    });
    $("bench-out").textContent = text;
    $("copy-row").onclick = () => navigator.clipboard.writeText(row);
    $("bench-details").hidden = false;
    log(`bench: p50 ${ms(s.p50)}ms (${effMode})`);
  } finally {
    $("progress").hidden = true;
    btn.disabled = false;
    await session?.close().catch(() => {}); // host deletes the session dir
  }
});

// ---------------------------------------------------------------- write-speed microbench
// Times each phase of writing one file, no helper involved. Attributes the
// send cost: close() is where Chrome runs its after-write safety checks.

$("run-commit").onclick = guard(async () => {
  const btn = $in("run-commit");
  btn.disabled = true;
  $("verdict").hidden = true;
  $("progress").hidden = false;
  try {
    step("creating the scratch folder");
    const dir = await op("creating tmp-write-bench/", () =>
      client!.fsioDir.getDirectoryHandle("tmp-write-bench", { create: true })
    );
    const N = 50;
    const bytes = new TextEncoder().encode("x".repeat(64)) as Uint8Array<ArrayBuffer>;
    const legs = { open: [] as number[], start: [] as number[], write: [] as number[], commit: [] as number[] };
    for (let i = 0; i < N; i++) {
      step(`writing scratch file ${i + 1} of ${N}`, { quiet: true });
      $("progress-bar").style.width = `${Math.round(((i + 1) / N) * 100)}%`;
      $("progress-text").textContent = `writing file ${i + 1} of ${N}…`;
      let t = performance.now();
      const fh = await op(`opening c${i}.f`, () => dir.getFileHandle(`c${i}.f`, { create: true }));
      legs.open.push(performance.now() - t);
      t = performance.now();
      const w = await op(`starting write of c${i}.f`, () => fh.createWritable());
      legs.start.push(performance.now() - t);
      t = performance.now();
      await op(`writing c${i}.f`, () => w.write(bytes));
      legs.write.push(performance.now() - t);
      t = performance.now();
      await op(`committing c${i}.f`, () => w.close());
      legs.commit.push(performance.now() - t);
    }
    // Cleanup is best-effort: a leftover tmp dir is harmless, a scary error
    // banner is not.
    try {
      await client!.fsioDir.removeEntry("tmp-write-bench", { recursive: true });
    } catch (e) {
      log("write-bench cleanup skipped:", e instanceof Error ? e.message : e);
    }

    const total = stats(legs.open.map((_, i) => legs.open[i]! + legs.start[i]! + legs.write[i]! + legs.commit[i]!));
    const commit = stats(legs.commit);
    let head: string;
    if (commit.p50 > 20) {
      head =
        `✍️ <span class="big">${ms(total.p50)} ms</span> to write one small file — ` +
        `<strong>and ${ms(commit.p50)} ms of that is the final "commit" step.</strong><br>` +
        `<span style="color:#9aa5b8">That's likely Chrome's safety scan on every saved file — the floor for every message this page sends. ` +
        `Try the “folder-name trick” under advanced settings, which sidesteps it.</span>`;
    } else {
      head = `✍️ <span class="big">${ms(total.p50)} ms</span> to write one small file — commit step is cheap here (${ms(commit.p50)} ms).`;
    }
    $("verdict").innerHTML = head;
    $("verdict").hidden = false;

    const names = { open: "open the file      ", start: "start writing      ", write: "write 64 bytes     ", commit: "commit (close)     " } as const;
    let text = `write-speed microbench · ${N} files · 64 B each\n\nphase                 median     95th    worst   (ms)\n`;
    for (const k of ["open", "start", "write", "commit"] as const) {
      const st = stats(legs[k]);
      text += `${names[k]} ${pad(st.p50)}  ${pad(st.p95)}  ${pad(st.max)}\n`;
    }
    $("bench-out").textContent = text;
    $("copy-row").onclick = () => navigator.clipboard.writeText(text);
    $("bench-details").hidden = false;
    log(`write bench: total p50 ${ms(total.p50)}ms, commit p50 ${ms(commit.p50)}ms`);
    reporter.event("write-bench", {
      files: N,
      legs: Object.fromEntries((["open", "start", "write", "commit"] as const).map((k) => [k, stats(legs[k])])),
    });
  } finally {
    $("progress").hidden = true;
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- throughput lab
// #4's open measurement: the dirname fast lane under *sustained* load, not
// one-ping-at-a-time. Three phases:
//   A. paced "typing" — 1 ping / 15 ms for ~3 s. Does the auto lane stay on
//      dirname chunks, and does RTT hold near the F10 number?
//   B. flood — N pings fired back-to-back. Sends coalesce while a commit is
//      in flight, batches outgrow DIR_CHUNK_MAX_BYTES (180 B), and the auto
//      lane must fall back to file chunks (F7 cost each): measures achieved
//      msgs/s, the lane split, and the in/ backlog the host must drain.
//   C. paste — 5 pings with 4 KB filler: always file-lane; the per-commit
//      floor for bulk uplink.
// Results go to the page, the nerd log, and .fsio/client/report.json.

$("run-throughput-lab").onclick = guard(async () => {
  const btn = $in("run-throughput-lab");
  btn.disabled = true;
  $("verdict").hidden = true;
  const out = $("bench-out");
  $("bench-details").hidden = false;
  out.textContent = "throughput lab running…";
  const lines: string[] = [];
  const say = (s: string) => {
    lines.push(s);
    out.textContent = lines.join("\n");
    log("tput: " + s);
  };

  let session: FsioSession | null = null;
  try {
    step("throughput lab: preflight");
    const host = await refreshHostCheck();
    if (!host.alive) {
      fail("The helper doesn't seem to be running in this folder.", "Start it with the command from step 1 and try again.");
    }
    session = await client!.createSession(
      { kind: "echo", client: "web-throughput-lab" },
      { mode: "adaptive", pollMs: 5, uplink: "auto", onError: (e) => log("send failed:", e.message), onNote: (m) => log("note:", m) }
    );
    await Promise.race([session.ready, sleep(4000).then(() => Promise.reject(new Error("spawn timeout")))]);
    const markStats = () => ({ ...session!.stats });
    const backlog = async () => {
      let n = 0;
      for await (const _ of session!.inDir.keys()) n++;
      return n;
    };

    // ---- A. paced typing
    step("throughput lab A: paced sends (typing cadence)");
    say("A. paced — 1 ping / 15 ms for 3 s (typing-ish)");
    {
      const before = markStats();
      const rtts: number[] = [];
      const pending: Promise<unknown>[] = [];
      const t0 = performance.now();
      let i = 0;
      while (performance.now() - t0 < 3000) {
        const sent = now();
        pending.push(
          session.request<PingResult>("ping", { t0: sent }, { timeoutMs: 15000 }).then(({ rx }) => rtts.push(rx - sent))
        );
        i++;
        await sleep(15);
      }
      await Promise.all(pending);
      const after = markStats();
      const s = stats(rtts);
      const dir = after.dirChunks - before.dirChunks;
      const file = after.fileChunks - before.fileChunks;
      say(`   ${i} pings · rtt p50 ${ms(s.p50)} p95 ${ms(s.p95)} max ${ms(s.max)} ms`);
      say(`   lanes: ${dir} dirname · ${file} file`);
      reporter.event("throughput-paced", { pings: i, rtt: s, dirChunks: dir, fileChunks: file });
    }

    // ---- B. flood
    step("throughput lab B: flood");
    const FLOOD = 400;
    say(`B. flood — ${FLOOD} pings fired back-to-back`);
    {
      const before = markStats();
      const rtts: number[] = [];
      const backlogSamples: number[] = [];
      const t0 = performance.now();
      const pending: Promise<unknown>[] = [];
      for (let i = 0; i < FLOOD; i++) {
        const sent = now();
        pending.push(
          session.request<PingResult>("ping", { t0: sent }, { timeoutMs: 30000 }).then(({ rx }) => rtts.push(rx - sent))
        );
      }
      const sendDone = performance.now() - t0; // queueing is sync; commits are async
      const sampler = (async () => {
        while (rtts.length < FLOOD) {
          backlogSamples.push(await backlog());
          await sleep(25);
        }
      })();
      await Promise.all(pending);
      const wall = performance.now() - t0;
      await sampler;
      const after = markStats();
      const s = stats(rtts);
      const dir = after.dirChunks - before.dirChunks;
      const file = after.fileChunks - before.fileChunks;
      const chunks = dir + file;
      say(`   all answered in ${ms(wall)} ms → ${(FLOOD / (wall / 1000)).toFixed(0)} msg/s round-trip`);
      say(`   ${chunks} chunks (${dir} dirname · ${file} file) → mean batch ${(FLOOD / chunks).toFixed(1)} msgs/chunk`);
      say(`   rtt p50 ${ms(s.p50)} p95 ${ms(s.p95)} max ${ms(s.max)} ms · max in/ backlog ${Math.max(0, ...backlogSamples)} chunks`);
      reporter.event("throughput-flood", {
        pings: FLOOD,
        wallMs: wall,
        sendLoopMs: sendDone,
        msgsPerSec: FLOOD / (wall / 1000),
        rtt: s,
        dirChunks: dir,
        fileChunks: file,
        maxBacklog: Math.max(0, ...backlogSamples),
        backlogSamples,
      });
    }

    // ---- C. paste
    step("throughput lab C: 4 KB payloads");
    say("C. paste — 5 pings × 4 KB filler (file lane by size)");
    {
      const before = markStats();
      const rtts: number[] = [];
      for (let i = 0; i < 5; i++) {
        const sent = now();
        const { rx } = await session.request<PingResult>("ping", { t0: sent, filler: "x".repeat(4096) }, { timeoutMs: 15000 });
        rtts.push(rx - sent);
      }
      const after = markStats();
      const s = stats(rtts);
      say(`   rtt p50 ${ms(s.p50)} p95 ${ms(s.p95)} max ${ms(s.max)} ms · lanes: ${after.dirChunks - before.dirChunks} dirname · ${after.fileChunks - before.fileChunks} file`);
      reporter.event("throughput-paste", { pings: 5, payload: 4096, rtt: s });
    }

    say("\ndone — full data in .fsio/client/report.json");
  } finally {
    btn.disabled = false;
    await session?.close().catch(() => {});
  }
});

// ---------------------------------------------------------------- observer lab
// FileSystemObserver got demoted to "optional" after F6/F9, but never
// properly diagnosed. This battery answers, empirically:
//   A. which observe() calls fail, on which handles (the F9 mystery)
//   B. per-event-type latency for ISOLATED changes (is the 250ms of F6
//      intrinsic, or coalescing under churn?)
//   C. burst behavior (dirname-lane-style rapid mkdirs: how do 20 events
//      in 100ms get delivered?)
//   D. host→browser echo RTT via observer ONLY, with pings spaced out
//      (isolated-event latency through the whole protocol)
// Results go to the page, the nerd log, and .fsio/client/report.json.

interface LabResults {
  support: boolean;
  matrix: { target: string; recursive: boolean; ok: boolean; err: string | null }[];
  isolated: Record<string, (number | null)[]>;
  burst: { sentIn?: number; eventsSeen?: number; batches?: number; firstLatency?: number | null; lastLatency?: number | null };
  echo: { mode?: string; rtts?: (number | null)[] };
}

$("run-observer-lab").onclick = guard(async () => {
  const btn = $in("run-observer-lab");
  btn.disabled = true;
  $("verdict").hidden = true;
  const out = $("bench-out");
  $("bench-details").hidden = false;
  out.textContent = "observer lab running…";
  const results: LabResults = { support: hasObserver, matrix: [], isolated: {}, burst: {}, echo: {} };
  const lines: string[] = [];
  const say = (s: string) => {
    lines.push(s);
    out.textContent = lines.join("\n");
    log("lab: " + s);
  };

  try {
    if (!hasObserver) {
      say("FileSystemObserver is not available in this browser — nothing to test.");
      return;
    }

    // ---- A. observe() matrix
    step("observer lab: testing observe() on various handles");
    say("A. can observe() even start?");
    let labDir: FileSystemDirectoryHandle | null = null;
    try {
      labDir = await client!.fsioDir.getDirectoryHandle("obs-lab", { create: true });
    } catch (e) {
      say(`   (couldn't create scratch dir: ${e instanceof Error ? e.name : e})`);
    }
    const targets: [string, FileSystemHandle][] = [
      ["picked folder", client!.root],
      [".fsio", client!.fsioDir],
      ...(labDir ? ([["fresh subfolder", labDir]] as [string, FileSystemHandle][]) : []),
    ];
    for (const [label, handle] of targets) {
      for (const recursive of [false, true]) {
        let err: string | null = null;
        let obs: FileSystemObserver | null = null;
        try {
          obs = new FileSystemObserver(() => {});
          await obs.observe(handle, { recursive });
        } catch (e) {
          err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        }
        obs?.disconnect();
        results.matrix.push({ target: label, recursive, ok: !err, err });
        say(`   ${err ? "❌" : "✅"} ${label} recursive=${recursive}${err ? " — " + err : ""}`);
      }
    }

    // ---- B & C need a working observer on the lab dir
    const labEvents: { t: number; type: string; name: string }[] = [];
    let waiter: ((t: number) => void) | null = null;
    let labObs: FileSystemObserver | null = null;
    if (labDir) {
      try {
        labObs = new FileSystemObserver((records) => {
          const t = performance.now();
          for (const r of records) labEvents.push({ t, type: r.type, name: (r.relativePathComponents ?? []).join("/") });
          waiter?.(t);
        });
        await labObs.observe(labDir, { recursive: true });
      } catch (e) {
        labObs = null;
        say(`   (no working observer on scratch dir: ${e instanceof Error ? e.name : e} — skipping latency tests)`);
      }
    }

    if (labObs && labDir) {
      const lab = labDir;
      // ---- B. isolated event latency, by type
      step("observer lab: isolated event latencies");
      say("B. isolated events (5 each, 400ms apart) — latency ms:");
      const measure = async (fn: () => Promise<unknown>): Promise<number | null> => {
        const p = new Promise<number>((res) => (waiter = res));
        const t0 = performance.now();
        await fn();
        const t = await Promise.race([p, sleep(2500).then(() => null)]);
        waiter = null;
        return t === null ? null : Math.round((t - t0) * 10) / 10;
      };
      const kinds: Record<string, (i: number) => Promise<unknown>> = {
        "file create ": (i) => lab.getFileHandle(`f${i}`, { create: true }),
        "file write  ": async (i) => {
          const w = await (await lab.getFileHandle(`f${i}`)).createWritable();
          await w.write(new TextEncoder().encode("x") as Uint8Array<ArrayBuffer>);
          await w.close();
        },
        "dir create  ": (i) => lab.getDirectoryHandle(`d${i}`, { create: true }),
        "dir remove  ": (i) => lab.removeEntry(`d${i}`),
      };
      for (const [name, fn] of Object.entries(kinds)) {
        const lat: (number | null)[] = [];
        for (let i = 0; i < 5; i++) {
          lat.push(await measure(() => fn(i)));
          await sleep(400);
        }
        results.isolated[name.trim()] = lat;
        say(`   ${name} ${lat.map((x) => (x === null ? "timeout" : x)).join("  ")}`);
      }

      // ---- C. burst: 20 rapid mkdirs (the dirname-lane pattern)
      step("observer lab: burst coalescing");
      const before = labEvents.length;
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) await lab.getDirectoryHandle(`burst${i}`, { create: true });
      const tSent = performance.now() - t0;
      await sleep(2000);
      const burst = labEvents.slice(before);
      const batches = new Set(burst.map((e) => Math.round(e.t))).size;
      results.burst = {
        sentIn: Math.round(tSent),
        eventsSeen: burst.length,
        batches,
        firstLatency: burst.length ? Math.round(burst[0]!.t - t0) : null,
        lastLatency: burst.length ? Math.round(burst[burst.length - 1]!.t - t0) : null,
      };
      say(
        `C. burst: 20 mkdirs in ${results.burst.sentIn}ms → ${burst.length} events in ~${batches} callback batch(es), first after ${results.burst.firstLatency}ms, last after ${results.burst.lastLatency}ms`
      );
      labObs.disconnect();
      try {
        await client!.fsioDir.removeEntry("obs-lab", { recursive: true });
      } catch {}
    }

    // ---- D. observer-only echo RTT, isolated pings (needs the helper)
    const host = await refreshHostCheck();
    if (!host.alive) {
      say("D. skipped (helper not running) — matrix + local tests above still stand");
    } else {
      step("observer lab: observer-only echo round trips");
      const session = await client!.createSession(
        { kind: "echo", client: "observer-lab" },
        {
          mode: "observer",
          safetyMs: 0, // no safety poll: observer sinks or swims alone
          onNote: (m) => say("   note: " + m),
        }
      );
      say(`D. echo RTT via ${session.mode === "observer" ? "observer only" : "POLLING (observer refused again — see note)"} — 15 pings, 400ms apart:`);
      const rtts: (number | null)[] = [];
      try {
        for (let i = 0; i < 15; i++) {
          const rtt = await session
            .request<PingResult>("ping", { t0: now() }, { timeoutMs: 4000 })
            .then(({ result, rx }) => rx - result.t0, () => null);
          rtts.push(rtt === null ? null : Math.round(rtt * 10) / 10);
          await sleep(400);
        }
      } finally {
        await session.close().catch(() => {});
      }
      results.echo = { mode: session.mode, rtts };
      const good = rtts.filter((x): x is number => x !== null);
      say(`   ${rtts.map((x) => (x === null ? "lost" : x)).join("  ")}`);
      if (good.length) {
        const s = stats(good);
        say(`   → p50 ${ms(s.p50)}ms, min ${ms(s.min)}, max ${ms(s.max)}, lost ${rtts.length - good.length}/${rtts.length}`);
      }
    }

    say("\ndone — full data in .fsio/client/report.json");
    reporter.event("observer-lab", { ...results });
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- terminal

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let termSession: FsioSession | null = null;

$("open-term").onclick = guard(async () => {
  step("checking the helper before starting a shell");
  const host = await refreshHostCheck();
  if (!host.alive) {
    fail("The helper isn't running, so there's nothing to spawn a shell on.", "Start it with the command from step 1, then try again.");
  }
  if (host.info && !host.info.allowShell) {
    fail(
      "The helper is running, but with shells disabled.",
      "Restart it with the --allow-shell flag: that's the switch that lets this page run programs on your machine."
    );
  }
  $in("open-term").disabled = true;
  $("term").hidden = false;

  if (!term) {
    term = new Terminal({ fontSize: 13, theme: { background: "#14161a" } });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open($("term"));
    new ResizeObserver(() => {
      fit!.fit();
      termSession?.notify("resize", { cols: term!.cols, rows: term!.rows });
    }).observe($("term"));
  }
  fit!.fit();
  term.reset();

  const dec = new TextDecoder();
  step("creating the shell session");
  termSession = await client!.createSession(
    { kind: "shell", cols: term.cols, rows: term.rows },
    {
      onError: (e) => showError("Sending to the shell failed.", e.message),
      onNote: (m) => log("note:", m),
      onFrame: (f) => {
        if (f.type === FrameType.DATA) term!.write(dec.decode(f.payload));
      },
    }
  );
  termSession.onStatus = (st) => {
    reporter.event("terminal-status", { ...st });
    if (st.state === "exited") {
      $("term-status").textContent = `the shell exited${st.exitCode != null ? ` (code ${st.exitCode})` : ""}`;
      $in("open-term").disabled = false;
      $in("close-term").disabled = true;
    }
  };
  // Spawn errors arrive as JSON-RPC error objects on the spawn request —
  // no more polling status.json and interpreting states.
  step("waiting for the shell to start");
  try {
    const info = await Promise.race([
      termSession.ready,
      sleep(8000).then(() => Promise.reject(new Error("the helper never answered the spawn request (waited 8 s)"))),
    ]);
    $("term-status").textContent =
      info.pty === false
        ? "connected (basic mode — install node-pty and restart the helper for the full experience)"
        : "connected — type away";
  } catch (e) {
    showError("The helper refused to start a shell.", e instanceof Error ? e.message : String(e));
    $in("open-term").disabled = false;
    await termSession.close().catch(() => {});
    termSession = null;
    return;
  }
  term.onData((d) => termSession!.sendData(d));
  term.focus();
  $in("close-term").disabled = false;
  log(`terminal session ${termSession.id}`);
});

$("close-term").onclick = guard(async () => {
  await termSession?.close();
  termSession = null;
  $("term-status").textContent = "closed";
  $in("close-term").disabled = true;
  $in("open-term").disabled = false;
});
