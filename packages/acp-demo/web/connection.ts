// Folder → client → agent. Gates, the picker, the spawn, and the two
// pollers. Writes signals (state.ts); owns the FsioClient singleton.
//
// Sticky sessions ([#113](https://github.com/dglazkov/fsio/issues/113)) are
// mostly here, and they are three separate pieces of memory doing three
// separate jobs:
//
//   the folder    — a handle in IndexedDB plus `revisit()`, exactly the
//                   terminal demo's (#58): `granted` reconnects with no
//                   clicks, `prompt` offers the one click F15 requires,
//                   `denied` forgets and falls back to the wizard.
//   the agent     — the roster name the human chose, re-offered next visit
//                   and dropped if it has left the roster (which is live:
//                   an agent can be uninstalled between visits).
//   the session   — the sticky record. `pagehide` now DETACHES rather than
//                   closing, so the agent keeps running, and a returning
//                   page attaches to it with replay. Only the "end session"
//                   button closes, and that is the only thing that kills
//                   the agent.
//
// That last line is the part this page strains P3 on, and it is worth
// saying out loud rather than leaving in the button's implementation.
// Durability of a grant is supposed to be something the human gestured
// for, and a session surviving a closed tab is a running process the
// page's absence no longer stops. So "end session" is load-bearing, not a
// convenience: without a real end gesture, sticky means "a process nobody
// can kill from the page", which is strictly worse than what came before.
// Note what is deliberately *not* made sticky — an unanswered permission
// comes back as a question, never as an inherited yes. The consent gesture
// does not survive the refresh; only the request does.
import { FsioClient, RpcError, RpcErrors, type FsioSession } from "@fsio/client";
import { AcpConnection } from "./acp";
import { AgentSession } from "./agent";
import { log, reporter, step } from "./reporter";
import {
  adoptable,
  adopted,
  agentFacts,
  agents,
  diagnostics,
  entries,
  folder,
  gate,
  helper,
  notice,
  past,
  phase,
  pickError,
  pushEntry,
  queued,
  reconnectTo,
  resumeError,
  resumed,
  turn,
  wizardStep,
  type AgentOffer,
  type Diagnostics,
} from "./state";
import { startWatching } from "./workspace";
import { refreshPast } from "./history";
import { listAdoptable } from "./discovery";
import { beginRecord, clearRecord, forgetHandle, loadRecord, rememberAgent, saveHandle, savedAgent, savedHandle, updateRecord } from "./store";
import { type StickyRecord } from "../src/resume.js";

let client: FsioClient | null = null;
let session: FsioSession | null = null;
let agent: AgentSession | null = null;

// ---------------------------------------------------------------- gates

export function checkGates(): void {
  if (typeof showDirectoryPicker !== "function") {
    gate.set({
      msg: "This demo needs Chrome (or a Chromium browser).",
      hint: "It's built on the File System Access API — the page talks to your machine, and to the agent, through files in a folder you grant it. That API hasn't shipped elsewhere yet.",
    });
  }
}

/** The helper is macOS-only while confinement is sandbox-exec; the wizard
 *  says so louder when the page isn't on a Mac. */
export const onMac = navigator.platform.startsWith("Mac");

// ---------------------------------------------------- persisted folder (#58)

/** On load: a remembered folder skips the wizard. `granted` reconnects with
 *  zero clicks; `prompt` needs one, because `requestPermission` requires a
 *  user activation (F15) — that is the reconnect offer; `denied` forgets the
 *  handle and falls back to the wizard. Identical in shape to
 *  terminal-demo/web/connection.ts, on purpose. */
