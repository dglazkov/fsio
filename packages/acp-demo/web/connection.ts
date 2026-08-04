// Folder → client → conversations. Gates, the grant, the helper's roster,
// and what happens on arrival. Writes signals (state.ts); owns the
// FsioClient singleton. The conversations themselves live in
// conversations.ts — one file per lifetime, since #120 gave the page N of
// them and one folder.
//
// Sticky sessions (#113) are mostly here, and they are three separate
// pieces of memory doing three separate jobs:
//
//   the folder    — a handle in IndexedDB plus `revisit()`, exactly the
//                   terminal demo's (#58): `granted` reconnects with no
//                   clicks, `prompt` offers the one click F15 requires,
//                   `denied` forgets and falls back to the wizard.
//   the agent     — the roster name the human chose, re-offered next visit
//                   and dropped if it has left the roster (which is live:
//                   an agent can be uninstalled between visits).
//   the sessions  — one sticky record each, plus the set of them (#120).
//                   `pagehide` DETACHES rather than closing, so the agents
//                   keep running and a returning page attaches to each with
//                   replay. Only an explicit close stops an agent.
//
// That last line is the part this page strains P3 on, and it is worth
// saying out loud rather than leaving in the button's implementation.
// Durability of a grant is supposed to be something the human gestured
// for, and a session surviving a closed tab is a running process the
// page's absence no longer stops. So ending a conversation is load-bearing,
// not a convenience: without a real end gesture, sticky means "a process
// nobody can kill from the page", which is strictly worse than what came
// before. N conversations sharpen that rather than soften it — the page can
// now be holding five agents nobody is watching — which is why the tab's
// "×" ends rather than walks away, and why the "+" menu exists to show what
// is still running (#120). Note what is deliberately *not* made sticky —
// an unanswered permission comes back as a question, never as an inherited
// yes. The consent gesture does not survive the refresh; only the request
// does.
import { FsioClient } from "@fsio/client";
import { log, reporter, step } from "./reporter";
import {
  adoptable,
  agents,
  convs,
  folder,
  gate,
  helper,
  joinable,
  launch,
  notice,
  past,
  phase,
  pickError,
  reconnectTo,
  resumeError,
  wizardStep,
  type AgentOffer,
} from "./state";
import { startWatching } from "./workspace";
import { closeAllFiles } from "./files";
import { openPast, refreshPast } from "./history";
import { listAdoptable } from "./discovery";
// Circular, in the same direction and for the same reason as terminal-demo's
// connection.ts / tabs.ts: this file owns the folder and the client, that one
// owns what runs over them.
import { activate, closeConv, detachAllOnPagehide, join, leaveConv, openIds, openNew, retake } from "./conversations";
import { forgetHandle, loadOpen, rememberAgent, saveHandle, savedAgent, savedHandle, sweepRecords } from "./store";
import { wantedOpen, parseHash, type OpenSet } from "../src/tabs.js";
import { noHelperHint } from "../src/launch.js";

let client: FsioClient | null = null;

/** The client every conversation runs over. One per folder, N sessions on
 *  it — which is what the protocol always allowed and only this page used to
 *  refuse. */
export const getClient = (): FsioClient | null => client;

// ---------------------------------------------------------------- gates

export function checkGates(): void {
  if (typeof showDirectoryPicker !== "function") {
    gate.set({
      msg: "This demo needs Chrome (or a Chromium browser).",
      hint: "It's built on the File System Access API — the page talks to your machine, and to the agent, through files in a folder you grant it. That API hasn't shipped elsewhere yet.",
    });
  }
}

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
  if (!saved) return void openWizard();
  // A helper that names a folder outranks a remembered one that isn't it
  // (#124). Without this, running the helper in project B opens a page that
  // reconnects to project A — yesterday's grant is still good, so it
  // succeeds — and only discovers there is no helper there a beat later,
  // having flashed the wrong folder's files on the way past.
  //
  // Still not load-bearing: this changes which step the page opens on, never
  // where it can get to. Skipping the restore lands on "pick B", which is
  // exactly where the reconnect-then-fail path lands too, one step slower —
  // and the handle is kept, not forgotten, so nothing is lost if B was the
  // mistake. Basenames can collide; a collision just means the old behaviour.
  const expected = launch.get().dir;
  if (expected && saved.name !== expected) {
    reporter.event("revisit-deferred", { remembered: saved.name, expected });
    log(`remembered folder ${saved.name}/, but the helper that opened this page serves ${expected}/ — asking`);
    return void openWizard();
  }
  let perm: FsaPermissionState;
  try {
    perm = await saved.queryPermission({ mode: "readwrite" });
  } catch {
    return void openWizard();
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
    openWizard();
  }
}

