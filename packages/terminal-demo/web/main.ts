// terminal-demo page (#16 S4): one path — run helper, pick folder, get a
// sandboxed shell. Deliberately small; the measurement workbench keeps all
// the labs. Self-reports into <folder>/.fsio/client/<clientId>/{log.txt,report.json}
// for the cooperative verification loop (TESTING.md: the page reports, the
// native side reads verdicts).
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { FsioClient, FsioSession, hasObserver, type SessionSummary } from "@fsio/client";

const $ = (id: string): HTMLElement => document.getElementById(id)!;

// ---------------------------------------------------------------- reporter
// (Workbench's Reporter, trimmed: same files, same contract.)

let lastStep = "loading";
class Reporter {
  // Per-page dir (#39): two pages on one shared dir must not fight over the
  // same report files (one writer per file, F8). Same id shape as sessions.
  readonly clientId = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  lines: string[] = [];
  events: Record<string, unknown>[] = [];
  dirty = false;
  dir: FileSystemDirectoryHandle | null = null;
  flushing = false;
  lastWrite = 0;
  timer: ReturnType<typeof setInterval> | undefined;

  async attach(fsioDir: FileSystemDirectoryHandle): Promise<void> {
    const clientRoot = await fsioDir.getDirectoryHandle("client", { create: true });
    this.dir = await clientRoot.getDirectoryHandle(this.clientId, { create: true });
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.flush(), 1000);
    this.dirty = true;
    void this.flush();
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
    if (!this.dirty && Date.now() - this.lastWrite < 5000) return;
    this.flushing = true;
    this.dirty = false;
    this.lastWrite = Date.now();
    try {
      await this.write("log.txt", this.lines.join("\n") + "\n");
      await this.write(
        "report.json",
        JSON.stringify(
          {
            updated: new Date().toISOString(),
            clientId: this.clientId,
            page: "terminal-demo",
            origin: location.origin,
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

  private async write(name: string, text: string): Promise<void> {
    const fh = await this.dir!.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>);
    await w.close();
  }
}
const reporter = new Reporter();

const logEl = $("logview");
function log(...a: unknown[]): void {
  const line = a.map((x) => (x instanceof Error ? (x.stack ?? x.message) : String(x))).join(" ");
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
  console.log(...a);
  reporter.log(line);
}
function step(s: string): void {
  lastStep = s;
  log(`— ${s}`);
}

function notice(msg: string, hint = ""): void {
  $("notice-msg").textContent = msg;
  $("notice-hint").textContent = hint;
  $("notice").hidden = false;
  reporter.event("notice", { msg, hint, step: lastStep });
}
const clearNotice = () => ($("notice").hidden = true);

// ---------------------------------------------------------------- gates

// Chrome gate: the page needs the File System Access API (picker) and, for
// decent latency, FileSystemObserver. Anything else gets a graceful no.
if (typeof showDirectoryPicker !== "function") {
  notice(
    "This demo needs Chrome (or a Chromium browser).",
    "It's built on the File System Access API — the page talks to your machine through files in a folder you grant it. That API hasn't shipped elsewhere yet."
  );
  ($("pick") as HTMLButtonElement).disabled = true;
}
// Mac note is static text; make it louder when the *page* isn't on a Mac
// (the helper is macOS-only — sandbox-exec).
if (!navigator.platform.startsWith("Mac")) {
  $("mac-note").innerHTML = "<strong>Heads up: the helper is macOS-only for now</strong> (its sandbox is built on Apple's Seatbelt). The page will connect from anywhere, but the helper side needs a Mac.";
}

// ---------------------------------------------------------------- copy

$("copy-cmd").onclick = () => void navigator.clipboard.writeText($("helper-cmd").textContent ?? "");
$("copy-log").onclick = () => void navigator.clipboard.writeText(logEl.textContent ?? "");

// ---------------------------------------------------- persisted handle (#58)
// The revisit story: the FileSystemDirectoryHandle survives in IndexedDB;
// what Chrome does with the *grant* across visits is the measured quantity
// (the reporter records the permission state seen at every load — findings
// fodder for whether "Allow on every visit" spans browser restarts).

const IDB_NAME = "fsio-terminal-demo";
const IDB_KEY = "root";

function idbReq<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const open = indexedDB.open(IDB_NAME, 1);
  open.onupgradeneeded = () => open.result.createObjectStore("handles");
  const db = await idbReq(open);
  return db.transaction("handles", mode).objectStore("handles");
}

const savedHandle = async (): Promise<FileSystemDirectoryHandle | null> =>
  ((await idbReq((await idbStore("readonly")).get(IDB_KEY))) as FileSystemDirectoryHandle | undefined) ?? null;
const saveHandle = async (h: FileSystemDirectoryHandle): Promise<unknown> => idbReq((await idbStore("readwrite")).put(h, IDB_KEY));
const forgetHandle = async (): Promise<unknown> => idbReq((await idbStore("readwrite")).delete(IDB_KEY));

// On load: a remembered handle skips the picker. "granted" connects with
// zero clicks; "prompt" needs one (requestPermission requires a user
// activation, F15) — the reconnect button; "denied" forgets and falls back.
async function revisit(): Promise<void> {
  if (typeof showDirectoryPicker !== "function") return; // non-Chrome gate already spoke
  let saved: FileSystemDirectoryHandle | null = null;
  try {
    saved = await savedHandle();
  } catch {} // IndexedDB unavailable (private mode etc.) — picker path works
  if (!saved) return;
  let perm: FsaPermissionState;
  try {
    perm = await saved.queryPermission({ mode: "readwrite" });
  } catch {
    return;
  }
  reporter.event("revisit", { folder: saved.name, permission: perm });
  log(`remembered folder ${saved.name}/ — permission on load: ${perm}`);
  if (perm === "granted") {
    await connectTo(saved, "restored");
  } else if (perm === "prompt") {
    const h = saved;
    const btn = $("reconnect") as HTMLButtonElement;
    btn.textContent = `Reconnect to ${h.name}/`;
    btn.hidden = false;
    btn.onclick = () =>
      void (async () => {
        step("asking Chrome to re-grant the folder");
        const res = await h.requestPermission({ mode: "readwrite" });
        reporter.event("regrant", { folder: h.name, result: res });
        if (res !== "granted") return;
        btn.hidden = true;
        await connectTo(h, "regranted");
      })();
  } else {
    await forgetHandle().catch(() => {});
  }
}

// ---------------------------------------------------------------- connect

let client: FsioClient | null = null;
let hostTimer: ReturnType<typeof setInterval> | undefined;
let helperWasAlive = false;

function setHelperStatus(kind: "ok" | "wait" | "bad", msg: string, hint = ""): void {
  const el = $("chk-helper");
  el.hidden = false;
  el.className = `status ${kind}`;
  el.innerHTML = "";
  el.append(msg);
  if (hint) {
    const h = document.createElement("span");
    h.className = "hint";
    h.textContent = hint;
    el.append(h);
  }
}

$("pick").onclick = () => void pick();
async function pick(): Promise<void> {
  clearNotice();
  step("opening the folder picker");
  let root: FileSystemDirectoryHandle;
  try {
    root = await showDirectoryPicker({ mode: "readwrite" });
  } catch {
    return; // user cancelled — not an error
  }
  await connectTo(root, "picked");
}

async function connectTo(root: FileSystemDirectoryHandle, via: "picked" | "restored" | "regranted"): Promise<void> {
  step(`connecting to ${root.name}/`);
  $("pick-name").textContent = `${root.name}/${via === "picked" ? "" : " (remembered from last visit)"}`;
  clearInterval(hostTimer);
  // Probe for .fsio WITHOUT creating it: connect() would `create: true` a
  // .fsio into whatever folder was picked — in the wrong-folder case that
  // littered the user's folder and made the "no helper here" state
  // unreachable (found by the S4 cooperative loop, first click).
  let fsioDir: FileSystemDirectoryHandle;
  try {
    fsioDir = await root.getDirectoryHandle(".fsio");
  } catch {
    client = null;
    setHelperStatus(
      "bad",
      `no helper in ${root.name}/`,
      "Is the command from step 1 running, and in exactly this folder? The helper creates a .fsio directory there — we don't see one. (Nothing was written to the folder you just picked.)"
    );
    log(`no .fsio in ${root.name}/ — helper not running there`);
    return;
  }
  try {
    client = new FsioClient(root);
    await client.connect();
    await reporter.attach(fsioDir);
    reporter.event("connected", { folder: root.name, via });
  } catch (e) {
    setHelperStatus("bad", `could not open ${root.name}/.fsio`, e instanceof Error ? e.message : String(e));
    reporter.event("connect-failed", { folder: root.name, error: e instanceof Error ? e.message : String(e) });
    return;
  }
  // Remember the handle only once a helper folder connected — a mispick
  // must not become next visit's auto-connect target.
  void saveHandle(root).catch(() => {});
  $("reconnect").hidden = true;
  helperWasAlive = false;
  await refreshHelper();
  hostTimer = setInterval(() => void refreshHelper(), 2000);
}

async function refreshHelper(): Promise<void> {
  if (!client) return;
  const host = await client.hostInfo();
  if (host.alive) {
    setHelperStatus("ok", "helper found — its heartbeat is in the folder");
    $("step2").classList.add("done");
    $("step1").classList.add("done");
    if (!helperWasAlive) {
      helperWasAlive = true;
      reporter.event("helper-alive", { info: host.info ?? null });
      // The payoff frame: folder + helper = shell. With running shells
      // already in the folder the picker intercepts (#58, revisit story);
      // otherwise the original no-third-click path (#16 storyboard).
      void arrive();
    }
  } else {
    helperWasAlive = false;
    setHelperStatus(
      "wait",
      "folder connected, but no helper heartbeat",
      "The helper writes a heartbeat every 2 seconds; we're not seeing it. Is it still running in this exact folder?"
    );
  }
}

// ------------------------------------------------------- session picker (#58)
// listSessions() is the picker's whole data source: kind, client tag,
// origin, status.detached (orphans), status.writer (who holds the uplink).

async function listResumable(): Promise<SessionSummary[]> {
  if (!client) return [];
  try {
    return (await client.listSessions()).filter((s) => s.kind === "shell" && s.status?.state === "running");
  } catch {
    return []; // a torn scan (host GC mid-list) reads as empty; next refresh corrects
  }
}

async function arrive(): Promise<void> {
  if (!client || session) return;
  const rows = await listResumable();
  reporter.event("sessions-listed", { resumable: rows.length, detached: rows.filter((r) => r.status?.detached).length });
  if (rows.length === 0) return void openTerminal();
  step("offering the session picker");
  showPicker(rows);
}

let pickerTimer: ReturnType<typeof setInterval> | undefined;

function showPicker(rows: SessionSummary[]): void {
  $("step3").hidden = true;
  $("picker").hidden = false;
  renderPicker(rows);
  clearInterval(pickerTimer);
  pickerTimer = setInterval(() => void refreshPicker(), 2000);
}

function hidePicker(): void {
  $("picker").hidden = true;
  clearInterval(pickerTimer);
}

async function refreshPicker(): Promise<void> {
  if (session) return hidePicker();
  renderPicker(await listResumable());
}

function renderPicker(rows: SessionSummary[]): void {
  const list = $("session-list");
  list.textContent = "";
  if (rows.length === 0) {
    const p = document.createElement("p");
    p.className = "fineprint";
    p.textContent = "no running shells right now — start a new one below.";
    list.append(p);
    return;
  }
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "sess";
    const info = document.createElement("div");
    info.className = "sess-info";
    const id = document.createElement("code");
    id.textContent = r.id;
    const hint = document.createElement("span");
    hint.className = "hint";
    // Takeover is deliberate (D18): resuming a held session fences the
    // holder instantly — that's what makes plain refresh work with no
    // 3-minute detach window. Say so instead of hiding it.
    hint.textContent = r.status?.detached
      ? "detached — no tab is holding it, safe to resume"
      : `held by ${r.client ?? "another client"}${r.origin ? ` at ${r.origin}` : ""} — resuming takes it over (that tab keeps watching, read-only)`;
    info.append(id, hint);
    const btn = document.createElement("button");
    btn.className = "small";
    btn.textContent = "resume";
    btn.onclick = () => void openTerminal(r.id);
    row.append(info, btn);
    list.append(row);
  }
}

$("new-shell").onclick = () => void openTerminal();

// ---------------------------------------------------------------- terminal

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let session: FsioSession | null = null;

$("restart").onclick = () => void openTerminal();

async function openTerminal(resumeId?: string): Promise<void> {
  if (!client || session) return;
  hidePicker();
  clearNotice();
  $("step3").hidden = false;
  $("restart").hidden = true;
  $("detach").hidden = true;
  $("superseded").hidden = true;
  if (!term) {
    term = new Terminal({ fontSize: 13, theme: { background: "#14161a" } });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open($("term"));
    term.onData((d) => {
      try {
        session?.sendData(d);
      } catch {} // superseded fence poisons send(); the banner tells the story
    });
    new ResizeObserver(() => {
      fit!.fit();
      try {
        session?.notify("resize", { cols: term!.cols, rows: term!.rows });
      } catch {}
    }).observe($("term"));
  }
  fit!.fit();
  term.reset();
  $("term-status").textContent = resumeId ? "reattaching…" : "starting your shell…";

  step(resumeId ? `reattaching to ${resumeId}` : "starting the shell");
  const s = (session = resumeId
    ? client.attachSession(resumeId, { replay: true, client: "terminal-demo" })
    : client.createSession({ kind: "shell", cols: term.cols, rows: term.rows, client: "terminal-demo" }));
  s.on("error", (e) => notice("Sending to the shell failed.", e.message));
  s.on("note", (m) => log("note:", m));
  s.on("data", (b) => term!.write(b));
  s.on("status", (st) => {
    reporter.event("terminal-status", { id: s.id, ...st });
    if (st.state === "exited") {
      $("term-status").textContent = `shell exited${st.exitCode != null ? ` (code ${st.exitCode})` : ""}`;
      $("restart").hidden = false;
      $("detach").hidden = true;
      if (s === session) session = null;
    }
    // Supersede fence (D18): a higher writer epoch means another tab took
    // the uplink over. Reads continue (the terminal becomes a live
    // read-only view of the other tab's shell); sends are poisoned. A
    // first-class `superseded` event is #41 layer 1 — until then the
    // status stream is the classifier.
    if (st.writer && st.writer.epoch > s.epoch && s === session) {
      reporter.event("superseded", { id: s.id, byEpoch: st.writer.epoch });
      $("superseded").hidden = false;
      $("detach").hidden = true;
      $("term-status").textContent = "another tab took this shell over — watching read-only";
    }
  });
  try {
    const info = await Promise.race([
      s.ready,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`the helper never answered the ${resumeId ? "attach" : "spawn"} request (waited 8 s)`)), 8000)),
    ]);
    reporter.event(resumeId ? "shell-reattached" : "shell-ready", { id: s.id, ...info });
    $("term-status").textContent = resumeId ? "reattached — scrollback replayed, shell is live" : "connected — this is your machine";
    $("detach").hidden = false;
    if (resumeId) {
      // The pty still has the previous tab's geometry; ours may differ.
      try {
        s.notify("resize", { cols: term.cols, rows: term.rows });
      } catch {}
    }
    term.focus();
    log(`shell session ${s.id} (pid ${info.pid}${resumeId ? `, writer epoch ${s.epoch}` : `, pty ${info.pty}`})`);
  } catch (e) {
    reporter.event(resumeId ? "reattach-failed" : "shell-failed", { id: s.id, error: e instanceof Error ? e.message : String(e) });
    notice(resumeId ? "Couldn't reattach to that shell." : "The helper refused to start a shell.", e instanceof Error ? e.message : String(e));
    $("term-status").textContent = resumeId ? "reattach failed" : "shell failed to start";
    await s.close().catch(() => {});
    if (s === session) session = null;
    if (resumeId) {
      $("step3").hidden = true;
      void arrive(); // back to the picker (it may have exited out from under us)
    } else {
      $("restart").hidden = false;
    }
  }
}