export async function revisit(): Promise<void> {
  if (gate.get()) return; // non-Chrome: the gate panel already speaks
  let saved: FileSystemDirectoryHandle | null = null;
  try {
    saved = await savedHandle();
  } catch {} // IndexedDB unavailable (private mode etc.) — the wizard still works
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

/** "Not this folder" on the reconnect offer: forget it and start over. */
export async function forgetFolder(): Promise<void> {
  reconnectTo.set(null);
  await forgetHandle().catch(() => {});
  await clearRecord();
  phase.set("wizard");
  wizardStep.set(1);
}

// ---------------------------------------------------------------- connect

let hostTimer: ReturnType<typeof setInterval> | undefined;
let diagTimer: ReturnType<typeof setInterval> | undefined;
let helperWasAlive = false;
/** The revision of the service directory this page has already read. The
 *  heartbeat carries it (D3's doorbell), so re-reading is free to skip
 *  until it moves — which is also what makes "install an agent and watch it
 *  appear" cost nothing while nobody is installing anything. */
let servicesRev: number | undefined;
/** Kept so the agent chooser can start a session after the wizard has
 *  already run. */
let rootHandle: FileSystemDirectoryHandle | null = null;

/** The granted folder, for the parts of the page that read it directly —
 *  today the past-conversations view (#119), which needs no session. */
export const currentRoot = (): FileSystemDirectoryHandle | null => rootHandle;

export async function pickFolder(): Promise<void> {
  pickError.set(null);
  step("opening the folder picker");
  let root: FileSystemDirectoryHandle;
  try {
    root = await showDirectoryPicker({ mode: "readwrite" });
  } catch {
    return; // cancelled — not an error
  }
  await connectTo(root, "picked");
}

async function connectTo(root: FileSystemDirectoryHandle, via: "picked" | "restored" | "regranted"): Promise<void> {
  step(`connecting to ${root.name}/`);
  pickError.set(null);
  folder.set({ name: root.name, via });
  rootHandle = root;
  servicesRev = undefined;
  resumeChecked = false;
  // A different folder is a different set of running conversations, and a
  // different set of decisions about them (#117).
  picking = false;
  passedOver.clear();
  adoptable.set([]);
  clearInterval(hostTimer);
  // Probe for .fsio WITHOUT creating it: `connect()` would create one in
  // whatever folder was picked, littering the wrong folder and hiding the
  // "no helper here" case (terminal-demo learned this on its first click).
  let fsioDir: FileSystemDirectoryHandle;
  try {
    fsioDir = await root.getDirectoryHandle(".fsio");
  } catch {
    helper.set("none");
    pickError.set({
      msg: `no helper in ${root.name}/`,
      hint: "Is the command from step 1 running, in exactly this folder? The helper creates a .fsio directory there — we don't see one. (Nothing was written to the folder you just picked.)",
    });
    phase.set("wizard");
    wizardStep.set(2);
    return;
  }
  try {
    client = new FsioClient(root);
    await client.connect();
    await reporter.attach(fsioDir);
    reporter.event("connected", { folder: root.name });
  } catch (e) {
    pickError.set({ msg: `could not open ${root.name}/.fsio`, hint: e instanceof Error ? e.message : String(e) });
    phase.set("wizard");
    wizardStep.set(2);
    return;
  }
  // Remembered only once a helper folder connected: a mispick must not
  // become next visit's auto-connect target.
  void saveHandle(root).catch(() => {});
  // What this folder kept from before (#119). Read here rather than on
  // demand so the bar can offer it the moment there is something to offer.
  void refreshPast(root).catch(() => {});
  helperWasAlive = false;
  await refreshHelper(root);
  hostTimer = setInterval(() => void refreshHelper(root), 2000);
  if (helper.get() !== "alive") {
    // A revisit whose helper isn't running re-opens at step 1 (the command);
    // a fresh pick that found no heartbeat re-opens at step 2 (the folder).
    wizardStep.set(via === "picked" ? 2 : 1);
    phase.set("wizard");
  }
}

async function refreshHelper(root: FileSystemDirectoryHandle): Promise<void> {
  if (!client) return;
  const host = await client.hostInfo();
  if (!host.alive) {
    helperWasAlive = false;
    helper.set("silent");
    return;
  }
  // Re-read the directory on the first beat and on every revision bump
  // after it — the roster is live, so an agent installed while this page
  // sits on the install card lands here without a reload.
  const rev = host.info?.servicesRev;
  const first = !helperWasAlive;
  if (!first && rev === servicesRev) return;
  helperWasAlive = true;
  servicesRev = rev;

  // D25's handshake, used for what it is for: this page needs one specific
  // kind, and a host that doesn't serve it should say so here rather than
  // through a spawn failure three clicks later.
  const services = await client.services(rev);
  const acp = (services?.kinds ?? []).find((k) => k.name === "acp");
  if (first) reporter.event("helper-alive", { kinds: (services?.kinds ?? []).map((k) => k.name) });
  if (!acp) {
    const kinds = (services?.kinds ?? []).map((k) => k.name);
    helper.set("wrong-kind");
    pickError.set({
      msg: `the helper in ${root.name}/ doesn't serve ACP sessions`,
      hint: `It advertises: ${kinds.join(", ") || "(nothing)"}. This page needs the ACP helper — that's the command in step 1, not the terminal demo's.`,
    });
    phase.set("wizard");
    wizardStep.set(1);
    return;
  }
  helper.set("alive");

  const roster = readRoster(acp.detail);
  agents.set(roster);
  if (session) return; // an agent is already running; a roster change is news for nobody
  await arrive(root, roster);
}

/** Everything that happens between "the helper is alive" and "there is a
 *  conversation on screen".
 *
 *  Re-runnable on purpose: the roster is live, so a page sitting on the
 *  "install an agent" card must act the moment one appears. The one part
 *  that runs exactly once is the reattach lookup — asking twice would mean
 *  taking over a session this page already holds. */
let resumeChecked = false;
let arriving = false;
/** The picker is on screen (#117). Nothing may arrive past a question the
 *  human is being asked: a roster bump that spawned an agent underneath an
 *  open picker would be the silent second conversation this whole path
 *  exists to prevent. */
let picking = false;
/** Sessions this page has been told to leave alone: the one abandoned at the
 *  resume-error panel, and any the human declined in the picker. They are
 *  still running and still in the folder's listing — offering them back one
 *  keystroke after being told not to would be a loop, not a recovery. */
const passedOver = new Set<string>();
async function arrive(root: FileSystemDirectoryHandle, roster: AgentOffer[] | null): Promise<void> {
  if (arriving || session || picking) return;
  arriving = true;
  try {
    // The session first: coming back to a conversation outranks starting one.
    if (!resumeChecked) {
      resumeChecked = true;
      const rec = await loadRecord();
      if (rec) {
        const outcome = await reattach(root, rec);
        if (outcome === "resumed") return;
        // Falling through to a fresh spawn requires a POSITIVE verdict that
        // there is nothing to come back to (#115). "We could not reattach"
        // is not that verdict: the session may be alive and holding the
        // human's conversation, and starting a second one on top of it is
        // the silent fork a reattach exists to forbid. Stop and ask.
        if (outcome === "failed") return;
      }
    }

    // No record, or a record that named something that is gone — and about
    // to start a new conversation. Ask the FOLDER first (#117): the record
    // is a shortcut to one session, but `listSessions()` sees all of them,
    // and a running agent nothing here can name is exactly the state #115
    // produced and exactly the state a second browser profile, an incognito
    // window, or a cleared IndexedDB produces on purpose. Starting a second
    // conversation beside a live one is that same silent fork (#113);
    // the difference between doing it and not is one directory listing.
    if (await offerRunning(root)) return;

    // A helper that publishes no roster is a pre-#102 one. Unknown detail is
    // "not supported", never an error (D25), so let it choose for itself —
    // exactly what every run did before this existed.
    if (roster === null) {
      await startAgent(root, null);
      return;
    }

    const ready = roster.filter((a) => a.installed);
    reporter.event("roster", { installed: ready.map((a) => a.name), known: roster.length });
    // The agent the human chose last time, if this machine still has it. The
    // roster is live, so "still has it" is a question with a real answer:
    // uninstall the agent between visits and the chooser comes back.
    const remembered = await savedAgent().catch(() => null);
    if (remembered && ready.some((a) => a.name === remembered)) {
      reporter.event("agent-remembered", { agent: remembered });
      await startAgent(root, remembered);
      return;
    }
    if (remembered && ready.length) log(`${remembered} is no longer installed here — asking again`);
    // One agent: name it and go — the page has nothing to ask about. Zero or
    // several: the human decides, which is the whole point (the helper used
    // to pick the first that resolved, silently).
    if (ready.length === 1) {
      await startAgent(root, ready[0]!.name);
      return;
    }
    phase.set("wizard");
    wizardStep.set(3);
  } finally {
    arriving = false;
  }
}

// ------------------------------------------------- conversations in progress
//
// #117. Sticky sessions made the browser's record the only route back to a
// running agent, and that is one route too few — the record can be wrong,
// stale, gone, or simply another browser's. What `listSessions()` sees is
// the truth of the folder, and it does not care which IndexedDB the human
// is looking through.
//
// What this can and cannot restore is the whole reason it comes with a
// panel rather than a silent reattach. The agent's half comes back from the
// folder, entire (P2). The human's half does not exist here at all: prompts
// rode the uplink, which is not replayed (D18), and the record that carried
// them across a refresh is the very thing that is missing. So a rejoined
// conversation is honestly partial, and every permission card in it has an
// unknowable verdict — replay treats an id it has never seen as
// outstanding, and here "never seen" no longer means "never answered".

/** Anything running in this folder worth offering? Shows the picker and
 *  returns true when there is; a caller that gets true must not go on to
 *  start anything. */
async function offerRunning(root: FileSystemDirectoryHandle): Promise<boolean> {
  if (!client) return false;
  const rows = await listAdoptable(root, client, passedOver).catch(() => []);
  reporter.event("sessions-listed", {
    running: rows.length,
    detached: rows.filter((r) => r.detached).length,
    rejoinable: rows.filter((r) => !r.blocked).length,
  });
  if (!rows.length) return false;
  log(`${rows.length} conversation(s) already running in this folder that this page has no record of`);
  adoptable.set(rows);
  picking = true;
  phase.set("pick-session");
  return true;
}

/** "Rejoin this one." Builds the record the missing one would have been —
 *  minus everything that only the page that typed it could know. */
export async function adoptSession(id: string): Promise<void> {
  if (!rootHandle || session) return;
  const row = adoptable.get().find((r) => r.id === id);
  // The ACP session id is what `session/prompt` has to carry, so a row
  // without one is offered to look at and not to click (`blocked`).
  if (!row?.acpSessionId) return;
  picking = false;
  adoptable.set([]);
  reporter.event("adopt", { sessionId: id, agent: row.agent, detached: row.detached, lastLine: !!row.lastLine });
  const outcome = await reattach(
    rootHandle,
    {
      sessionId: row.id,
      acpSessionId: row.acpSessionId,
      agent: row.agent,
      agentName: row.agentName || row.agent || "agent",
      agentVersion: row.agentVersion,
      // Unknown until `acp/info` answers, and deliberately left empty rather
      // than guessed: it is what every `fs/*` path is judged against, and a
      // wrong cwd is a containment check that passes when it should not.
      // `reattach` fills it in, and until it does nothing may act. A record
      // persisted inside that window fails `parseRecord` on the next load
      // (cwd is load-bearing there), which costs a trip back through the
      // picker — the one path that is always correct here.
      cwd: "",
      folder: rootHandle.name,
      // Replay's own bracket reports the generation it is re-emitting from
      // and the record is corrected there — there is nothing to compare it
      // against yet, because this page was never counting.
      gen: 0,
      prompts: [],
      queued: [],
      answers: {},
      pendingPromptId: null,
      adopted: true,
    },
    true
  );
  // The session died between the listing and the click, or the host refused
  // the attach outright. Going around again is right — the picker's other
  // rows may still be there — but not with this one still in it, or the
  // panel would keep offering a door that has already been proved shut.
  if (outcome === "gone") {
    passedOver.add(id);
    await arrive(rootHandle, agents.get());
  }
}

/** "Start a new one instead." A separate, explicit gesture for the same
 *  reason `abandonAndStartNew` is: leaving a live conversation running with
 *  nothing pointing at it is the human's call, never the page's default.
 *  Those sessions keep running; this page just stops offering them. */
export async function declineRunning(): Promise<void> {
  if (!rootHandle || session) return;
  const rows = adoptable.get();
  for (const r of rows) passedOver.add(r.id);
  reporter.event("adopt-declined", { count: rows.length });
  log(`leaving ${rows.length} running conversation(s) alone and starting a new one`);
  adoptable.set([]);
  picking = false;
  await arrive(rootHandle, agents.get());
}

/** The roster as published by the helper (#102). Everything here arrives as
 *  a file that any co-tenant of the folder can write (D20), so it is parsed
 *  defensively and never trusted into anything but display — the name goes
 *  back to the helper on a spawn, where the allow-list judges it again. */
function readRoster(detail: Record<string, unknown> | undefined): AgentOffer[] | null {
  const raw = detail?.["agents"];
  if (!Array.isArray(raw)) return null;
  const out: AgentOffer[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (typeof r["name"] !== "string" || typeof r["title"] !== "string") continue;
    out.push({
      name: r["name"],
      title: r["title"],
      install: typeof r["install"] === "string" ? r["install"] : "",
      installed: r["installed"] === true,
      asks: r["asks"] === true,
    });
  }
  return out;
}

/** The chooser's button (#102): the human picked, so the spawn names it. */
export async function chooseAgent(name: string): Promise<void> {
  if (!rootHandle || session) return;
  await startAgent(rootHandle, name);
}

// ---------------------------------------------------------------- the agent

/** `agent` is the name the human chose, or null to let the helper pick —
 *  which is what a helper too old to publish a roster gets. Either way the
 *  wire carries a **name**, never a path: the allow-list is host-side and
 *  judges it again (agents.ts, #6). */
async function startAgent(root: FileSystemDirectoryHandle, name: string | null): Promise<void> {
  if (!client || session) return;
  step(name ? `asking the helper for ${name}` : "asking the helper for an agent");
  // What the page *asked* for, beside what the host reports it *started*
  // (`agent-started`): the pair is how a cooperative run verifies that the
  // chooser chose, rather than that the helper picked first-installed.
  reporter.event("agent-chosen", { agent: name });
  turn.set("starting");
  phase.set("chat");
  const s = client.createSession({ kind: "acp", client: "acp-demo", ...(name ? { agent: name } : {}) }, { pollMs: 15 });
  session = s;
  const conn = newConnection(s, () => agent);
  watchExit(s);

  let facts: Record<string, unknown>;
  try {
    await s.ready;
    facts = (await s.request<Record<string, unknown>>("acp/info")).result;
  } catch (e) {
    // A refusal from the host — no agent on PATH, an unknown name, a
    // sandbox that could not be applied (it fails, it does not quietly run
    // unconfined — R3). The message is written to be read by a
    // human, so show it as one.
    const msg = e instanceof RpcError ? e.message : e instanceof Error ? e.message : String(e);
    notice.set({ msg: "the helper refused to start an agent", hint: msg });
    pushEntry({ kind: "error", text: msg });
    turn.set("gone");
    reporter.event("spawn-refused", { error: msg });
    return;
  }

  const cwd = readFacts(facts);
  reporter.event("agent-started", { agent: facts["agent"], sandboxed: facts["sandboxed"] });
  log(`agent ${String(facts["agent"])} · ${String(facts["confinement"])}`);
  // Remembered on a start that worked, not on the click: an agent that
  // refuses to spawn is not the one to re-offer next visit.
  void rememberAgent(String(facts["agent"] ?? name ?? "")).catch(() => {});

  startWatching(root);
  diagTimer = setInterval(() => void pollDiagnostics(), 3000);

  agent = new AgentSession(conn, root, cwd);
  try {
    const init = await agent.start();
    turn.set("idle");
    pushEntry({ kind: "note", text: `${init.agentName} ${init.agentVersion} is listening in ${root.name}/` });
    reporter.event("acp-ready", { agent: init.agentName, version: init.agentVersion, sessionId: agent.sessionId });
    step("agent ready");
    // From here the session is worth coming back to (#113): the record is
    // what makes the next load a reattach instead of a fresh start.
    beginRecord({
      sessionId: s.id,
      acpSessionId: agent.sessionId!,
      agent: String(facts["agent"] ?? name ?? ""),
      agentName: init.agentName,
      agentVersion: init.agentVersion,
      cwd,
      // Which folder this conversation happens in, for after it is over
      // (#123): the transcript will be in this folder's `.fsio/`, and only
      // this folder gets to say the record of it has gone stale.
      folder: root.name,
      gen: 0,
      prompts: [],
      queued: [],
      answers: {},
      pendingPromptId: null,
      // Started here, so this record holds the whole human half of it — the
      // thing a rebuilt one (#117) cannot claim.
      adopted: false,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The F28 shape: `initialize` passes and `session/new` fails, with a
    // message that names a stream rather than a policy. Show the agent's
    // own words AND what the page knows about the wall it is behind.
    const conf = agentFacts.get();
    pushEntry({
      kind: "error",
      text: `the agent could not start a session: ${msg}` + (conf?.sandboxed ? `\n\nit is confined — ${conf.confinement}` : ""),
    });
    turn.set("gone");
    reporter.event("acp-start-failed", { error: msg });
  }
}

/** Coming back to a session this page left running (#113).
 *
 *  Three outcomes, and the distinction between the last two is the whole
 *  lesson of #115:
 *
 *    "resumed" — we are back in the conversation.
 *    "gone"    — there is provably nothing to come back to: the helper was
 *                restarted (it runs `fresh: true` and wipes `.fsio`,
 *                deliberately), the agent exited, or the host refused the
 *                attach outright. Forgetting the record and starting fresh
 *                is correct.
 *    "failed"  — we could not reattach, and the session may well be alive.
 *                The record is KEPT and the caller must not start a second
 *                conversation. One aborted file commit used to land here and
 *                be treated as "gone", which deleted the human's turns and
 *                orphaned a running agent nothing could name again. */
type ResumeOutcome = "resumed" | "gone" | "failed";

/** Errors that mean the session itself is unreachable, as opposed to our
 *  side failing to ask. Everything else is "failed" — the safe direction,
 *  because the cost of being wrong is a stuck page the human can retry,
 *  against a lost conversation and a leaked process. */
function saysSessionIsGone(e: unknown): boolean {
  if (!(e instanceof RpcError)) return false;
  return e.code === RpcErrors.ATTACH_FAILED || e.code === RpcErrors.SPAWN_DENIED || e.code === RpcErrors.SHELL_NOT_ALLOWED;
}

/** `joining` is what is happening *now* — the human just picked this
 *  conversation out of the folder (#117) — as against `rec.adopted`, which
 *  is what stays true about the transcript afterwards. A refresh of a joined
 *  conversation is an ordinary reattach with a permanently short human
 *  half, and the two notes below say those two different things. */
async function reattach(root: FileSystemDirectoryHandle, rec: StickyRecord, joining = false): Promise<ResumeOutcome> {
  if (!client) return "failed";
  let live = false;
  try {
    // D18 discovery: the session listing is the only honest answer to "is
    // the thing I remember still there".
    const row = (await client.listSessions()).find((r) => r.id === rec.sessionId);
    live = !!row && row.kind === "acp" && row.status?.state === "running";
    reporter.event("resume-lookup", { sessionId: rec.sessionId, found: !!row, state: row?.status?.state ?? null });
    if (!live) {
      log(`the session from last time is gone (${rec.sessionId}) — starting a new one`);
      await clearRecord();
      // The commonest way to get here is a helper restart, which used to
      // take the conversation with it. It no longer does (#119, D26 rule
      // 4), so say where it went — this is the exact moment someone asks.
      await refreshPast(root).catch(() => {});
      if (past.get().some((p) => p.id === rec.sessionId)) {
        pushEntry({
          kind: "note",
          text: "the session from last time is gone — the helper was restarted, which stops the agent. What it said is still in the folder: “past conversations” in the bar above.",
        });
      }
      return "gone";
    }
  } catch (e) {
    // The listing itself failed, so we know nothing about the session —
    // including that it is dead. Not a licence to start another one.
    resumeError.set({ msg: "could not read the sessions in this folder", hint: e instanceof Error ? e.message : String(e) });
    phase.set("resume-error");
    reporter.event("resume-failed", { error: String(e), stage: "list" });
    return "failed";
  }

  step(`reattaching to ${rec.agentName || rec.agent}`);
  turn.set("starting");
  phase.set("chat");
  // The record has to be live before the first replayed frame arrives: the
  // handlers read it to tell a permission card they already answered from
  // one the agent is still waiting on.
  beginRecord(rec);
  const s = client.attachSession(rec.sessionId, { pollMs: 15, replay: true, client: "acp-demo" });
  session = s;
  const conn = newConnection(s, () => agent);
  watchExit(s);
  // Constructed before `ready` is awaited, because replay runs inside the
  // attach grant — the frames rebuilding this conversation arrive before
  // that promise settles, and there would be no one to receive them.
  agent = new AgentSession(conn, root, rec.cwd, rec);

  let facts: Record<string, unknown>;
  let epoch = 1;
  try {
    const attached = (await s.ready) as { epoch?: number };
    // D18 writer epochs, borrowed for a second job: they partition this
    // connection's JSON-RPC ids from the ones the page it replaced used, so
    // a reply to the old page's request can never settle one of ours.
    epoch = attached.epoch ?? 1;
    conn.seedIds(epoch);
    facts = (await s.request<Record<string, unknown>>("acp/info")).result;
  } catch (e) {
    const msg = e instanceof RpcError ? e.message : e instanceof Error ? e.message : String(e);
    const gone = saysSessionIsGone(e);
    log(`could not reattach: ${msg}`);
    reporter.event("resume-failed", { error: msg, code: e instanceof RpcError ? e.code : null, verdict: gone ? "gone" : "failed" });
    // Not `conn.close()`: its rejections land a microtask later, i.e. after
    // the transcript below is cleared, and would leave an error from a
    // session this page is about to pretend it never saw.
    session = null;
    agent = null;
    entries.set([]);
    resumed.set(false);
    turn.set("starting");
    if (gone) {
      await clearRecord();
      return "gone";
    }
    // The record SURVIVES (#115). The session is probably still there
    // holding the conversation, and the human's own turns exist nowhere
    // else — deleting them to recover from a failed file write is a trade
    // nobody would make on purpose.
    resumeError.set({
      msg: `could not rejoin the conversation with ${rec.agentName || rec.agent}`,
      hint: `${msg}\n\nThe session looks like it is still running, so nothing was started in its place. Trying again is usually enough.`,
    });
    phase.set("resume-error");
    return "failed";
  }

  const cwd = readFacts(facts);
  // A conversation joined from the picker had no cwd to start with (#117):
  // only the host knows where the agent is rooted, and it says so here. The
  // session has been refusing every `fs/*` call until this line.
  if (!rec.cwd && cwd) {
    agent?.adoptCwd(cwd);
    updateRecord((r) => {
      r.cwd = cwd;
    });
  }
  resumed.set(true);
  adopted.set(rec.adopted);
  startWatching(root);
  diagTimer = setInterval(() => void pollDiagnostics(), 3000);
  // "starting" still means nothing else claimed the turn — a prompt that was
  // in flight across the refresh has already set it to "thinking" and owns
  // it until the agent answers.
  if (turn.get() === "starting") turn.set("idle");
  if (rec.adopted) {
    // At the TOP, where the missing part would have been — the same place
    // the read-only view puts its seams (#123). A caveat under a transcript
    // is a footnote; above one it is a description of what you are reading.
    entries.set([
      {
        kind: "note",
        text:
          "this conversation was already running when this page joined it, so what follows is the agent's half, replayed from what the folder kept. " +
          "The turns typed into it before that moment rode the uplink, which the folder never sees, and the browser record that carried them is not this one — " +
          "so they are not here. Nor is any verdict on a permission question from before then: this page cannot tell one that was already answered from one the agent is still waiting on.",
      },
      ...entries.get(),
    ]);
  }
  pushEntry({
    kind: "note",
    text: joining
      ? `you are on the wire with ${rec.agentName || rec.agent} now — from here on this is an ordinary conversation.`
      : `back in the same conversation — ${rec.agentName || rec.agent} kept running while this page was away.`,
  });
  reporter.event(joining ? "adopted" : "resumed", { sessionId: rec.sessionId, epoch, adopted: rec.adopted, prompts: rec.prompts.length, frames: conn.frameIndex });
  step(joining ? "joined a conversation in progress" : "reattached");
  return "resumed";
}

/** The connection every session gets. The two hooks are what a rebuild needs
 *  and a fresh session never fires. */
function newConnection(s: FsioSession, held: () => AgentSession | null): AcpConnection {
  return new AcpConnection(s, {
    onTraffic: (dir, msg) => reporter.event("acp", { dir, method: (msg as { method?: string }).method ?? null }),
    onUnhandled: (method) => log(`agent asked for something this client doesn't implement: ${method}`),
    onFrame: (index, replayed) => held()?.onFrame(index, replayed),
    onReplay: (replaying, gen) => held()?.onReplay(replaying, gen),
  });
}

/** `acp/info` → the header's facts: read from the host, never assumed.
 *  Returns the agent's cwd, which is also what `fs/*` containment is judged
 *  against. */
function readFacts(facts: Record<string, unknown>): string {
  const cwd = String(facts["cwd"] ?? "");
  agentFacts.set({
    agent: String(facts["agent"] ?? "agent"),
    title: String(facts["title"] ?? ""),
    sandboxed: !!facts["sandboxed"],
    confinement: String(facts["confinement"] ?? ""),
    profile: (facts["profile"] as string | null) ?? null,
    state: facts["state"] as { mode: string; dirs: string[]; why: string },
    cwd,
  });
  return cwd;
}

/** The agent's death, whoever caused it. */
function watchExit(s: FsioSession): void {
  s.on("status", (st) => {
    if (st.state !== "exited" && st.state !== "error") return;
    turn.set("gone");
    // #98: the kind's methods are gone the moment it exits, so the last
    // diagnostics snapshot is all we will ever have of the stderr that
    // says why. Stop polling and keep what we hold.
    clearInterval(diagTimer);
    // A session nobody can come back to is not worth remembering — and a
    // record pointing at a dead session would send the next load down the
    // reattach path for nothing.
    void clearRecord();
    // Nothing will ever send these now; say so rather than leaving them
    // sitting under a composer that looks like it is still going somewhere.
    if (queued.get().length) {
      pushEntry({ kind: "note", text: `${queued.get().length} queued prompt(s) never sent — the agent is gone` });
      reporter.event("queue-dropped", { count: queued.get().length, why: "agent-exited" });
      setQueued([]);
    }
    const tail = diagnostics.get()?.stderr ?? [];
    pushEntry({
      kind: "error",
      text:
        `the agent exited${st.exitCode === undefined || st.exitCode === null ? "" : ` (code ${st.exitCode})`}` +
        (tail.length ? `\nlast stderr:\n${tail.slice(-6).join("\n")}` : ""),
    });
    reporter.event("agent-exited", { exitCode: st.exitCode ?? null, stderrTail: tail.slice(-6) });
  });
}

async function pollDiagnostics(): Promise<void> {
  if (!session) return;
  try {
    const { result } = await session.request<Diagnostics>("acp/diagnostics");
    diagnostics.set(result);
  } catch {
    // exited (#98) or in flight — the last snapshot stands
  }
}

// ---------------------------------------------------------------- input

/** Send now, or hold it until the turn ends.
 *
 *  One turn is in flight at a time (ACP), so the alternatives were queue or
 *  refuse. Refusing is what the page used to do, badly — it took the text
 *  and dropped it. A queue is the version that keeps faith with someone who
 *  typed a follow-up while reading the answer to the last one. */
export function sendPrompt(text: string): void {
  const a = agent;
  if (!a) return;
  const t = turn.get();
  if (t === "gone" || t === "starting") return;
  if (t !== "idle") {
    setQueued([...queued.get(), text]);
    reporter.event("prompt-queued", { depth: queued.get().length });
    return;
  }
  void runTurn(a, text);
}

/** The queue is the one thing on this page the human cannot get back, so it
 *  is written through to the record on every change — a refresh mid-queue
 *  returns the text, not an apology. */
function setQueued(list: string[]): void {
  queued.set(list);
  updateRecord((r) => {
    r.queued = [...list];
  });
}

/** One turn, then the next queued prompt if the session is still healthy.
 *  Draining here rather than on a signal watcher keeps the ordering obvious:
 *  a queued prompt is sent by the turn that was blocking it. */
async function runTurn(a: AgentSession, text: string): Promise<void> {
  await a.prompt(text);
  const q = queued.get();
  // `turn` is whatever prompt() left behind — `gone` if the agent exited,
  // and cancelTurn() empties the queue — so both stop the drain.
  if (!q.length || turn.get() !== "idle" || agent !== a) return;
  setQueued(q.slice(1));
  void runTurn(a, q[0]!);
}

/** Drop a queued prompt without sending it. */
export function unqueue(index: number): void {
  const q = queued.get();
  if (index < 0 || index >= q.length) return;
  setQueued(q.filter((_, i) => i !== index));
}

/** Stop is the human's brake, so it stops what is coming too: a queue that
 *  kept firing after "stop" would be the opposite of what the button says.
 *  Dropped prompts are announced rather than silently discarded. */
export function cancelTurn(): void {
  const dropped = queued.get().length;
  if (dropped) {
    setQueued([]);
    pushEntry({ kind: "note", text: `stopped — ${dropped} queued prompt${dropped === 1 ? "" : "s"} dropped` });
    reporter.event("queue-dropped", { count: dropped, why: "cancel" });
  }
  agent?.cancel();
}

// ---------------------------------------------------------------- lifetime

/** Page teardown (#113). One word changed here and it inverted the
 *  demo's whole answer to "what does a refresh mean": `close()` asked the
 *  helper to kill the agent, and it obliged — measured, six milliseconds
 *  after the notification landed. `detach()` is the deliberate walk-away
 *  (D18): the host marks the session detached NOW, with no wait on D17's
 *  180 s silence window, and leaves state, process and stream untouched for
 *  the attach that comes next.
 *
 *  The record is already durable — it is written through on every change,
 *  never flushed here, because an IndexedDB write started at `pagehide` is a
 *  race against document teardown that the write loses.
 *
 *  The ACP connection is deliberately NOT closed. Closing it rejects the
 *  in-flight `session/prompt`, whose rejection handler would clear the very
 *  id the next page needs to adopt in order to see that turn finish. A
 *  connection whose document is being torn down does not need tidying;
 *  a record that lies about a running turn does. */
export function detachOnPagehide(): void {
  void session?.detach();
  session = null;
  agent = null;
}

/** The explicit end (#113). A sticky session that only the tab could close
 *  would be a process the page cannot kill, which is worse than what came
 *  before — so this exists, it says what it does, and it is the ONLY thing
 *  in the page that stops the agent. */
export async function endSession(): Promise<void> {
  const s = session;
  const a = agent;
  session = null;
  agent = null;
  // "gone" before the connection goes: a turn cut short by this button has
  // already been explained by the note below, and does not need an error
  // above it saying the connection closed.
  turn.set("gone");
  a?.conn.close();
  clearInterval(diagTimer);
  reporter.event("session-ended", {});
  await clearRecord();
  try {
    await s?.close(); // the helper kills the child (D6)
  } catch {}
  setQueued([]);
  pushEntry({ kind: "note", text: "session ended — the agent was stopped, and this conversation is over. It stays readable: “past conversations” in the bar above." });
  log("session ended by the human");
  // The host sweeps the session dir a beat after the close and keeps the
  // transcript on the way out (#119) — look again once it has.
  const root = rootHandle;
  if (root) setTimeout(() => void refreshPast(root).catch(() => {}), 1500);
}

/** The retry on the resume-error panel (#115). The record was kept, so
 *  there is still something to come back to; a failed attempt does not
 *  consume it. */
export async function retryResume(): Promise<void> {
  if (!rootHandle || session) return;
  const rec = await loadRecord();
  if (!rec) {
    // The record went away underneath us (an exit cleared it). Nothing to
    // rejoin, so the ordinary arrival is now the right answer.
    resumeError.set(null);
    resumeChecked = true;
    await arrive(rootHandle, agents.get());
    return;
  }
  resumeError.set(null);
  step("trying to rejoin the session again");
  const outcome = await reattach(rootHandle, rec);
  if (outcome === "gone") await arrive(rootHandle, agents.get());
}

/** "Leave it and start a new one" on the resume-error panel. Deliberately a
 *  separate gesture from the retry: abandoning a running conversation is the
 *  human's call to make, never a fallback the page takes on their behalf.
 *  The old session keeps running — this page just stops naming it, which is
 *  what [#117](https://github.com/dglazkov/fsio/issues/117) is for. */
export async function abandonAndStartNew(): Promise<void> {
  if (!rootHandle || session) return;
  // Named before the record is cleared, so the picker does not turn round
  // and offer back the very session the human just walked away from (#117).
  // It is still running, and it is still findable — by a later visit, or by
  // another tab — which is what "leave it running" means.
  const rec = await loadRecord().catch(() => null);
  if (rec) passedOver.add(rec.sessionId);
  reporter.event("resume-abandoned", { sessionId: rec?.sessionId ?? null });
  log("the human chose to leave the old session and start a new one");
  await clearRecord();
  resumeError.set(null);
  entries.set([]);
  await arrive(rootHandle, agents.get());
}

/** After an explicit end: clear the transcript and go around again. Kept
 *  separate from `endSession` so that ending a session never silently
 *  starts another one. */
export async function startNewSession(): Promise<void> {
  if (!rootHandle || session) return;
  entries.set([]);
  resumed.set(false);
  adopted.set(false);
  agentFacts.set(null);
  diagnostics.set(null);
  turn.set("starting");
  await arrive(rootHandle, agents.get());
}
