// terminal-demo page (#16 S4): one path — run helper, pick folder, get a
// sandboxed shell. Deliberately small; the measurement workbench keeps all
// the labs. Self-reports into <folder>/.fsio/client/{log.txt,report.json}
// for the cooperative verification loop (TESTING.md: the page reports, the
// native side reads verdicts).
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { FsioClient, FsioSession, hasObserver } from "@fsio/client";

const $ = (id: string): HTMLElement => document.getElementById(id)!;

// ---------------------------------------------------------------- reporter
// (Workbench's Reporter, trimmed: same files, same contract.)

let lastStep = "loading";
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
  step(`connecting to ${root.name}/`);
  $("pick-name").textContent = `${root.name}/`;
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
    reporter.event("connected", { folder: root.name });
  } catch (e) {
    setHelperStatus("bad", `could not open ${root.name}/.fsio`, e instanceof Error ? e.message : String(e));
    reporter.event("connect-failed", { folder: root.name, error: e instanceof Error ? e.message : String(e) });
    return;
  }
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
      // The payoff frame: folder picked + helper alive = open the shell.
      // One path, no third click (#16 storyboard).
      void openTerminal();
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

// ---------------------------------------------------------------- terminal

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let session: FsioSession | null = null;

$("restart").onclick = () => void openTerminal();

async function openTerminal(): Promise<void> {
  if (!client || session) return;
  $("step3").hidden = false;
  $("restart").hidden = true;
  if (!term) {
    term = new Terminal({ fontSize: 13, theme: { background: "#14161a" } });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open($("term"));
    term.onData((d) => session?.sendData(d));
    new ResizeObserver(() => {
      fit!.fit();
      session?.notify("resize", { cols: term!.cols, rows: term!.rows });
    }).observe($("term"));
  }
  fit!.fit();
  term.reset();
  $("term-status").textContent = "starting your shell…";

  step("starting the shell");
  const s = (session = client.createSession({ kind: "shell", cols: term.cols, rows: term.rows, client: "terminal-demo" }));
  s.on("error", (e) => notice("Sending to the shell failed.", e.message));
  s.on("note", (m) => log("note:", m));
  s.on("data", (b) => term!.write(b));
  s.on("status", (st) => {
    reporter.event("terminal-status", { ...st });
    if (st.state === "exited") {
      $("term-status").textContent = `shell exited${st.exitCode != null ? ` (code ${st.exitCode})` : ""}`;
      $("restart").hidden = false;
      session = null;
    }
  });
  try {
    const info = await Promise.race([
      s.ready,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("the helper never answered the spawn request (waited 8 s)")), 8000)),
    ]);
    reporter.event("shell-ready", { ...info });
    $("term-status").textContent = "connected — this is your machine";
    term.focus();
    log(`shell session ${s.id} (pid ${info.pid}, pty ${info.pty})`);
  } catch (e) {
    reporter.event("shell-failed", { error: e instanceof Error ? e.message : String(e) });
    notice("The helper refused to start a shell.", e instanceof Error ? e.message : String(e));
    $("term-status").textContent = "shell failed to start";
    $("restart").hidden = false;
    await s.close().catch(() => {});
    session = null;
  }
}

step("waiting for a folder");
