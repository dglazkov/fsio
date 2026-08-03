// N conversations in one page (#120): the lifecycle of each, and the set of
// them.
//
// `/acp` drove exactly one. The protocol never did — `FsioClient` has
// carried N sessions since #34, and the terminal demo has driven N shells
// through it since #58. What was singular was this page's own state, and
// that is what moved: the transcript, the turn, the queue and the agent's
// facts are fields on a `Conv` (state.ts), and everything below either makes
// one, joins one, or takes one away.
//
// Three gestures, and the difference between them is the whole of #120's
// second question — what closing a tab means.
//
//   close   — this conversation is over. The helper kills the agent (D6),
//             the record is demoted to history (#123), and the tab goes.
//             It asks first, because it is the only irreversible thing on
//             the page and because the tab's "×" is a click people make by
//             habit. That is what a tab means everywhere else, and #120's
//             third decision is the argument for keeping it: N tabs here is
//             N model bills and N child processes, where the
//             terminal demo's N tabs is N ptys. Agents are not shells.
//   leave   — the deliberate walk-away (D18). The agent keeps running, the
//             record is KEPT, and the conversation goes back to being one
//             the folder knows about and this page doesn't — findable in
//             the "+" menu, by this page or any other.
//   pagehide— the same walk-away, for every open conversation at once. #113's
//             answer to "what does a refresh mean", unchanged by tabs.
//
// The hazard the terminal demo taught (#120's own list): two tabs must never
// attach the same session, because attach is takeover (D18) and the second
// one fences the first. Here the cost is worse than a fenced shell — it is a
// fenced conversation — so `join` checks the open set before it attaches and
// focuses the tab that already holds it. Across *pages* takeover stands, and
// deliberately: that is what makes a pasted URL carry the conversations over.
import { RpcError, RpcErrors, type FsioSession } from "@fsio/client";
import { AcpConnection } from "./acp";
import { AgentSession } from "./agent";
import { log, reporter, step } from "./reporter";
import { active, activeId, convs, newConv, notice, phase, resumeError, type Conv, type ConvIO, type Diagnostics, type Entry, type Turn } from "./state";
import { getClient, currentRoot } from "./connection";
import { refreshPast } from "./history";
import { peekAdoptable } from "./discovery";
import { clearRecord, loadRecord, rememberAgent, saveOpen, saveRecord } from "./store";
import { formatHash, normalizeOpen } from "../src/tabs.js";
import type { StickyRecord } from "../src/resume.js";

// ------------------------------------------------------------- the open set

export const openIds = (): string[] => convs.get().map((c) => c.id);
const find = (id: string): Conv | undefined => convs.get().find((c) => c.id === id);

/** Write the open set down, twice, for the two jobs it does (src/tabs.ts):
 *  the URL so it can be handed to someone (P1), IndexedDB so a bare visit
 *  comes back to it. `replaceState` only — tab churn must not pollute the
 *  back button, which is the terminal demo's rule for the same reason. */
function syncOpen(): void {
  const open = normalizeOpen(openIds(), activeId.get());
  const hash = formatHash(open);
  history.replaceState(null, "", hash || location.pathname + location.search);
  saveOpen(open);
}

/** Bring one to the front. Clears its unread count — the count exists to
 *  say "something happened here while you were elsewhere", and you are no
 *  longer elsewhere. */
export function activate(id: string): void {
  const c = find(id);
  if (!c) return;
  activeId.set(id);
  c.unread.set(0);
  phase.set("chat");
  syncOpen();
}

/** Put one in the strip and bring it to the front. Exported because a
 *  document is added the same way a live conversation is (#140) — that
 *  sameness is the point of the change, so it goes through one function. */
export function addConv(c: Conv): void {
  convs.set([...convs.get(), c]);
  activate(c.id);
}

/** Take a conversation off the page. The session is whoever's business the
 *  caller made it — this only forgets it. */
function remove(c: Conv): void {
  clearInterval(c.diagTimer);
  const rest = convs.get().filter((x) => x !== c);
  convs.set(rest);
  if (activeId.get() !== c.id) return void syncOpen();
  const next = rest[rest.length - 1];
  if (next) return activate(next.id);
  activeId.set(null);
  syncOpen();
}

// ------------------------------------------------------------- the channel