// Deliberate walk-away (#58/D18): mark the session detached NOW, so the
// next visit's picker shows it as unambiguously resumable — no waiting out
// the heartbeat-silence window (D17, 3 min default). The shell keeps running.
$("detach").onclick = () =>
  void (async () => {
    const s = session;
    if (!s) return;
    session = null;
    reporter.event("detach", { id: s.id });
    await s.detach().catch(() => {});
    $("step3").hidden = true;
    log(`detached ${s.id} — the shell keeps running; resume it from the picker`);
    void arrive();
  })();

// Re-take a superseded session (#58): locally release the fenced session
// (detach() can't reach the host — the uplink is gone — but tears down
// timers/listeners), then attach anew, bumping the epoch back our way.
$("retake").onclick = () =>
  void (async () => {
    const s = session;
    if (!s) return;
    session = null;
    $("superseded").hidden = true;
    reporter.event("retake", { id: s.id });
    await s.detach().catch(() => {});
    void openTerminal(s.id);
  })();

// Tab-close detach (best-effort): the detach notification rides a dirname-
// lane commit (~3 ms, F10), which usually beats teardown; when it loses,
// the heartbeat-silence GC (D17) marks the session detached a few minutes
// later — same end state, just slower.
window.addEventListener("pagehide", () => void session?.detach().catch(() => {}));
// bfcache restore would revive a page whose session was just torn down —
// reload instead so the revisit path (picker) runs fresh.
window.addEventListener("pageshow", (e) => {
  if (e.persisted) location.reload();
});

step("waiting for a folder");
void revisit();
