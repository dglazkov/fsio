import { FsioClient, FrameType, now, hasObserver, op } from "./fsio.js";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- logging & errors

const logEl = $("logview");
function log(...a) {
  const line = a.join(" ");
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
  constructor() {
    this.lines = [];
    this.events = [];
    this.dirty = false;
    this.dir = null;
    this.flushing = false;
    this.lastWrite = 0;
  }
  async attach(fsioDir) {
    this.dir = await fsioDir.getDirectoryHandle("client", { create: true });
    clearInterval(this.timer);
    this.timer = setInterval(() => this.flush(), 1000);
    this.dirty = true;
    this.flush();
  }
  log(line) {
    this.lines.push(`${new Date().toISOString()} ${line}`);
    if (this.lines.length > 500) this.lines.splice(0, this.lines.length - 500);
    this.dirty = true;
  }
  event(type, data = {}) {
    this.events.push({ at: new Date().toISOString(), type, ...data });
    if (this.events.length > 100) this.events.splice(0, this.events.length - 100);
    this.dirty = true;
  }
  async flush() {
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
  async _write(name, text) {
    const fh = await this.dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(new TextEncoder().encode(text));
    await w.close();
  }
}
const reporter = new Reporter();

function showError(msg, hint = "") {
  $("error-msg").textContent = msg;
  $("error-hint").textContent = hint;
  $("error").hidden = false;
  $("error").scrollIntoView({ behavior: "smooth", block: "nearest" });
  reporter.event("error", { msg, hint, step: lastStep });
}
function clearError() {
  $("error").hidden = true;
}

/** Throw a user-facing error. */
function fail(msg, hint) {
  const e = new Error(msg);
  e.friendly = { msg, hint };
  throw e;
}

// Breadcrumbs: the banner always says what we were in the middle of.
let lastStep = "";
function step(s, { quiet = false } = {}) {
  lastStep = s;
  if (!quiet) log("→ " + s);
}

/** Wrap an event handler: surface every failure on the page, never hang silently. */
function guard(fn) {
  return async (...args) => {
    clearError();
    lastStep = "";
    try {
      await fn(...args);
    } catch (e) {
      if (e?.name === "AbortError") return; // user closed the picker — not an error
      const f = e?.friendly ?? {
        msg: `While ${lastStep || "working"}: ${e?.message ?? e}`,
        hint: "Please copy the nerd log below and report this — it now names the exact operation that failed.",
      };
      showError(f.msg, f.hint);
      log("ERROR:", e?.stack ?? e);
    }
  };
}

function setCheck(id, state, text, hint = "") {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Background failures (async send loops etc.) must never be console-only.
window.addEventListener("unhandledrejection", (ev) => {
  showError("A background task failed: " + (ev.reason?.message ?? ev.reason), "Details in the nerd log below.");
  log("UNHANDLED:", ev.reason?.stack ?? ev.reason);
});

// ---------------------------------------------------------------- static bits

setCheck(
  "chk-notify",
  "note",
  hasObserver
    ? "this browser can watch folders for changes (we still poll — it's faster; see the spec)"
    : "this browser can't watch folders (FileSystemObserver missing) — using fast polling, which works fine"
);

$("copy-cmd").onclick = () => navigator.clipboard.writeText($("host-cmd").textContent);
$("copy-log").onclick = () => navigator.clipboard.writeText(logEl.textContent);

// ---------------------------------------------------------------- connect

let client = null;
let hostTimer = null;

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
  $("run-bench").disabled = false;
  $("run-commit").disabled = false;
  $("run-observer-lab").disabled = false;
  $("open-term").disabled = false;
  log(`connected to ${root.name}/.fsio`);
});