/** What an `AgentSession` writes through (state.ts's `ConvIO`). One per
 *  conversation, which is the point: it is what replaced the module-level
 *  signals that made a second conversation impossible. */
export function convIO(c: Conv): ConvIO {
  return {
    push: (e: Entry): Entry => {
      c.entries.set([...c.entries.get(), e]);
      if (activeId.get() !== c.id) c.unread.set(c.unread.get() + 1);
      return e;
    },
    touch: () => c.entries.set([...c.entries.get()]),
    turn: () => c.turn.get(),
    setTurn: (t: Turn) => c.turn.set(t),
    setQueued: (q: readonly string[]) => setQueued(c, q),
    waiting: (delta: number) => {
      // A fenced window is not the one being asked, so its tab must not
      // claim to be: the agent is waiting on whoever holds the uplink.
      if (delta > 0 && c.superseded.get()) return;
      c.asking.set(Math.max(0, c.asking.get() + delta));
    },
    fenced: () => c.superseded.get() > 0,
    record: () => c.record,
    update: (fn: (r: StickyRecord) => void) => {
      if (!c.record) return;
      // Applied in memory either way: the record describes what THIS window
      // is showing, and its replay guard reads it.
      fn(c.record);
      // Persisted only while this window holds the uplink. A fenced one
      // cannot have typed anything and cannot have answered anything — it is
      // a reader — so its copy is, by construction, older than the holder's.
      // Writing it back is how a human's answers disappear (#120): the
      // window that took over has been recording clicks into the same key,
      // and this would overwrite them with a copy from before they happened.
      if (c.superseded.get()) return;
      saveRecord(c.record);
    },
  };
}

/** The queue is the one thing on this page the human cannot get back, so it
 *  is written through to the record on every change — a refresh mid-queue
 *  returns the text, not an apology. */
function setQueued(c: Conv, list: readonly string[]): void {
  c.queued.set([...list]);
  if (!c.record) return;
  c.record.queued = [...list];
  if (c.superseded.get()) return; // a reader's queue is not the session's
  saveRecord(c.record);
}

// ------------------------------------------------------------ a new one

/** `agent` is the name the human chose, or null to let the helper pick —
 *  which is what a helper too old to publish a roster gets. Either way the
 *  wire carries a **name**, never a path: the allow-list is host-side and
 *  judges it again (agents.ts, #6). */
