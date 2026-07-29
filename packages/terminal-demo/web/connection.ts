// Folder → client plumbing: gates, the persisted-handle revisit path (#58),
// connect, helper heartbeat, and the session-picker data feed. Writes
// signals (state.ts); owns the FsioClient singleton.
import { FsioClient, type SessionSummary } from "@fsio/client";
import { reporter, log, step } from "./reporter";
import { gate, phase, wizardStep, folder, reconnectTo, helper, pickError, resumable, tabs } from "./state";
import { openTab, focusActive } from "./tabs";

let client: FsioClient | null = null;
export const getClient = (): FsioClient | null => client;

// ---------------------------------------------------------------- gates

export function checkGates(): void {
  // Chrome gate: the page needs the File System Access API (picker) and, for
  // decent latency, FileSystemObserver. Anything else gets a graceful no.
  if (typeof showDirectoryPicker !== "function") {
    gate.set({
      msg: "This demo needs Chrome (or a Chromium browser).",
      hint: "It's built on the File System Access API — the page talks to your machine through files in a folder you grant it. That API hasn't shipped elsewhere yet.",
    });
  }
}

/** The mac note is louder when the page isn't on a Mac (the helper is
 *  macOS-only — sandbox-exec); the wizard renders accordingly. */
export const onMac = navigator.platform.startsWith("Mac");

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

/** On load: a remembered handle skips the wizard. "granted" connects with
 *  zero clicks; "prompt" needs one (requestPermission requires a user
 *  activation, F15) — the reconnect offer; "denied" forgets and falls back
 *  to the wizard. */
export async function revisit(): Promise<void> {
  if (gate.get()) return; // non-Chrome: the gate panel already speaks
  let saved: FileSystemDirectoryHandle | null = null;
  try {
    saved = await savedHandle();
  } catch {} // IndexedDB unavailable (private mode etc.) — wizard path works
  if (!saved) return void phase.set("wizard");
  let perm: FsaPermissionState;
  try {
    perm = await saved.queryPermission({ mode: "readwrite" });
  } catch {
    return void phase.set("wizard");
  }
  reporter.event("revisit", { folder: saved.name, permission: perm });
  log(`remembered folder ${saved.name}/ — permission on load: ${perm}`);
  if (perm === "granted") {
    await connectTo(saved, "restored");
  } else if (perm === "prompt") {
    reconnectTo.set(saved);
    phase.set("reconnect");
  } else {
    await forgetHandle().catch(() => {});
    phase.set("wizard");
  }
}

/** The reconnect offer's button ("prompt" → one click, F15). */
export async function regrant(): Promise<void> {
  const h = reconnectTo.get();
  if (!h) return;
  step("asking Chrome to re-grant the folder");
  const res = await h.requestPermission({ mode: "readwrite" });
  reporter.event("regrant", { folder: h.name, result: res });
  if (res !== "granted") return;
  reconnectTo.set(null);
  await connectTo(h, "regranted");
}

// ---------------------------------------------------------------- connect

let hostTimer: ReturnType<typeof setInterval> | undefined;
let helperWasAlive = false;

export async function pickFolder(): Promise<void> {
  pickError.set(null);
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
  pickError.set(null);
  folder.set({ name: root.name, via });
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
    helper.set("none");
    pickError.set({
      msg: `no helper in ${root.name}/`,
      hint: "Is the command from step 1 running, and in exactly this folder? The helper creates a .fsio directory there — we don't see one. (Nothing was written to the folder you just picked.)",
    });
    log(`no .fsio in ${root.name}/ — helper not running there`);
    phase.set("wizard");
    wizardStep.set(2);
    return;
  }
  try {
    client = new FsioClient(root);
    await client.connect();
    await reporter.attach(fsioDir);
    reporter.event("connected", { folder: root.name, via });
  } catch (e) {
    pickError.set({ msg: `could not open ${root.name}/.fsio`, hint: e instanceof Error ? e.message : String(e) });
    reporter.event("connect-failed", { folder: root.name, error: e instanceof Error ? e.message : String(e) });
    phase.set("wizard");
    wizardStep.set(2);
    return;
  }
  // Remember the handle only once a helper folder connected — a mispick
  // must not become next visit's auto-connect target.
  void saveHandle(root).catch(() => {});
  helperWasAlive = false;
  await refreshHelper();
  hostTimer = setInterval(() => void refreshHelper(), 2000);
  // Connected but no heartbeat yet: the wizard explains (step 2 shows the
  // wait status; a revisit whose helper isn't running re-opens at step 1,
  // the command). The first heartbeat calls arrive() and dissolves it.
  if (helper.get() !== "alive") {
    wizardStep.set(via === "picked" ? 2 : 1);
    phase.set("wizard");
  }
}

async function refreshHelper(): Promise<void> {
  if (!client) return;
  const host = await client.hostInfo();
  if (host.alive) {
    helper.set("alive");
    if (!helperWasAlive) {
      helperWasAlive = true;
      reporter.event("helper-alive", { info: host.info ?? null });
      // The payoff frame: folder + helper = shell. With running shells
      // already in the folder the picker intercepts (#58, revisit story);
      // otherwise the no-third-click path (#16 storyboard) — straight in.
      void arrive();
    }
  } else {
    helperWasAlive = false;
    helper.set("silent");
  }
}

// ------------------------------------------------------- session picker (#58)
// listSessions() is the picker's whole data source: kind, client tag,
// origin, status.detached (orphans), status.writer (who holds the uplink).

async function listResumable(): Promise<SessionSummary[]> {
  if (!client) return [];
  const held = new Set(tabs.get().filter((t) => t.session).map((t) => t.sessionId));
  try {
    return (await client.listSessions()).filter(
      (s) => s.kind === "shell" && s.status?.state === "running" && !held.has(s.id)
    );
  } catch {
    return []; // a torn scan (host GC mid-list) reads as empty; next refresh corrects
  }
}

/** Refresh the resumable list (the "+" menu calls this on open). */
export async function refreshResumable(): Promise<void> {
  resumable.set(await listResumable());
}

/** First helper heartbeat, or last tab detached: offer the picker if there
 *  is anything to resume, else open a shell straight away. No-op once tabs
 *  exist — a helper restart must not spawn surprise tabs. */
export async function arrive(): Promise<void> {
  if (!client || tabs.get().length > 0) return;
  const rows = await listResumable();
  reporter.event("sessions-listed", { resumable: rows.length, detached: rows.filter((r) => r.status?.detached).length });
  resumable.set(rows);
  if (rows.length === 0) {
    phase.set("shell");
    openTab();
    return;
  }
  step("offering the session picker");
  phase.set("picker");
  clearInterval(pickerTimer);
  pickerTimer = setInterval(() => void refreshPicker(), 2000);
}

let pickerTimer: ReturnType<typeof setInterval> | undefined;

async function refreshPicker(): Promise<void> {
  if (phase.get() !== "picker") return void clearInterval(pickerTimer);
  const rows = await listResumable();
  resumable.set(rows);
  // Everything resumed (or exited out from under us) → nothing left to pick.
  if (rows.length === 0 && tabs.get().length > 0) dismissPicker();
}

/** Leave the picker for the terminal; a first shell opens if none resumed. */
export function dismissPicker(): void {
  clearInterval(pickerTimer);
  phase.set("shell");
  if (tabs.get().length === 0) openTab();
  else focusActive(); // the modal picker had the focus until now
}
