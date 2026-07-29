// Tab lifecycle (#34): one xterm + one FsioSession per tab, all over the
// single client. The protocol already handles N sessions per client — this
// file is purely page-side state. xterm instances are imperative islands:
// Lit renders chrome around the slotted host divs, never inside them.
import { signal } from "@lit-labs/signals";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { tabs, activeTabId, type TabRecord, type TabPhase } from "./state";
import { reporter, log, step, showNotice } from "./reporter";
import { getClient, arrive, refreshResumable } from "./connection";

let nextTabId = 1;

reporter.tabSummary = () =>
  tabs.get().map((t) => ({
    tab: t.tabId,
    session: t.sessionId,
    state: t.state.get(),
    active: t.tabId === activeTabId.get(),
  }));

const pane = (): HTMLElement => document.querySelector("fsio-terminal-pane")!;

/** Open a new tab: fresh shell, or resume an existing session (#58/D18).
 *  A session already held by a tab just gets focused — resuming into two
 *  tabs of one page would fence our own writer. */
export function openTab(resumeId?: string): void {
  const client = getClient();
  if (!client) return;
  if (resumeId) {
    const existing = tabs.get().find((t) => t.sessionId === resumeId && t.session);
    if (existing) return setActiveTab(existing.tabId);
  }
  const host = document.createElement("div");
  host.className = "term-host";
  const term = new Terminal({ fontSize: 13, theme: { background: "#14161a" } });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const tabId = nextTabId++;
  const tab: TabRecord = {
    tabId,
    sessionId: null,
    session: null,
    title: signal(`shell ${tabId}`),
    state: signal<TabPhase>("starting"),
    detail: signal(""),
    host,
    term,
    fit,
  };
  pane().append(host);
  term.open(host);
  term.onData((d) => {
    try {
      tab.session?.sendData(d);
    } catch {} // superseded fence poisons send(); the overlay tells the story
  });
  new ResizeObserver(() => {
    // Skip while unslotted (box is 0×0): FitAddon would propose garbage.
    if (host.offsetWidth === 0 || host.offsetHeight === 0) return;
    fit.fit();
    try {
      tab.session?.notify("resize", { cols: term.cols, rows: term.rows });
    } catch {}
  }).observe(host);
  tabs.set([...tabs.get(), tab]);
  setActiveTab(tab.tabId);
  void startSession(tab, resumeId);
}

/** Tab switch = moving one attribute: the active host gets slot="active",
 *  the rest unslot (unrendered — exactly one terminal in layout). Leans on
 *  the default DOM renderer: a canvas/WebGL addon could glitch reviving a
 *  0×0 terminal. */
export function setActiveTab(tabId: number): void {
  activeTabId.set(tabId);
  for (const t of tabs.get()) {
    if (t.tabId === tabId) t.host.setAttribute("slot", "active");
    else t.host.removeAttribute("slot");
  }
  requestAnimationFrame(() => {
    const t = tabs.get().find((x) => x.tabId === tabId);
    if (!t || t.host.offsetWidth === 0) return; // re-slot hasn't laid out yet; RO will fit
    t.fit.fit();
    t.term.focus();
  });
}

async function startSession(tab: TabRecord, resumeId?: string): Promise<void> {
  const client = getClient();
  if (!client || tab.session) return;
  tab.term.reset();
  tab.state.set("starting");
  tab.detail.set(resumeId ? "reattaching…" : "starting your shell…");
  step(resumeId ? `reattaching to ${resumeId}` : "starting the shell");
  const s = resumeId
    ? client.attachSession(resumeId, { replay: true, client: "terminal-demo" })
    : client.createSession({ kind: "shell", cols: tab.term.cols, rows: tab.term.rows, client: "terminal-demo" });
  tab.session = s;
  tab.sessionId = s.id;
  // Supersede detection must wait for `ready`: while our own attach is in
  // flight, status.json already shows OUR grant's epoch, but s.epoch is
  // still 0 — checking early misreads the grant as a takeover (caught by
  // the first cooperative run: a bogus banner on every reattach).
  let settled = false;
  const showSuperseded = (epoch: number): void => {
    reporter.event("superseded", { id: s.id, byEpoch: epoch, tab: tab.tabId });
    tab.state.set("superseded");
    tab.detail.set("another tab took this shell over — watching read-only");
  };
  s.on("error", (e) => showNotice("Sending to the shell failed.", e.message));
  s.on("note", (m) => log("note:", m));
  s.on("data", (b) => tab.term.write(b));
  s.on("status", (st) => {
    reporter.event("terminal-status", { id: s.id, tab: tab.tabId, ...st });
    if (tab.session !== s) return;
    if (st.state === "exited") {
      tab.state.set("exited");
      tab.detail.set(`shell exited${st.exitCode != null ? ` (code ${st.exitCode})` : ""}`);
      tab.session = null; // host owns cleanup (D6); nothing to close
    }
    // Supersede fence (D18): a higher writer epoch means another tab took
    // the uplink over. Reads continue (the terminal becomes a live
    // read-only view of the other tab's shell); sends are poisoned. A
    // first-class `superseded` event is #41 layer 1 — until then the
    // status stream is the classifier.
    if (settled && st.writer && st.writer.epoch > s.epoch && tab.state.get() === "running") showSuperseded(st.writer.epoch);
  });
  try {
    const info = await Promise.race([
      s.ready,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`the helper never answered the ${resumeId ? "attach" : "spawn"} request (waited 8 s)`)), 8000)
      ),
    ]);
    reporter.event(resumeId ? "shell-reattached" : "shell-ready", { id: s.id, tab: tab.tabId, ...info });
    tab.state.set("running");
    tab.detail.set(
      resumeId ? `reattached — scrollback replayed · pid ${info.pid}` : `connected — this is your machine · pid ${info.pid}`
    );
    settled = true;
    // A takeover that raced our attach window surfaces here (the status
    // dedup means it won't re-emit on its own).
    const st = s.status;
    if (st?.writer && st.writer.epoch > s.epoch && tab.session === s) showSuperseded(st.writer.epoch);
    if (resumeId) {
      // The pty still has the previous holder's geometry; ours may differ.
      try {
        s.notify("resize", { cols: tab.term.cols, rows: tab.term.rows });
      } catch {}
    }
    tab.term.focus();
    log(`shell session ${s.id} (pid ${info.pid}${resumeId ? `, writer epoch ${s.epoch}` : `, pty ${info.pty}`})`);
  } catch (e) {
    reporter.event(resumeId ? "reattach-failed" : "shell-failed", { id: s.id, tab: tab.tabId, error: e instanceof Error ? e.message : String(e) });
    showNotice(resumeId ? "Couldn't reattach to that shell." : "The helper refused to start a shell.", e instanceof Error ? e.message : String(e));
    tab.state.set("failed");
    tab.detail.set(resumeId ? "reattach failed — it may have exited out from under us" : "shell failed to start");
    await s.close().catch(() => {});
    if (tab.session === s) tab.session = null;
    void refreshResumable();
  }
}

