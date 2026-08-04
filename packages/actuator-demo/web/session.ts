// Folder → client → the one session this page keeps open.
//
// The page dials (clients create sessions — spec: Session lifecycle) and
// then listens: commands arrive as DATA frames from the helper, the page
// applies them to its own state, and a receipt goes back up the same
// session. Nothing here writes application state into the folder, and the
// folder never tells this page what its state is.
import { FsioClient, type FsioSession } from "@fsio/client";
import { AppError } from "../src/model";
import { asOperation, decodeDownstream, encode, receipt, refusal } from "../src/messages";
import { applyToApp, forgetHandle, loadApp, saveHandle, savedHandle } from "./db";
import { app, displaced, folder, gate, helper, lastCommand, phase, pickError, reconnectTo } from "./state";
import { log, reporter, step } from "./reporter";

let client: FsioClient | null = null;
let session: FsioSession | null = null;
let hostTimer: ReturnType<typeof setInterval> | undefined;
let helperWasAlive = false;
/** The granted folder, kept so a helper restart can re-open `.fsio` — the
 *  handles under it die with the wipe, this one does not. */
let rootHandle: FileSystemDirectoryHandle | null = null;
/** `host.json`'s startedAt, the only durable "is this the same helper". */
let helperStartedAt: number | null = null;

// ---------------------------------------------------------------- gates

export function checkGates(): void {
  if (typeof showDirectoryPicker !== "function") {
    gate.set({
      msg: "This demo needs Chrome (or a Chromium browser).",
      hint: "It's built on the File System Access API — the page talks to your machine through files in a folder you grant it. That API hasn't shipped elsewhere yet.",
    });
  }
}

// ------------------------------------------------------------ the folder

/** On load: a remembered folder skips the picker. "granted" connects with
 *  no clicks at all (F20); "prompt" needs one, because requestPermission
 *  requires a user activation (F15). */
export async function revisit(): Promise<void> {
  await loadApp(); // the app is the page's, and shows before any folder does
  if (gate.get()) return;
  const saved = await savedHandle();
  if (!saved) return void phase.set("setup");
  let permission: FsaPermissionState;
  try {
    permission = await saved.queryPermission({ mode: "readwrite" });
  } catch {
    return void phase.set("setup");
  }
  reporter.event("revisit", { folder: saved.name, permission });
  log(`remembered folder ${saved.name}/ — permission on load: ${permission}`);
  if (permission === "granted") {
    await connectTo(saved, "restored");
  } else if (permission === "prompt") {
    reconnectTo.set(saved);
    phase.set("reconnect");
  } else {
    await forgetHandle();
    phase.set("setup");
  }
}

export async function pickFolder(): Promise<void> {
  pickError.set("");
  step("opening the folder picker");
  let root: FileSystemDirectoryHandle;
  try {
    root = await showDirectoryPicker({ mode: "readwrite" });
  } catch {
    return; // cancelled — not an error
  }
  await connectTo(root, "picked");
}

export async function regrant(): Promise<void> {
  const saved = reconnectTo.get();
  if (!saved) return;
  const permission = await saved.requestPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    await forgetHandle();
    reconnectTo.set(null);
    return void phase.set("setup");
  }
  reconnectTo.set(null);
  await connectTo(saved, "regranted");
}

async function connectTo(root: FileSystemDirectoryHandle, via: "picked" | "restored" | "regranted"): Promise<void> {
  step(`connecting to ${root.name}/`);
  pickError.set("");
  clearInterval(hostTimer);
  // Probe for .fsio WITHOUT creating it: connect() would create one in
  // whatever folder was picked, littering the wrong folder and hiding the
  // "no helper here" case behind an empty success.
  let fsioDir: FileSystemDirectoryHandle;
  try {
    fsioDir = await root.getDirectoryHandle(".fsio");
  } catch {
    client = null;
    helper.set("none");
    pickError.set(
      `No helper in ${root.name}/. Is the helper running, in exactly this folder? It creates a .fsio directory there and we don't see one — nothing was written to the folder you just picked.`
    );
    log(`no .fsio in ${root.name}/ — helper not running there`);
    return void phase.set("setup");
  }

  try {
    client = new FsioClient(root);
    await client.connect();
    await reporter.attach(fsioDir);
    reporter.event("connected", { folder: root.name, via });
  } catch (e) {
    client = null;
    pickError.set(`Could not open ${root.name}/.fsio — ${e instanceof Error ? e.message : String(e)}`);
    return void phase.set("setup");
  }

  folder.set({ name: root.name, via });
  rootHandle = root;
  helperStartedAt = null;
  void saveHandle(root);
  helperWasAlive = false;
  await refreshHelper();
  hostTimer = setInterval(() => void refreshHelper(), 2000);
}