/** Open the setup dialog at the first step that still has a question in it
 *  (#124).
 *
 *  Step 1 asks the human to go run the helper and then tell us they did.
 *  When the helper opened this page, both halves of that are already
 *  answered — it is up, and it is up in a folder it named — so starting
 *  there is asking someone to confirm something we can see. A page opened by
 *  hand carries no hint and still starts at 1, which is the same wizard it
 *  has always been. */
export function openWizard(): void {
  phase.set("wizard");
  wizardStep.set(launch.get().dir ? 2 : 1);
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

/** "Not this folder" on the reconnect offer: forget it and start over. The
 *  conversations in it are not ours to end — they are still running in a
 *  folder this page is walking away from, and the records that name them
 *  stay put for whoever opens it next. */
export async function forgetFolder(): Promise<void> {
  reconnectTo.set(null);
  await forgetHandle().catch(() => {});
  detachAllOnPagehide();
  convs.set([]);
  openWizard();
}

// ---------------------------------------------------------------- connect

let hostTimer: ReturnType<typeof setInterval> | undefined;
let helperWasAlive = false;
/** Whether this page has *ever* seen the helper alive on this folder. The
 *  difference between "the first beat after connecting" and "the first beat
 *  after the helper came back from the dead" — the second one means a
 *  restart, and a restart sweeps what this page writes into. */
let helperEverAlive = false;
/** The `.fsio` handle from `connectTo`, kept so the reporter can be
 *  re-attached after a restart swept its directory out from under it. */
let fsioHandle: FileSystemDirectoryHandle | null = null;
/** The revision of the service directory this page has already read. The
 *  heartbeat carries it (D3's doorbell), so re-reading is free to skip
 *  until it moves — which is also what makes "install an agent and watch it
 *  appear" cost nothing while nobody is installing anything. */
let servicesRev: number | undefined;
/** Kept so the agent chooser can start a conversation after the wizard has
 *  already run. */
let rootHandle: FileSystemDirectoryHandle | null = null;

/** The granted folder, for the parts of the page that read it directly —
 *  the workspace pane, the past-conversations view (#119), and every
 *  conversation's `fs/*` handler. */
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
  restored = false;
  handsOff = false;
  // A different folder is a different set of running conversations, and a
  // different set of decisions about them (#117).
  picking = false;
  passedOver.clear();
  adoptable.set([]);
  joinable.set([]);
  clearInterval(hostTimer);
  // Probe for .fsio WITHOUT creating it: `connect()` would create one in
  // whatever folder was picked, littering the wrong folder and hiding the
  // "no helper here" case (terminal-demo learned this on its first click).
  let fsioDir: FileSystemDirectoryHandle;
  try {
    fsioDir = await root.getDirectoryHandle(".fsio");
  } catch {
    helper.set("none");
    pickError.set({ msg: `no helper in ${root.name}/`, hint: noHelperHint(root.name, launch.get().dir) });
    phase.set("wizard");
    wizardStep.set(2);
    return;
  }
  try {
    client = new FsioClient(root);
    await client.connect();
    await reporter.attach(fsioDir);
    fsioHandle = fsioDir;
    reporter.event("connected", { folder: root.name, expected: launch.get().dir });
  } catch (e) {
    pickError.set({ msg: `could not open ${root.name}/.fsio`, hint: e instanceof Error ? e.message : String(e) });
    phase.set("wizard");
    wizardStep.set(2);
    return;
  }
  // Remembered only once a helper folder connected: a mispick must not
  // become next visit's auto-connect target.
  void saveHandle(root).catch(() => {});
  // The folder's own two lists, both page-wide because both belong to the
  // folder rather than to any one conversation in it: what it kept from
  // before (#119), and what is in it right now.
  void refreshPast(root).catch(() => {});
  // Windows onto the folder we are leaving, if this is a re-pick. A tab whose
  // path resolved in the last folder would either go dark or — worse — quietly
  // show a same-named file from this one.
  closeAllFiles();
  startWatching(root);
  helperWasAlive = false;
  helperEverAlive = false;
  await refreshHelper(root);
  hostTimer = setInterval(() => void refreshHelper(root), 2000);
  if (helper.get() !== "alive") {
    // A revisit whose helper isn't running re-opens at step 1 (the command);
    // a fresh pick that found no heartbeat re-opens at step 2 (the folder).
    // A page the helper opened is never sent back to step 1 — it was started
    // by the very thing step 1 asks about (#124).
    wizardStep.set(via === "picked" || launch.get().dir ? 2 : 1);
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
  // A helper that went silent and came back restarted itself, and a
  // restarting helper sweeps `.fsio` — including the dir this page reports
  // into. The reporter's handle is now pointing at something that is not
  // there, so every subsequent flush throws into its own catch and the page
  // stops self-reporting for the rest of its life, silently. Re-attaching
  // costs one directory create and fixes it (#109's contract is "read the
  // newest dir under client/", which a page that stopped writing quietly
  // breaks).
  //
  // It is also the signal the helper reads to decide whether to open a tab
  // (#124, open.ts): a client dir reappearing after the sweep is a live page
  // saying so, which is why this runs on the transition rather than lazily
  // at the next event.
  if (first && helperEverAlive && fsioHandle) await reporter.attach(fsioHandle).catch(() => {});
  helperEverAlive = true;
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
  // Conversations are open, or the human has deliberately left the page
  // holding none: either way a roster change is news for nobody, and the
  // picker arriving on the back of one would be a modal nobody asked for.
  // The watch-and-go path this guard makes room for is the first arrival
  // only — a page sitting on "install an agent" with nothing behind it.
  if (convs.get().length || handsOff) return;
  await arrive(root, roster);
}

/** The human has been in a conversation and stepped out of one, so arrival
 *  is over: from here the page only opens what it is asked to open (#120).
 *  Discovered from one end — closing the last tab used to leave a page that
 *  would spawn an agent by itself the next time the helper's roster moved —
 *  and #140 made it the rule at both ends: arrival opens nothing either. */
let handsOff = false;

/** Everything that happens between "the helper is alive" and "there is a
 *  conversation on screen".
 *
 *  Re-runnable on purpose: the roster is live, so a page sitting on the
 *  "install an agent" card must act the moment one appears. The one part
 *  that runs exactly once is the restore, because asking twice would mean
 *  taking over conversations this page already holds. */
let restored = false;
let arriving = false;
/** The picker is on screen (#117). Nothing may arrive past a question the
 *  human is being asked: a roster bump that spawned an agent underneath an
 *  open picker would be the silent second conversation this whole path
 *  exists to prevent. */
let picking = false;
/** Sessions this page has been told to leave alone: the ones abandoned at
 *  the resume-error panel, and any the human declined in the picker. They
 *  are still running and still in the folder's listing — offering them back
 *  one keystroke after being told not to would be a loop, not a recovery.
 *  The "+" menu ignores this set, because opening it IS the human asking. */
const passedOver = new Set<string>();

export async function arrive(root: FileSystemDirectoryHandle, roster: AgentOffer[] | null): Promise<void> {
  if (arriving || convs.get().length || picking) return;
  arriving = true;
  try {
    // The open set first: coming back to conversations outranks starting one.
    if (!restored) {
      restored = true;
      if (await restore(root)) return;
    }

    // Nothing came back, and about to start a new conversation. Ask the
    // FOLDER first (#117): a record is a shortcut to one session, but
    // `listSessions()` sees all of them, and a running agent nothing here
    // can name is exactly the state #115 produced and exactly the state a
    // second browser profile, an incognito window, or a cleared IndexedDB
    // produces on purpose. Starting a second conversation beside a live one
    // is that same silent fork (#113); the difference between doing it
    // and not is one directory listing.
    if (await offerRunning(root)) return;

    // And stop. There used to be a third rung here that started one (#140).
    //
    // "Folder granted, helper alive, no conversation open" is one state, and
    // it looked like two: closing the last chip left the quiet empty state,
    // and reloading into the same place spawned an agent. That is archaeology
    // — with one conversation the page WAS the conversation, so arriving
    // meant starting one, and when #120 made "none open" a state the page
    // could sit in, nobody came back to the tail of this function.
    //
    // The argument against the rung is the same one that put a confirm on
    // "×": a conversation is a child process and a model bill (#120's
    // decision 3). The page asked before you stopped paying and not before
    // you started. `handsOff` below is this rule already, discovered from the
    // other end and applied only within a visit — from here an agent starts
    // when somebody asks for one, and the empty state is what asking looks
    // like.
    if (roster) reporter.event("roster", { installed: roster.filter((a) => a.installed).map((a) => a.name), known: roster.length });
    phase.set("chat");
  } finally {
    arriving = false;
  }
}

// ---------------------------------------------------------- coming back (#120)
//
// One conversation had one question on load: is the thing I remember still
// there? N conversations ask it N times, and the answers can differ — which
// is the part that needed thought rather than a loop.
//
// The rule that survives from #115 is the one that matters: a conversation
// we could not reach is never replaced by a new one. What tabs change is the
// blast radius. With one conversation, "could not rejoin" had to stop the
// whole page, because the page WAS that conversation. With N, one unreachable
// conversation must not hold the other four hostage — so it is dropped from
// the set with a banner that says it is still running and still rejoinable,
// and the modal is kept for the case where it is still the whole story:
// nothing else came back either.

/** Open everything the URL or the store says was open. True when anything
 *  came back — in which case the caller must not go on to start or offer
 *  anything, exactly as a successful reattach used to mean. */
async function restore(root: FileSystemDirectoryHandle): Promise<boolean> {
  const stored = await loadOpen().catch(() => ({ ids: [], active: null }) as OpenSet);
  const wanted = wantedOpen(parseHash(location.hash), stored);
  if (!wanted.ids.length) return false;
  reporter.event("restore", { wanted: wanted.ids, active: wanted.active, from: parseHash(location.hash).ids.length ? "url" : "store" });
  step(`coming back to ${wanted.ids.length} conversation${wanted.ids.length === 1 ? "" : "s"}`);

  const lost: string[] = [];
  let unreachable = "";
  // In the stored order, so tabs come back where they were. Sequential
  // rather than parallel on purpose: each attach is a takeover grant plus a
  // full scrollback replay, and N of those racing through one folder is how
  // you turn a slow reload into a torn one.
  for (const id of wanted.ids) {
    const outcome = await join(root, id);
    if (outcome === "joined") continue;
    if (outcome === "gone") lost.push(id);
    if (outcome === "blocked") unreachable = `${id} is still running in this folder, but the folder no longer holds the part that says which conversation it is — so it can be seen and not rejoined.`;
    if (outcome === "failed") unreachable = `${id} could not be rejoined. It looks like it is still running, so nothing was started in its place — it is in the “+” menu when you want to try again.`;
  }

  // An id that is not running may still be a conversation this page was
  // holding — as a document (#140). Reopening it is the whole reason a
  // document is a chip: it rides the URL and the stored set like any other,
  // so a reload comes back to what was on screen, and a link to a transcript
  // opens the transcript. Asked only for ids that failed to join, and only
  // after they have: a live conversation is never a document.
  if (lost.length) {
    await refreshPast(root).catch(() => {});
    for (const id of [...lost]) {
      const p = past.get().find((x) => x.id === id);
      if (!p) continue;
      await openPast(root, p).catch(() => {});
      if (openIds().includes(id)) lost.splice(lost.indexOf(id), 1);
    }
  }

  const back = openIds();
  if (wanted.active && back.includes(wanted.active)) activate(wanted.active);
  reporter.event("restored", { opened: back, lost, unreachable: !!unreachable });

  if (lost.length) {
    // The commonest way to lose one is a helper restart, which used to take
    // the conversation with it. It no longer does (#119, D26 rule 4), so say
    // where it went — this is the exact moment someone asks.
    const kept = lost.filter((id) => past.get().some((p) => p.id === id)).length;
    log(`${lost.length} conversation(s) from last time are gone`);
    if (back.length) {
      notice.set({
        msg: `${lost.length === 1 ? "one conversation" : `${lost.length} conversations`} from last time ${lost.length === 1 ? "is" : "are"} gone`,
        hint: kept
          ? "The helper was restarted, which stops the agents. What they said is still in the folder: “past conversations” in the bar above."
          : "The agents exited or the helper was restarted since this page was last here.",
      });
    }
  }

  if (!back.length) {
    // Nothing came back at all. If one of them was merely unreachable this
    // is still #115's situation exactly — a conversation that may be alive,
    // and a page that must not start a second one on top of it — so the
    // modal stands, with the record kept and both honest options on it.
    if (resumeError.get()) {
      phase.set("resume-error");
      return true;
    }
    return false; // all provably gone: the ordinary arrival is now correct
  }

  if (unreachable) notice.set({ msg: "one conversation did not come back", hint: unreachable });
  // A conversation that came back is a conversation on screen.
  resumeError.set(null);
  phase.set("chat");
  return true;
}

// ------------------------------------------------- conversations in progress
//
// #117. Sticky sessions made the browser's record the only route back to a
// running agent, and that is one route too few — the record can be wrong,
// stale, gone, or simply another browser's. What `listSessions()` sees is
// the truth of the folder, and it does not care which IndexedDB the human
// is looking through.
//
// Two consumers now (#120), and the difference between them is who is
// asking. The arrival picker is the page asking on its own initiative, so it
// hides what the human has already walked away from. The "+" menu is the
// human asking, so it hides only what is already open.

/** Anything running in this folder worth offering? Shows the picker and
 *  returns true when there is; a caller that gets true must not go on to
 *  start anything. */
async function offerRunning(root: FileSystemDirectoryHandle): Promise<boolean> {
  if (!client) return false;
  const exclude = new Set([...openIds(), ...passedOver]);
  const rows = await listAdoptable(root, client, exclude).catch(() => []);
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

/** The "+" menu's data source: everything running here that is not already
 *  a tab. Also the moment to notice that records have outlived their
 *  sessions — the listing is in hand and it is the only thing that can say
 *  so (#120). */
export async function refreshJoinable(): Promise<void> {
  const root = rootHandle;
  if (!client || !root) return;
  const open = new Set(openIds());
  joinable.set(await listAdoptable(root, client, open).catch(() => []));
  // The sweep asks the host DIRECTLY rather than reading the list above,
  // and the difference is the whole safety of it: `listAdoptable` turns a
  // torn scan into an empty list on purpose (half a picker beats no picker),
  // and a sweep that read an empty list as "nothing is running" would demote
  // the record of every live conversation in the folder. So a listing that
  // did not answer means no sweep at all.
  let rows;
  try {
    rows = await client.listSessions();
  } catch {
    return;
  }
  const live = new Set([...open, ...rows.filter((r) => r.status?.state === "running").map((r) => r.id)]);
  const swept = await sweepRecords(root.name, live);
  if (swept.length) reporter.event("records-swept", { count: swept.length, sessions: swept });
}

/** The one conversation a click failed to reach, so "try again" has
 *  something to try. The restore path gets its ids from the URL and the
 *  store; a session joined from a picker is in neither, and without this the
 *  retry button would be a button that does nothing. */
let lastFailedJoin: string | null = null;

/** "Rejoin this one", from the arrival picker or the "+" menu. */
export async function adoptSession(id: string): Promise<void> {
  const root = rootHandle;
  if (!root) return;
  picking = false;
  adoptable.set([]);
  resumeError.set(null);
  reporter.event("adopt", { sessionId: id });
  const outcome = await join(root, id);
  if (outcome === "joined") {
    lastFailedJoin = null;
    return void phase.set("chat");
  }
  // "failed" means it is probably still there and we could not reach it, so
  // it stays offerable and retryable. "gone" and "blocked" are verdicts: the
  // door has been proved shut, and a picker that kept offering it would loop.
  if (outcome === "failed") {
    lastFailedJoin = id;
    return void phase.set("resume-error");
  }
  passedOver.add(id);
  if (convs.get().length) {
    notice.set({ msg: "that conversation could not be rejoined", hint: outcome === "gone" ? "It is no longer running in this folder." : "The folder no longer holds the part that says which conversation it is." });
    return;
  }
  await arrive(root, agents.get());
}

/** "Start a new one instead." A separate, explicit gesture for the same
 *  reason `abandonAndStartNew` is: leaving a live conversation running with
 *  nothing pointing at it is the human's call, never the page's default.
 *  Those sessions keep running; this page just stops offering them. */
export async function declineRunning(): Promise<void> {
  const root = rootHandle;
  if (!root) return;
  const rows = adoptable.get();
  for (const r of rows) passedOver.add(r.id);
  reporter.event("adopt-declined", { count: rows.length });
  log(`leaving ${rows.length} running conversation(s) alone and starting a new one`);
  adoptable.set([]);
  picking = false;
  // Explicitly, because the button says so. Arrival no longer starts anything
  // (#140), and this is one of the two places where the human has already
  // said "start one" — routing it through `arrive` would now drop them on an
  // empty page after they pressed a button asking for a conversation.
  await startAnother();
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
  if (!rootHandle) return;
  void rememberAgent(name).catch(() => {});
  await openNew(rootHandle, name);
}

/** The "+" menu's other half, and the wizard's, when there is nothing to
 *  rejoin: one more conversation in this folder. */
export async function startAnother(): Promise<void> {
  const root = rootHandle;
  if (!root) return;
  const roster = agents.get();
  const ready = (roster ?? []).filter((a) => a.installed);
  const remembered = await savedAgent().catch(() => null);
  if (roster === null) return void (await openNew(root, null));
  if (remembered && ready.some((a) => a.name === remembered)) return void (await openNew(root, remembered));
  if (ready.length === 1) return void (await openNew(root, ready[0]!.name));
  // Nothing to name and something to ask: the chooser, which is where a
  // first conversation would have gone too.
  phase.set("wizard");
  wizardStep.set(3);
}

// ---------------------------------------------------------------- lifetime

/** The explicit end (#113), now per conversation (#120). A sticky session
 *  that only the tab could close would be a process the page cannot kill,
 *  which is worse than what came before — so this exists, it says what it
 *  does, and it is the only thing in the page that stops an agent. */
export async function endSession(id: string, confirmed = false): Promise<void> {
  handsOff = true;
  await closeConv(id, confirmed);
  if (!convs.get().length) phase.set("chat"); // the empty state, not the wizard
}

/** "Take it back" on the superseded banner (#58's retake, #120's need for
 *  it): re-attach, which bumps the writer epoch this way and fences the
 *  window that took it. Deliberately a button and not automatic — two pages
 *  racing to reclaim one agent is a loop, and which window should be driving
 *  is a question only the human can answer. */
export async function retakeSession(id: string): Promise<void> {
  const root = rootHandle;
  if (!root) return;
  const outcome = await retake(root, id);
  if (outcome === "joined") return void phase.set("chat");
  if (outcome === "failed") return void phase.set("resume-error");
  notice.set({
    msg: "could not take that conversation back",
    hint: outcome === "gone" ? "It is no longer running in this folder." : "The folder no longer holds the part that says which conversation it is.",
  });
}

/** "Leave it running": the walk-away, per conversation. */
export async function leaveSession(id: string): Promise<void> {
  handsOff = true;
  await leaveConv(id);
  if (!convs.get().length) phase.set("chat");
  void refreshJoinable();
}

/** The retry on the resume-error panel (#115). The record was kept, so
 *  there is still something to come back to; a failed attempt does not
 *  consume it. */
export async function retryResume(): Promise<void> {
  const root = rootHandle;
  if (!root) return;
  const stored = await loadOpen().catch(() => ({ ids: [], active: null }) as OpenSet);
  const open = openIds();
  const wanted = [...wantedOpen(parseHash(location.hash), stored).ids, ...(lastFailedJoin ? [lastFailedJoin] : [])].filter(
    (id, i, all) => !open.includes(id) && all.indexOf(id) === i
  );
  resumeError.set(null);
  lastFailedJoin = null;
  step("trying to rejoin again");
  let any = false;
  for (const id of wanted) if ((await join(root, id)) === "joined") any = true;
  if (any) return void phase.set("chat");
  if (resumeError.get()) return void phase.set("resume-error");
  // The conversations went away underneath us. The ordinary arrival is now
  // the right answer.
  restored = true;
  await arrive(root, agents.get());
}

/** "Leave it and start a new one" on the resume-error panel. Deliberately a
 *  separate gesture from the retry: abandoning a running conversation is the
 *  human's call to make, never a fallback the page takes on their behalf.
 *  The old sessions keep running — this page just stops naming them, which
 *  is what [#117](https://github.com/dglazkov/fsio/issues/117) is for. */
export async function abandonAndStartNew(): Promise<void> {
  const root = rootHandle;
  if (!root) return;
  // Named before the set is cleared, so the picker does not turn round and
  // offer back the very conversations the human just walked away from
  // (#117). They are still running, and still findable — by a later visit,
  // by the "+" menu, or by another tab.
  const stored = await loadOpen().catch(() => ({ ids: [], active: null }) as OpenSet);
  for (const id of wantedOpen(parseHash(location.hash), stored).ids) passedOver.add(id);
  if (lastFailedJoin) passedOver.add(lastFailedJoin);
  lastFailedJoin = null;
  reporter.event("resume-abandoned", { sessions: [...passedOver] });
  log("the human chose to leave the old conversations and start a new one");
  resumeError.set(null);
  restored = true;
  // The other button that says "start a new one" — same reason as
  // `declineRunning`.
  await startAnother();
}

export { detachAllOnPagehide };