/** Close = end the session (D6-clean close; the host kills the pty and owns
 *  cleanup). Deliberately distinct from detach — closing is honest about
 *  killing, so a live shell asks first. */
export async function closeTab(tab: TabRecord): Promise<void> {
  const st = tab.state.get();
  const s = tab.session;
  if (s && (st === "running" || st === "starting")) {
    if (!confirm("Close this shell? The session ends and the shell process is killed.\n(Use “detach” instead to keep it running.)")) return;
  }
  reporter.event("tab-close", { tab: tab.tabId, session: tab.sessionId, state: st });
  tab.session = null;
  // A superseded tab no longer holds the uplink — close() can't reach the
  // host; detach() tears down timers/listeners locally.
  if (s) await (st === "superseded" ? s.detach() : s.close()).catch(() => {});
  removeTab(tab);
}

/** Deliberate walk-away (#58/D18): mark the session detached NOW, so the
 *  picker shows it as unambiguously resumable — no waiting out the
 *  heartbeat-silence window (D17, 3 min default). The shell keeps running. */
export async function detachTab(tab: TabRecord): Promise<void> {
  const s = tab.session;
  if (!s) return;
  tab.session = null;
  reporter.event("detach", { id: s.id, tab: tab.tabId });
  await s.detach().catch(() => {});
  log(`detached ${s.id} — the shell keeps running; resume it from the + menu`);
  removeTab(tab);
  if (tabs.get().length === 0) void arrive(); // straight back to the picker
}

/** Re-take a superseded session (#58): locally release the fenced session
 *  (detach() can't reach the host — the uplink is gone — but tears down
 *  timers/listeners), then attach anew, bumping the epoch back our way. */
export async function retakeTab(tab: TabRecord): Promise<void> {
  const s = tab.session;
  if (!s || tab.state.get() !== "superseded") return;
  tab.session = null;
  reporter.event("retake", { id: s.id, tab: tab.tabId });
  await s.detach().catch(() => {});
  void startSession(tab, s.id);
}

/** Restart in place (exited or failed tab): same tab, same xterm, new
 *  session. */
export function restartTab(tab: TabRecord): void {
  if (tab.session) return;
  void startSession(tab);
}

function removeTab(tab: TabRecord): void {
  tab.term.dispose();
  tab.host.remove();
  const rest = tabs.get().filter((t) => t !== tab);
  tabs.set(rest);
  if (activeTabId.get() === tab.tabId) {
    const next = rest[rest.length - 1];
    if (next) setActiveTab(next.tabId);
    else activeTabId.set(null);
  }
}

/** Focus the active terminal — a modal wizard/picker swallows focus while
 *  it's up; call this when it dissolves. */
export function focusActive(): void {
  const t = tabs.get().find((x) => x.tabId === activeTabId.get());
  if (t) requestAnimationFrame(() => t.term.focus());
}

/** Tab-close detach (best-effort): the detach notification rides a dirname-
 *  lane commit (~3 ms, F10), which usually beats teardown; when it loses,
 *  the heartbeat-silence GC (D17) marks the session detached a few minutes
 *  later — same end state, just slower. */
export function detachAllOnPagehide(): void {
  for (const t of tabs.get()) void t.session?.detach().catch(() => {});
}