async function refreshHostCheck() {
  const host = await client.hostInfo();
  if (host.alive) {
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

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { min: s[0], p50: q(0.5), p95: q(0.95), max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length };
}
const ms = (x) => (x >= 100 ? x.toFixed(0) : x.toFixed(1));
const pad = (x) => ms(x).padStart(7);

function verdictFor(p50) {
  if (p50 < 16) return ["🚀", "instant", "faster than one frame of your display"];
  if (p50 < 50) return ["✨", "snappy", "you won't feel it while typing"];
  if (p50 < 150) return ["🐢", "usable, but you'll feel it", "fine for output, sluggish for typing"];
  return ["🐌", "sluggish", "too slow for an interactive terminal"];
}

// ---------------------------------------------------------------- latency bench

$("run-bench").onclick = guard(async () => {
  const btn = $("run-bench");
  btn.disabled = true;
  $("verdict").hidden = true;
  $("bench-details").hidden = true;
  $("progress").hidden = false;
  const progress = (frac, text) => {
    $("progress-bar").style.width = `${Math.round(frac * 100)}%`;
    $("progress-text").textContent = text;
  };

  let session = null;
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

    const count = Number($("b-count").value) || 200;
    const payload = Number($("b-payload").value) || 0;
    const warmup = Math.min(20, count);
    step("creating a test session");
    session = await client.createSession(
      { kind: "echo", client: "web-bench" },
      {
        mode: $("b-mode").value,
        pollMs: Number($("b-poll").value) || 5,
        uplink: $("b-uplink").value,
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
    const results = [];
    const rtts = [];
    for (let i = 0; i < total; i++) {
      step(`sending message ${i + 1} of ${total}`, { quiet: i % 50 !== 0 });
      const r = await session
        .request("ping", { t0: now(), filler: "x".repeat(payload) }, { timeoutMs: 5000 })
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
    };
    const effMode =
      (session.mode === "observer" ? "observer" : `${session.mode} ${session.pollMs}ms`) +
      (session.uplink === "file" ? "" : " +dirname-up");
    let text = `mode=${effMode} · ${count} messages · ${payload}B extra payload\n\n`;
    text += `leg                   median     95th    worst   (ms)\n`;
    for (const key of ["rtt", "up", "host", "down"]) {
      const st = stats(results.map((r) => r[key]));
      text += `${legNames[key]} ${pad(st.p50)}  ${pad(st.p95)}  ${pad(st.max)}\n`;
    }
    const row = `| web client | ${effMode} | ${count} | ${payload} | ${s.min.toFixed(2)} | ${s.p50.toFixed(2)} | ${s.p95.toFixed(2)} | ${s.max.toFixed(2)} |`;
    text += `\n${row}`;
    reporter.event("bench", {
      mode: effMode,
      count,
      payload,
      legs: Object.fromEntries(["rtt", "up", "host", "down"].map((k) => [k, stats(results.map((r) => r[k]))])),
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
  const btn = $("run-commit");
  btn.disabled = true;
  $("verdict").hidden = true;
  $("progress").hidden = false;
  try {
    step("creating the scratch folder");
    const dir = await op("creating tmp-write-bench/", () =>
      client.fsioDir.getDirectoryHandle("tmp-write-bench", { create: true })
    );
    const N = 50;
    const bytes = new TextEncoder().encode("x".repeat(64));
    const legs = { open: [], start: [], write: [], commit: [] };
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
      await client.fsioDir.removeEntry("tmp-write-bench", { recursive: true });
    } catch (e) {
      log("write-bench cleanup skipped:", e.message);
    }

    const total = stats(legs.open.map((_, i) => legs.open[i] + legs.start[i] + legs.write[i] + legs.commit[i]));
    const commit = stats(legs.commit);
    let head;
    if (commit.p50 > 20) {
      head =
        `✍️ <span class="big">${ms(total.p50)} ms</span> to write one small file — ` +
        `<strong>and ${ms(commit.p50)} ms of that is the final "commit" step.</strong><br>` +
        `<span style="color:#9aa5b8">That's likely Chrome's safety scan on every saved file — the floor for every message this page sends. ` +
        `Try the “folder-name trick” under advanced settings, which sidesteps it.</span>`;
    } else {
      head =
        `✍️ <span class="big">${ms(total.p50)} ms</span> to write one small file — commit step is cheap here (${ms(commit.p50)} ms).`;
    }
    $("verdict").innerHTML = head;
    $("verdict").hidden = false;

    const names = { open: "open the file      ", start: "start writing      ", write: "write 64 bytes     ", commit: "commit (close)     " };
    let text = `write-speed microbench · ${N} files · 64 B each\n\nphase                 median     95th    worst   (ms)\n`;
    for (const [k, xs] of Object.entries(legs)) {
      const st = stats(xs);
      text += `${names[k]} ${pad(st.p50)}  ${pad(st.p95)}  ${pad(st.max)}\n`;
    }
    $("bench-out").textContent = text;
    $("copy-row").onclick = () => navigator.clipboard.writeText(text);
    $("bench-details").hidden = false;
    log(`write bench: total p50 ${ms(total.p50)}ms, commit p50 ${ms(commit.p50)}ms`);
    reporter.event("write-bench", {
      files: N,
      legs: Object.fromEntries(Object.entries(legs).map(([k, xs]) => [k, stats(xs)])),
    });
  } finally {
    $("progress").hidden = true;
    btn.disabled = false;
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

$("run-observer-lab").onclick = guard(async () => {
  const btn = $("run-observer-lab");
  btn.disabled = true;
  $("verdict").hidden = true;
  const out = $("bench-out");
  $("bench-details").hidden = false;
  out.textContent = "observer lab running…";
  const results = { support: hasObserver, matrix: [], isolated: {}, burst: {}, echo: {} };
  const lines = [];
  const say = (s) => {
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
    let labDir = null;
    try {
      labDir = await client.fsioDir.getDirectoryHandle("obs-lab", { create: true });
    } catch (e) {
      say(`   (couldn't create scratch dir: ${e.name})`);
    }
    const targets = [
      ["picked folder", client.root],
      [".fsio", client.fsioDir],
      ...(labDir ? [["fresh subfolder", labDir]] : []),
    ];
    for (const [label, handle] of targets) {
      for (const recursive of [false, true]) {
        let err = null;
        let obs = null;
        try {
          obs = new FileSystemObserver(() => {});
          await obs.observe(handle, { recursive });
        } catch (e) {
          err = `${e.name}: ${e.message}`;
        }
        obs?.disconnect();
        results.matrix.push({ target: label, recursive, ok: !err, err });
        say(`   ${err ? "❌" : "✅"} ${label} recursive=${recursive}${err ? " — " + err : ""}`);
      }
    }

    // ---- B & C need a working observer on the lab dir
    let labEvents = [];
    let waiter = null;
    let labObs = null;
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
        say(`   (no working observer on scratch dir: ${e.name} — skipping latency tests)`);
      }
    }

    if (labObs) {
      // ---- B. isolated event latency, by type
      step("observer lab: isolated event latencies");
      say("B. isolated events (5 each, 400ms apart) — latency ms:");
      const measure = async (fn) => {
        const p = new Promise((res) => (waiter = res));
        const t0 = performance.now();
        await fn();
        const t = await Promise.race([p, sleep(2500).then(() => null)]);
        waiter = null;
        return t === null ? null : Math.round((t - t0) * 10) / 10;
      };
      const kinds = {
        "file create ": (i) => labDir.getFileHandle(`f${i}`, { create: true }),
        "file write  ": async (i) => {
          const w = await (await labDir.getFileHandle(`f${i}`)).createWritable();
          await w.write(new TextEncoder().encode("x"));
          await w.close();
        },
        "dir create  ": (i) => labDir.getDirectoryHandle(`d${i}`, { create: true }),
        "dir remove  ": (i) => labDir.removeEntry(`d${i}`),
      };
      for (const [name, fn] of Object.entries(kinds)) {
        const lat = [];
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
      for (let i = 0; i < 20; i++) await labDir.getDirectoryHandle(`burst${i}`, { create: true });
      const tSent = performance.now() - t0;
      await sleep(2000);
      const burst = labEvents.slice(before);
      const batches = new Set(burst.map((e) => Math.round(e.t))).size;
      results.burst = {
        sentIn: Math.round(tSent),
        eventsSeen: burst.length,
        batches,
        firstLatency: burst.length ? Math.round(burst[0].t - t0) : null,
        lastLatency: burst.length ? Math.round(burst[burst.length - 1].t - t0) : null,
      };
      say(`C. burst: 20 mkdirs in ${results.burst.sentIn}ms → ${burst.length} events in ~${batches} callback batch(es), first after ${results.burst.firstLatency}ms, last after ${results.burst.lastLatency}ms`);
      labObs.disconnect();
      try {
        await client.fsioDir.removeEntry("obs-lab", { recursive: true });
      } catch {}
    }

    // ---- D. observer-only echo RTT, isolated pings (needs the helper)
    const host = await refreshHostCheck();
    if (!host.alive) {
      say("D. skipped (helper not running) — matrix + local tests above still stand");
    } else {
      step("observer lab: observer-only echo round trips");
      const session = await client.createSession(
        { kind: "echo", client: "observer-lab" },
        {
          mode: "observer",
          safetyMs: 0, // no safety poll: observer sinks or swims alone
          onNote: (m) => say("   note: " + m),
        }
      );
      say(`D. echo RTT via ${session.mode === "observer" ? "observer only" : "POLLING (observer refused again — see note)"} — 15 pings, 400ms apart:`);
      const rtts = [];
      try {
        for (let i = 0; i < 15; i++) {
          const rtt = await session
            .request("ping", { t0: now() }, { timeoutMs: 4000 })
            .then(({ result, rx }) => rx - result.t0, () => null);
          rtts.push(rtt === null ? null : Math.round(rtt * 10) / 10);
          await sleep(400);
        }
      } finally {
        await session.close().catch(() => {});
      }
      results.echo = { mode: session.mode, rtts };
      const good = rtts.filter((x) => x !== null);
      say(`   ${rtts.map((x) => (x === null ? "lost" : x)).join("  ")}`);
      if (good.length) {
        const s = stats(good);
        say(`   → p50 ${ms(s.p50)}ms, min ${ms(s.min)}, max ${ms(s.max)}, lost ${rtts.length - good.length}/${rtts.length}`);
      }
    }

    say("\ndone — full data in .fsio/client/report.json");
    reporter.event("observer-lab", results);
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- terminal

let term = null;
let fit = null;
let termSession = null;

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
  $("open-term").disabled = true;
  $("term").hidden = false;

  if (!term) {
    term = new Terminal({ fontSize: 13, theme: { background: "#14161a" } });
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open($("term"));
    new ResizeObserver(() => {
      fit.fit();
      termSession?.notify("resize", { cols: term.cols, rows: term.rows });
    }).observe($("term"));
  }
  fit.fit();
  term.reset();

  const dec = new TextDecoder();
  step("creating the shell session");
  termSession = await client.createSession(
    { kind: "shell", cols: term.cols, rows: term.rows },
    {
      onError: (e) => showError("Sending to the shell failed.", e.message),
      onNote: (m) => log("note:", m),
      onFrame: (f) => {
        if (f.type === FrameType.DATA) term.write(dec.decode(f.payload));
      },
    }
  );
  termSession.onStatus = (st) => {
    reporter.event("terminal-status", st);
    if (st.state === "exited") {
      $("term-status").textContent = `the shell exited${st.exitCode != null ? ` (code ${st.exitCode})` : ""}`;
      $("open-term").disabled = false;
      $("close-term").disabled = true;
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
    $("term-status").textContent = info.pty === false
      ? "connected (basic mode — install node-pty and restart the helper for the full experience)"
      : "connected — type away";
  } catch (e) {
    showError("The helper refused to start a shell.", e.message);
    $("open-term").disabled = false;
    await termSession.close().catch(() => {});
    termSession = null;
    return;
  }
  term.onData((d) => termSession.sendData(d));
  term.focus();
  $("close-term").disabled = false;
  log(`terminal session ${termSession.id}`);
});

$("close-term").onclick = guard(async () => {
  await termSession?.close();
  termSession = null;
  $("term-status").textContent = "closed";
  $("close-term").disabled = true;
  $("open-term").disabled = false;
});