async function refreshHelper(): Promise<void> {
  if (!client) return;
  const host = await client.hostInfo();
  if (host.alive) {
    helper.set("alive");
    const startedAt = typeof host.info?.["startedAt"] === "number" ? (host.info["startedAt"] as number) : null;
    // A helper restart is invisible from inside a session: the helper starts
    // `fresh`, so the session directory this page is holding is *deleted*
    // rather than closed, and a reader of a deleted directory sees exactly
    // what a torn write looks like — transient, wait and re-read (F11/D8).
    // The page would poll that hole forever. `host.json`'s startedAt is the
    // one thing that says "different helper", so it is what we watch.
    if (startedAt !== null && helperStartedAt !== null && startedAt !== helperStartedAt) {
      log("the helper restarted — reattaching");
      reporter.event("helper-restarted", { startedAt });
      await reattach();
    }
    if (startedAt !== null) helperStartedAt = startedAt;
    if (!helperWasAlive) {
      helperWasAlive = true;
      reporter.event("helper-alive", { info: host.info ?? null });
      await openSession();
    }
  } else {
    helperWasAlive = false;
    helper.set("silent");
  }
}

/** Everything this page held in the folder is gone, so let go of it and take
 *  it again: the session, and the report directory the native side reads
 *  verdicts out of (which the `fresh` wipe took with it). */
async function reattach(): Promise<void> {
  const stale = session;
  session = null;
  helperWasAlive = false;
  // A displaced page was displaced by a page whose session is now also gone.
  // Nobody holds this folder — this page may compete for it again.
  displaced.set(false);
  void stale?.close().catch(() => {});
  if (rootHandle) {
    await rootHandle
      .getDirectoryHandle(".fsio")
      .then((dir) => reporter.attach(dir))
      .catch(() => {}); // reporting must never break the thing it reports on
  }
}

// --------------------------------------------------------- the session

/** One session, opened once the helper answers and reopened if it restarts.
 *  Its whole job is to be somewhere for commands to arrive. */
async function openSession(): Promise<void> {
  if (!client || session || displaced.get()) return;
  step("attaching to the helper");
  const s = client.createSession({ kind: "actuator", client: "actuator-demo" }, { pollMs: 15 });
  session = s;
  s.on("data", (bytes) => void onCommand(bytes, s));
  s.on("status", (status) => {
    if (status.state !== "running" && session === s) {
      session = null;
      log(`session ${s.id} ended (${status.state})`);
    }
  });
  s.on("error", (e) => log("session error:", e));
  try {
    await s.ready;
    phase.set("live");
    step("attached — waiting for commands");
    log(`attached as ${s.id}; run \`actuator tabs add …\` in the folder`);
  } catch (e) {
    session = null;
    log("could not attach:", e);
    pickError.set(`The helper refused the session: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function onCommand(bytes: Uint8Array, s: FsioSession): Promise<void> {
  const msg = decodeDownstream(bytes);
  if (!msg) return void log("dropped an unreadable frame from the helper");

  if (msg.type === "displaced") {
    // Another page took the folder. This one keeps its state and keeps
    // rendering; it just stops being the one that gets driven.
    displaced.set(true);
    step("displaced by another page");
    log("another page took over this folder — this one is no longer being actuated");
    reporter.event("displaced");
    session = null;
    void s.close();
    return;
  }

  const op = asOperation(msg);
  if (!op) {
    s.sendData(encode(refusal(msg.id, { code: "bad_command", message: "this page does not understand that command" })));
    return;
  }
  try {
    const result = await applyToApp(op);
    lastCommand.set({ method: op.method, ok: true, detail: summarize(op.method, result), origin: "cli" });
    reporter.event("command", { id: msg.id, method: op.method, ok: true });
    log(`${op.method} → ${summarize(op.method, result)}`);
    s.sendData(encode(receipt(msg.id, result)));
  } catch (e) {
    const err = e instanceof AppError ? e : new AppError("internal", e instanceof Error ? e.message : String(e));
    lastCommand.set({ method: op.method, ok: false, detail: err.message, origin: "cli" });
    reporter.event("command", { id: msg.id, method: op.method, ok: false, error: err.code });
    log(`${op.method} → refused (${err.code}): ${err.message}`);
    s.sendData(
      encode(refusal(msg.id, { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) }))
    );
  }
}

const summarize = (method: string, result: Record<string, unknown>): string =>
  method === "tabs.list" ? `${app.get().tabs.length} tab(s)` : String(result["id"] ?? "ok");

/** Leaving: close the session so the host reaps its directory (D6). */
export function closeOnPagehide(): void {
  session?.close().catch(() => {});
  session = null;
}