export async function openNew(root: FileSystemDirectoryHandle, name: string | null): Promise<void> {
  const client = getClient();
  if (!client) return;
  step(name ? `asking the helper for ${name}` : "asking the helper for an agent");
  // What the page *asked* for, beside what the host reports it *started*
  // (`agent-started`): the pair is how a cooperative run verifies that the
  // chooser chose, rather than that the helper picked first-installed.
  reporter.event("agent-chosen", { agent: name });
  const s = client.createSession({ kind: "acp", client: "acp-demo", ...(name ? { agent: name } : {}) }, { pollMs: 15 });
  const c = newConv(s.id);
  c.session = s;
  c.title.set(name || "agent");
  const io = convIO(c);
  const conn = newConnection(s, c);
  addConv(c);
  watchSession(c, s);

  let facts: Record<string, unknown>;
  try {
    await s.ready;
    // A spawning client owns epoch 0, so it is fenceable the moment anyone
    // attaches — including the second window that opened while this one was
    // still starting up.
    armFence(c, s);
    facts = (await s.request<Record<string, unknown>>("acp/info")).result;
  } catch (e) {
    // A refusal from the host — no agent on PATH, an unknown name. The
    // message is written to be read by a human, so show it as one.
    const msg = e instanceof RpcError ? e.message : e instanceof Error ? e.message : String(e);
    notice.set({ msg: "the helper refused to start an agent", hint: msg });
    io.push({ kind: "error", text: msg });
    c.turn.set("gone");
    reporter.event("spawn-refused", { error: msg });
    return;
  }

  const cwd = readFacts(c, facts);
  reporter.event("agent-started", { session: c.id, agent: facts["agent"] });
  log(`agent ${String(facts["agent"])} in ${String(facts["cwd"])}`);
  // Remembered on a start that worked, not on the click: an agent that
  // refuses to spawn is not the one to re-offer next visit.
  void rememberAgent(String(facts["agent"] ?? name ?? "")).catch(() => {});
  watchDiagnostics(c);

  c.agent = new AgentSession(conn, root, cwd, io);
  try {
    const init = await c.agent.start();
    c.turn.set("idle");
    c.title.set(init.agentName || name || "agent");
    io.push({ kind: "note", text: `${init.agentName} ${init.agentVersion} is listening in ${root.name}/` });
    reporter.event("acp-ready", { session: c.id, agent: init.agentName, version: init.agentVersion, sessionId: c.agent.sessionId });
    step("agent ready");
    // From here the session is worth coming back to (#113): the record is
    // what makes the next load a reattach instead of a fresh start.
    begin(c, {
      sessionId: s.id,
      acpSessionId: c.agent.sessionId!,
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
    io.push({ kind: "error", text: `the agent could not start a session: ${msg}` });
    c.turn.set("gone");
    reporter.event("acp-start-failed", { session: c.id, error: msg });
  }
}

function begin(c: Conv, rec: StickyRecord): void {
  c.record = rec;
  saveRecord(rec);
}

// ------------------------------------------------------------ joining one

/** Four outcomes, and the distinction between the last three is the whole
 *  lesson of #115 plus what tabs added to it:
 *
 *    "joined"  — we are in the conversation.
 *    "gone"    — there is provably nothing to come back to: the helper was
 *                restarted (it runs `fresh: true` and wipes `.fsio`,
 *                deliberately), the agent exited, or the host refused the
 *                attach outright. Forgetting the record is correct.
 *    "blocked" — it is running and this page cannot speak to it: the folder
 *                no longer holds a frame naming the agent's own conversation
 *                id, so there is nothing to put in `session/prompt`. Retrying
 *                will not help; the caller says so instead of offering a
 *                button that cannot work.
 *    "failed"  — we could not reattach, and the session may well be alive.
 *                The record is KEPT and the caller must not start a second
 *                conversation. One aborted file commit used to land here and
 *                be treated as "gone", which deleted the human's turns and
 *                orphaned a running agent nothing could name again. */
export type JoinOutcome = "joined" | "gone" | "blocked" | "failed";

/** Errors that mean the session itself is unreachable, as opposed to our
 *  side failing to ask. Everything else is "failed" — the safe direction,
 *  because the cost of being wrong is a stuck tab the human can retry,
 *  against a lost conversation and a leaked process. */
function saysSessionIsGone(e: unknown): boolean {
  if (!(e instanceof RpcError)) return false;
  return e.code === RpcErrors.ATTACH_FAILED || e.code === RpcErrors.SPAWN_DENIED || e.code === RpcErrors.SHELL_NOT_ALLOWED;
}

/** Come back to a conversation by id, whatever this page knows about it.
 *
 *  Three sources, tried in that order, and the order is the honesty:
 *
 *    a record of our own   — the whole human half, woven back in (#113).
 *    the folder            — the agent's half only, and the page says so
 *                            for the rest of the conversation's life (#117).
 *    nothing               — it is not there. Say that, don't start one.
 *
 *  The second is what makes a pasted URL work in a browser that has never
 *  seen this conversation, which is #120's point: the link travels, the
 *  conversation stays where it is. */
export async function join(root: FileSystemDirectoryHandle, id: string): Promise<JoinOutcome> {
  const client = getClient();
  if (!client) return "failed";
  // Two tabs on one session would fence each other (D18 takeover), and the
  // fenced one holds a conversation. The picker filters these out; this is
  // the check that makes that a guarantee rather than a filter.
  const already = find(id);
  if (already) {
    activate(id);
    return "joined";
  }

  let live = false;
  try {
    // D18 discovery: the session listing is the only honest answer to "is
    // the thing I remember still there".
    const row = (await client.listSessions()).find((r) => r.id === id);
    live = !!row && row.kind === "acp" && row.status?.state === "running";
    reporter.event("resume-lookup", { sessionId: id, found: !!row, state: row?.status?.state ?? null });
  } catch (e) {
    // The listing itself failed, so we know nothing about the session —
    // including that it is dead. Not a licence to start another one.
    reporter.event("resume-failed", { sessionId: id, error: String(e), stage: "list" });
    resumeError.set({ msg: "could not read the sessions in this folder", hint: e instanceof Error ? e.message : String(e) });
    return "failed";
  }

  const held = await loadRecord(id).catch(() => null);
  if (!live) {
    log(`the conversation ${id} is gone`);
    await clearRecord(id, held);
    // The commonest way to get here is a helper restart, which used to take
    // the conversation with it. It no longer does (#119, D26 rule 4), so
    // say where it went — this is the exact moment someone asks.
    await refreshPast(root).catch(() => {});
    return "gone";
  }

  // No record of our own: rebuild what the folder can supply (#117). This is
  // also the path a shared URL takes in a browser that was never here.
  const rec = held ?? (await rebuild(root, id));
  if (!rec) return "blocked";
  return attach(root, rec, !held);
}

/** The record the missing one would have been — minus everything only the
 *  page that typed it could know. */
async function rebuild(root: FileSystemDirectoryHandle, id: string): Promise<StickyRecord | null> {
  const row = await peekAdoptable(root, id).catch(() => null);
  // The ACP session id is what `session/prompt` has to carry, so without one
  // this conversation can be seen and not spoken to.
  if (!row?.acpSessionId) {
    reporter.event("join-blocked", { sessionId: id, found: !!row });
    return null;
  }
  return {
    sessionId: id,
    acpSessionId: row.acpSessionId,
    agent: row.agent,
    agentName: row.agentName || row.agent || "agent",
    agentVersion: row.agentVersion,
    // Unknown until `acp/info` answers, and deliberately left empty rather
    // than guessed: it is what every `fs/*` path is judged against, and a
    // wrong cwd is a containment check that passes when it should not.
    // `attach` fills it in, and until it does nothing may act. A record
    // persisted inside that window fails `parseRecord` on the next load
    // (cwd is load-bearing there), which costs a trip back through the
    // picker — the one path that is always correct here.
    cwd: "",
    folder: root.name,
    // Replay's own bracket reports the generation it is re-emitting from and
    // the record is corrected there — there is nothing to compare it against
    // yet, because this page was never counting.
    gen: 0,
    prompts: [],
    queued: [],
    answers: {},
    pendingPromptId: null,
    adopted: true,
  };
}

/** `joining` is what is happening *now* — this page was not in this
 *  conversation a moment ago — as against `rec.adopted`, which is what stays
 *  true about the transcript afterwards. A refresh of a joined conversation
 *  is an ordinary reattach with a permanently short human half, and the two
 *  notes below say those two different things. */
async function attach(root: FileSystemDirectoryHandle, rec: StickyRecord, joining: boolean): Promise<JoinOutcome> {
  const client = getClient();
  if (!client) return "failed";
  step(`reattaching to ${rec.agentName || rec.agent}`);
  const c = newConv(rec.sessionId);
  c.title.set(rec.agentName || rec.agent || "agent");
  // The record has to be live before the first replayed frame arrives: the
  // handlers read it to tell a permission card they already answered from
  // one the agent is still waiting on.
  begin(c, rec);
  const io = convIO(c);
  const s = client.attachSession(rec.sessionId, { pollMs: 15, replay: true, client: "acp-demo" });
  c.session = s;
  const conn = newConnection(s, c);
  addConv(c);
  watchSession(c, s);
  // Constructed before `ready` is awaited, because replay runs inside the
  // attach grant — the frames rebuilding this conversation arrive before
  // that promise settles, and there would be no one to receive them.
  c.agent = new AgentSession(conn, root, rec.cwd, io, rec);

  let facts: Record<string, unknown>;
  let epoch = 1;
  try {
    const attached = (await s.ready) as { epoch?: number };
    // D18 writer epochs, borrowed for a second job: they partition this
    // connection's JSON-RPC ids from the ones the page it replaced used, so
    // a reply to the old page's request can never settle one of ours.
    epoch = attached.epoch ?? 1;
    conn.seedIds(epoch);
    // Our grant has landed, so a `writer` in status.json is now somebody
    // else's — including one who took it while this attach was in flight.
    armFence(c, s);
    facts = (await s.request<Record<string, unknown>>("acp/info")).result;
  } catch (e) {
    const msg = e instanceof RpcError ? e.message : e instanceof Error ? e.message : String(e);
    const gone = saysSessionIsGone(e);
    log(`could not reattach: ${msg}`);
    reporter.event("resume-failed", { sessionId: rec.sessionId, error: msg, code: e instanceof RpcError ? e.code : null, verdict: gone ? "gone" : "failed" });
    // Not `conn.close()`: its rejections land a microtask later, i.e. after
    // this conversation is removed, and would push an error into a Conv the
    // page has already stopped rendering.
    c.session = null;
    c.agent = null;
    remove(c);
    if (gone) {
      await clearRecord(rec.sessionId, rec);
      return "gone";
    }
    // The record SURVIVES (#115). The session is probably still there
    // holding the conversation, and the human's own turns exist nowhere else
    // — deleting them to recover from a failed file write is a trade nobody
    // would make on purpose.
    resumeError.set({
      msg: `could not rejoin the conversation with ${rec.agentName || rec.agent}`,
      hint: `${msg}\n\nThe session looks like it is still running, so nothing was started in its place. Trying again is usually enough.`,
    });
    return "failed";
  }

  const cwd = readFacts(c, facts);
  // A conversation joined without a record had no cwd to start with (#117):
  // only the host knows where the agent is rooted, and it says so here. The
  // session has been refusing every `fs/*` call until this line.
  if (!rec.cwd && cwd) {
    c.agent?.adoptCwd(cwd);
    io.update((r) => {
      r.cwd = cwd;
    });
  }
  c.resumed.set(true);
  c.adopted.set(rec.adopted);
  watchDiagnostics(c);
  // "starting" still means nothing else claimed the turn — a prompt that was
  // in flight across the refresh has already set it to "thinking" and owns
  // it until the agent answers.
  if (c.turn.get() === "starting") c.turn.set("idle");
  if (rec.adopted) {
    // At the TOP, where the missing part would have been — the same place
    // the read-only view puts its seams (#123). A caveat under a transcript
    // is a footnote; above one it is a description of what you are reading.
    c.entries.set([
      {
        kind: "note",
        text:
          "joined in progress — what follows is the agent's half, replayed from what the folder kept. " +
          "What was typed into it before now is not here, and neither are the answers to any questions it asked before now.",
      },
      ...c.entries.get(),
    ]);
  }
  reporter.event(joining ? "adopted" : "resumed", { sessionId: rec.sessionId, epoch, adopted: rec.adopted, prompts: rec.prompts.length, frames: conn.frameIndex });
  step(joining ? "joined a conversation in progress" : "reattached");
  return "joined";
}

// ------------------------------------------------------------- the plumbing

/** The connection every conversation gets. The two hooks are what a rebuild
 *  needs and a fresh session never fires. */
function newConnection(s: FsioSession, c: Conv): AcpConnection {
  return new AcpConnection(s, {
    onTraffic: (dir, msg) => reporter.event("acp", { session: c.id, dir, method: (msg as { method?: string }).method ?? null }),
    onUnhandled: (method) => log(`agent asked for something this client doesn't implement: ${method}`),
    onSendFailed: (e) => log(`conversation ${c.id}: a message could not be sent — ${e instanceof Error ? e.message : String(e)}`),
    onFrame: (index, replayed) => c.agent?.onFrame(index, replayed),
    onReplay: (replaying, gen) => c.agent?.onReplay(replaying, gen),
  });
}

/** `acp/info` → this conversation's facts (read from the host, never
 *  assumed). Returns the agent's cwd, which is also what `fs/*` containment
 *  is judged against. */
function readFacts(c: Conv, facts: Record<string, unknown>): string {
  const cwd = String(facts["cwd"] ?? "");
  const agent = String(facts["agent"] ?? "agent");
  c.facts.set({
    agent,
    title: String(facts["title"] ?? ""),
    state: facts["state"] as { mode: string; dirs: string[]; why: string },
    cwd,
  });
  if (c.title.get() === "agent") c.title.set(agent);
  return cwd;
}

/** Everything the host can say about a session that this page has to act on:
 *  the agent's death, and losing the uplink to somebody else. */
function watchSession(c: Conv, s: FsioSession): void {
  // The library's own words for the fence, into the page log — it is the
  // line that says whether a send failed because of D18 or because of
  // something else, and it costs nothing to keep.
  s.on("note", (m) => log(`session ${c.id}: ${m}`));
  s.on("status", (st) => {
    if (c.session !== s) return; // a conversation this page has already let go
    // Supersede fence (D18): a higher writer epoch means another page — or
    // another window of this one — attached and took the uplink. Reads
    // continue (this becomes a live read-only view of their conversation);
    // sends are poisoned. Only after `ready`: while our own attach is in
    // flight status.json already names OUR grant's epoch while `s.epoch` is
    // still 0, and checking early reads the grant as a takeover. The
    // terminal demo learned that in a cooperative run — a bogus banner on
    // every single reattach — and this is the same guard.
    if (settled.has(s)) fence(c, s, st.writer?.epoch ?? 0);
    if (st.state !== "exited" && st.state !== "error") return;
    c.turn.set("gone");
    c.asking.set(0);
    // #98: the kind's methods are gone the moment it exits, so the last
    // diagnostics snapshot is all we will ever have of the stderr that
    // says why. Stop polling and keep what we hold.
    clearInterval(c.diagTimer);
    // A session nobody can come back to is not worth remembering — and a
    // record pointing at a dead session would send the next load down the
    // reattach path for nothing.
    void clearRecord(c.id, c.record);
    c.record = null;
    // Nothing will ever send these now; say so rather than leaving them
    // sitting under a composer that looks like it is still going somewhere.
    const q = c.queued.get();
    if (q.length) {
      convIO(c).push({ kind: "note", text: `${q.length} queued prompt(s) never sent — the agent is gone` });
      reporter.event("queue-dropped", { session: c.id, count: q.length, why: "agent-exited" });
      c.queued.set([]);
    }
    const tail = c.diagnostics.get()?.stderr ?? [];
    convIO(c).push({
      kind: "error",
      text:
        `the agent exited${st.exitCode === undefined || st.exitCode === null ? "" : ` (code ${st.exitCode})`}` +
        (tail.length ? `\nlast stderr:\n${tail.slice(-6).join("\n")}` : ""),
    });
    reporter.event("agent-exited", { session: c.id, exitCode: st.exitCode ?? null, stderrTail: tail.slice(-6) });
  });
}

/** Sessions whose grant has landed, so a `writer` in status.json is somebody
 *  else's rather than our own. A WeakSet rather than a field because it is
 *  about the session object, not the conversation: a retake replaces the
 *  session and the new one starts unsettled again. */
const settled = new WeakSet<FsioSession>();

/** Call once `ready` has resolved: the epoch is known, so the fence can be
 *  judged — including a takeover that raced our attach window, which the
 *  status stream will not re-emit on its own (it dedups). */
function armFence(c: Conv, s: FsioSession): void {
  settled.add(s);
  fence(c, s, s.status?.writer?.epoch ?? 0);
}

/** Lost the uplink to a higher epoch (D18).
 *
 *  What this page owes the human here is more than the terminal demo owes
 *  its own: a fenced shell is a shell you are watching someone else type
 *  into, and the keystrokes are visible in the output. A fenced conversation
 *  is not. Prompts ride the *uplink*, which is one writer's and is never
 *  replayed — so the other window's turns are invisible here, and what keeps
 *  arriving is the agent answering questions this transcript does not
 *  contain. That is a document with holes in it, and it has to say so rather
 *  than let the holes look like the agent talking to itself. */
function fence(c: Conv, s: FsioSession, epoch: number): void {
  if (!epoch || epoch <= s.epoch || c.superseded.get()) return;
  c.superseded.set(epoch);
  clearInterval(c.diagTimer);
  // Nothing queued here will ever be sent — the lane is gone (the client
  // drops the queue at the fence too, F8).
  const q = c.queued.get();
  if (q.length) c.queued.set([]);
  if (c.turn.get() === "thinking" || c.turn.get() === "cancelling") c.turn.set("idle");
  reporter.event("superseded", { session: c.id, byEpoch: epoch, ours: s.epoch, droppedQueue: q.length });
  log(`conversation ${c.id} taken over by writer epoch ${epoch} — reads continue, sends are refused`);
  // A seam, not an explanation. The banner that replaced the composer is the
  // one saying what a takeover is and offering the way out of it; this is
  // only the mark in the transcript for where it happened — plus the one
  // fact the banner cannot know, which is what was still queued here.
  convIO(c).push({
    kind: "note",
    text:
      "another window took this conversation over here." +
      (q.length ? ` ${q.length} queued prompt${q.length === 1 ? "" : "s"} will not be sent.` : ""),
  });
}

/** Take it back (#58's `retakeTab`, for a conversation).
 *
 *  Locally release the fenced session — `detach()` cannot reach the host,
 *  the uplink is gone, but it tears down timers and listeners — then attach
 *  anew, which bumps the epoch back this way and fences the other window
 *  instead. Going through `join()` rather than patching the session in place
 *  is deliberate: the attach replays, and the replay is what rebuilds the
 *  transcript with this browser's own turns woven back in. The other
 *  window's turns are still not here, and still cannot be. */
export async function retake(root: FileSystemDirectoryHandle, id: string): Promise<JoinOutcome> {
  const c = find(id);
  if (!c || !c.superseded.get()) return "failed";
  const s = c.session;
  c.session = null;
  c.agent = null;
  reporter.event("retake", { session: id, from: c.superseded.get() });
  step("taking the conversation back");
  await s?.detach().catch(() => {});
  remove(c);
  return join(root, id);
}

function watchDiagnostics(c: Conv): void {
  clearInterval(c.diagTimer);
  c.diagTimer = setInterval(() => {
    const s = c.session;
    if (!s) return;
    void s
      .request<Diagnostics>("acp/diagnostics")
      .then(({ result }) => c.diagnostics.set(result))
      .catch(() => {}); // exited (#98) or in flight — the last snapshot stands
  }, 3000);
}

// ---------------------------------------------------------------- input
//
// All of these act on the ACTIVE conversation, because all of them are a
// human doing something to what is on screen. A background conversation is
// not typed into; it is watched, and it goes on without being watched.

/** Send now, or hold it until the turn ends.
 *
 *  One turn is in flight at a time (ACP), so the alternatives were queue or
 *  refuse. Refusing is what the page used to do, badly — it took the text
 *  and dropped it. A queue is the version that keeps faith with someone who
 *  typed a follow-up while reading the answer to the last one. */
export function sendPrompt(text: string): void {
  const c = active.get();
  const a = c?.agent;
  if (!c || !a) return;
  // Fenced (D18): the uplink belongs to another window, so this would throw
  // out of the client and land as "prompt failed: superseded" under a
  // composer that looked willing. The banner says what to do instead.
  if (c.superseded.get()) return;
  const t = c.turn.get();
  if (t === "gone" || t === "starting") return;
  if (t !== "idle") {
    setQueued(c, [...c.queued.get(), text]);
    reporter.event("prompt-queued", { session: c.id, depth: c.queued.get().length });
    return;
  }
  void runTurn(c, a, text);
}

/** One turn, then the next queued prompt if the conversation is still
 *  healthy. Draining here rather than on a signal watcher keeps the ordering
 *  obvious: a queued prompt is sent by the turn that was blocking it. */
async function runTurn(c: Conv, a: AgentSession, text: string): Promise<void> {
  await a.prompt(text);
  const q = c.queued.get();
  // `turn` is whatever prompt() left behind — `gone` if the agent exited,
  // and cancelTurn() empties the queue — so both stop the drain.
  if (!q.length || c.turn.get() !== "idle" || c.agent !== a) return;
  setQueued(c, q.slice(1));
  void runTurn(c, a, q[0]!);
}

/** Drop a queued prompt without sending it. */
export function unqueue(index: number): void {
  const c = active.get();
  if (!c) return;
  const q = c.queued.get();
  if (index < 0 || index >= q.length) return;
  setQueued(
    c,
    q.filter((_, i) => i !== index)
  );
}

/** Stop is the human's brake, so it stops what is coming too: a queue that
 *  kept firing after "stop" would be the opposite of what the button says.
 *  Dropped prompts are announced rather than silently discarded. */
export function cancelTurn(): void {
  const c = active.get();
  if (!c || c.superseded.get()) return; // the brake belongs to whoever holds the uplink
  const dropped = c.queued.get().length;
  if (dropped) {
    setQueued(c, []);
    convIO(c).push({ kind: "note", text: `stopped — ${dropped} queued prompt${dropped === 1 ? "" : "s"} dropped` });
    reporter.event("queue-dropped", { session: c.id, count: dropped, why: "cancel" });
  }
  c.agent?.cancel();
}

// ---------------------------------------------------------------- lifetime

/** Close: this conversation is over and the agent stops (#120's decision 2).
 *
 *  The only irreversible thing on the page, so it is also the only one that
 *  asks first. What it costs is stated in the question rather than in a
 *  tooltip nobody opens, and the alternative gesture is named there too —
 *  the failure to avoid is someone reaching for "×" out of tab-habit and
 *  killing a conversation they meant to leave running. */
export async function closeConv(id: string, confirmed = false): Promise<void> {
  const c = find(id);
  if (!c) return;
  // A document (#140). Nothing to stop, nothing to close, nothing to forget:
  // the transcript stays in the folder and the chip can be opened again from
  // "+". So "×" here is genuinely just putting it away, and asking first
  // would be a confirm on a gesture with no cost — which is what teaches
  // people to click through the one that has.
  if (c.doc) {
    reporter.event("history-close", { id: c.id });
    remove(c);
    return;
  }
  const s = c.session;
  const alive = !!s && c.turn.get() !== "gone";
  if (alive && !confirmed) return;
  const a = c.agent;
  c.session = null;
  c.agent = null;
  // "gone" before the connection goes: a turn cut short by this has already
  // been explained, and does not need an error above it saying the
  // connection closed.
  c.turn.set("gone");
  a?.conn.close();
  clearInterval(c.diagTimer);
  reporter.event("session-ended", { session: c.id });
  await clearRecord(c.id, c.record);
  c.record = null;
  try {
    await s?.close(); // the helper kills the child (D6)
  } catch {}
  remove(c);
  log(`conversation ${c.id} ended by the human`);
  // The host sweeps the session dir a beat after the close and keeps the
  // transcript on the way out (#119) — look again once it has.
  const root = currentRoot();
  if (root) setTimeout(() => void refreshPast(root).catch(() => {}), 1500);
}

/** Leave it running (D18): mark the session detached NOW, so the "+" menu
 *  shows it as unambiguously rejoinable — no waiting out the
 *  heartbeat-silence window (D17, 3 min default). The agent keeps running
 *  and the record is KEPT, which is what makes coming back to it a resume
 *  rather than a join: the human's own turns are still here. */
export async function leaveConv(id: string): Promise<void> {
  const c = find(id);
  if (!c) return;
  const s = c.session;
  c.session = null;
  c.agent = null;
  reporter.event("detach", { session: c.id });
  remove(c);
  await s?.detach().catch(() => {});
  log(`left ${c.id} running — rejoin it from the “+” menu`);
}

/** Page teardown (#113), for every conversation at once. One word
 *  changed here once and it inverted the demo's whole answer to "what does a
 *  refresh mean": `close()` asked the helper to kill the agent, and it
 *  obliged — measured, six milliseconds after the notification landed.
 *  `detach()` is the deliberate walk-away (D18): the host marks the session
 *  detached NOW, with no wait on D17's 180 s silence window, and leaves
 *  state, process and stream untouched for the attach that comes next.
 *
 *  The records are already durable — written through on every change, never
 *  flushed here, because an IndexedDB write started at `pagehide` is a race
 *  against document teardown that the write loses. With N conversations it
 *  would be N races.
 *
 *  The ACP connections are deliberately NOT closed. Closing one rejects its
 *  in-flight `session/prompt`, whose rejection handler would clear the very
 *  id the next page needs to adopt in order to see that turn finish. A
 *  connection whose document is being torn down does not need tidying; a
 *  record that lies about a running turn does. */
export function detachAllOnPagehide(): void {
  for (const c of convs.get()) {
    const s = c.session;
    c.session = null;
    c.agent = null;
    void s?.detach().catch(() => {});
  }
}

// Live tab state, straight into report.json for the cooperative loop
// (TESTING.md) — the same hook the terminal demo injects, for the same
// reason: multi-tab behaviour is exactly what an agent reading verdicts from
// the native side cannot otherwise see.
reporter.summary = () =>
  convs.get().map((c) => ({
    session: c.id,
    agent: c.title.get(),
    turn: c.turn.get(),
    active: c.id === activeId.get(),
    adopted: c.adopted.get(),
    resumed: c.resumed.get(),
    unread: c.unread.get(),
    asking: c.asking.get(),
    superseded: c.superseded.get(),
    epoch: c.session?.epoch ?? null,
    // A conversation that is over, open as a chip (#140). The cooperative
    // loop has to be able to tell one from a live conversation whose agent
    // exited: both read "gone", and only one of them was ever a session.
    document: !!c.doc,
  }));
