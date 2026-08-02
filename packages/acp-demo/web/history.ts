// Reading a conversation that is over (#119, D26 rule 4).
//
// The helper keeps ended sessions' out logs under `.fsio/transcripts/<id>/`
// instead of deleting them with the session. This is the page half of that:
// a list of what is in there, and a read-only replay of one.
//
// It costs no new capability, and that is the argument for it. The page
// already holds a handle to this folder — the same grant, the same gesture,
// no new rung (P3) — and the transcript is the same DATA frames the live
// stream carried, so it goes through the same `session/update` handlers
// that built the conversation the first time (P2: it rode the folder, so
// the folder is where it is read back from). No live agent, no
// `session/load`, no protocol change.
//
// The human's turns are not in the folder and never will be: prompts rode
// the *uplink*, and the out log is downlink-only (D18) — the same asymmetry
// a refresh handles by carrying the human's half in the page (#113). So
// this view asks the page for it (#123). When this browser drove
// the conversation, the record it kept was demoted rather than deleted when
// the session ended, and the same `promptsBefore` weave puts those turns
// back between the right two things the agent said. When it did not — a
// transcript from another browser, another profile, a cleared IndexedDB —
// there is only the agent's half, and the banner says so rather than
// presenting a half as a whole.
//
// One thing this view still cannot do, structurally rather than because it
// is unfinished:
//
//   Nothing here may act. A replayed request never acts even when the
//   session is alive (#113); a *stored* transcript is weaker still —
//   it is a file any co-tenant of the folder can write, with none of live
//   replay's provenance, and the page cannot tell a real one from a planted
//   one (D20). So it is parsed defensively, rendered as text, and the
//   connection it replays through has no wire attached to send anything on.
import { FrameType, parseFrames } from "@fsio/common";
import { isTail, newestFirst, parseTranscript, type PastConversation } from "../src/transcripts.js";
import { anchorsAlign } from "../src/resume.js";
import { AcpConnection } from "./acp";
import { AgentSession } from "./agent";
import { log, reporter } from "./reporter";
import { past, pastEntries, pushPast, viewing, viewingHalf, type ConvIO } from "./state";
import { pastRecord, prunePast } from "./store";

/** The channel a document gets (#120's `ConvIO`, #119's rules).
 *
 *  Every method here is either "put it in the other list" or a no-op, and
 *  that IS the read-only guarantee, stated once in the plumbing instead of
 *  re-checked in every handler. There is no turn to set: nobody is waiting.
 *  There is no record to update: the record this conversation had was
 *  demoted when it ended, and writing to it now would be editing history.
 *  There is nothing to count as waiting: the agent that asked exited before
 *  this page loaded. */
const documentIO = (): ConvIO => ({
  push: pushPast,
  touch: () => pastEntries.set([...pastEntries.get()]),
  turn: () => "gone",
  setTurn: () => {},
  setQueued: () => {},
  waiting: () => {},
  // Permanently, and for a stronger reason than a superseded window's: the
  // agent that asked these questions exited before this page loaded.
  fenced: () => true,
  record: () => null,
  update: () => {},
});

/** What `.fsio/transcripts/` holds, newest first. The reading is here; the
 *  judging is in `../src/transcripts.ts`, where it is testable in Node. A
 *  directory that does not parse is skipped rather than shown half-read. */
export async function listPast(root: FileSystemDirectoryHandle): Promise<PastConversation[]> {
  const dir = await transcriptsDir(root);
  if (!dir) return []; // no helper, or nothing has ended in this folder yet
  const out: PastConversation[] = [];
  try {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== "directory") continue;
      const one = await readOne(handle as FileSystemDirectoryHandle, name).catch(() => null);
      if (one) out.push(one);
    }
  } catch {
    return newestFirst(out); // mid-sweep read; what we have is still true
  }
  return newestFirst(out);
}

const transcriptsDir = async (root: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle | null> => {
  try {
    return await (await root.getDirectoryHandle(".fsio")).getDirectoryHandle("transcripts");
  } catch {
    return null;
  }
};

async function readOne(dir: FileSystemDirectoryHandle, id: string): Promise<PastConversation | null> {
  const names: string[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "file") names.push(name);
  }
  // The agent's roster name lives in the spawn request the page itself
  // sent, copied beside the log by the host. Either file being missing or
  // unreadable is a normal state, not an error — one less thing to show.
  return parseTranscript(id, await readJson(dir, "meta.json"), await readJson(dir, "spawn.json"), names);
}

async function readJson(dir: FileSystemDirectoryHandle, name: string): Promise<unknown> {
  try {
    return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text()) as unknown;
  } catch {
    return null;
  }
}

/** Refresh the list. Cheap enough to call on every connect and after every
 *  session ends — a handful of small reads. */
export async function refreshPast(root: FileSystemDirectoryHandle): Promise<void> {
  const list = await listPast(root);
  past.set(list);
  // The folder is the authority on what is worth annotating (#123): a
  // browser-side half whose transcript the folder has moved past is dropped
  // here, which is what keeps this origin's copy a satellite rather than a
  // second archive nobody bounded.
  void prunePast(
    root.name,
    list.map((p) => p.id)
  ).catch(() => {});
  if (list.length) log(`${list.length} past conversation(s) kept in this folder`);
}

/** Replay one, into the transcript pane, read-only.
 *
 *  The AgentSession here is the real one — same handlers, same rendering —
 *  constructed in history mode over a connection with no session behind it.
 *  That is what makes this cheap AND what keeps it honest: if the live
 *  renderer gains a case, this gains it too, and there is no second
 *  interpretation of the same bytes to drift. */
export async function openPast(root: FileSystemDirectoryHandle, p: PastConversation): Promise<void> {
  viewing.set(p);
  pastEntries.set([]);
  // The half the folder never had, if this browser is the one that typed it
  // (#123). Read before the first frame is fed: the weave runs frame by
  // frame, so a record that arrived late would land its turns at the end.
  const mine = await pastRecord(p.id);
  viewingHalf.set(mine ? { prompts: mine.prompts.length, placed: anchorsAlign(mine, p.gen), adopted: mine.adopted } : null);
  reporter.event("history-open", { id: p.id, agent: p.agent, bytes: p.bytes, logs: p.logs.length, prompts: mine?.prompts.length ?? null });
  let session: AgentSession | null = null;
  const conn = new AcpConnection(null, {
    onUnhandled: (method) => log(`past conversation: nothing renders ${method}`),
    // Every frame in here is history by construction, so the second argument
    // is a constant — this is the same hook the live rebuild uses, and it is
    // what puts each of the human's turns in front of the frame it preceded.
    onFrame: (index) => session?.onFrame(index, true),
  });
  // cwd "" — every path in here is history, and the containment check it
  // would feed is never reached: history mode answers no `fs/*` call.
  session = new AgentSession(conn, root, "", documentIO(), null, { past: mine });

  let frames = 0;
  let unread = 0;
  const dir = await transcriptsDir(root);
  for (const name of p.logs) {
    let bytes: Uint8Array;
    try {
      if (!dir) throw new Error("transcripts directory is gone");
      const file = await (await dir.getDirectoryHandle(p.id)).getFileHandle(name);
      bytes = new Uint8Array(await (await file.getFile()).arrayBuffer());
    } catch {
      unread++;
      continue;
    }
    // A trailing partial frame is possible in principle (the host moved the
    // file, but the last append is the host's own byte accounting) —
    // `parseFrames` stops at the first incomplete one, which is the right
    // answer either way: show what is whole.
    for (const f of parseFrames(bytes).frames) {
      if (f.type !== FrameType.DATA) continue; // RPC frames are fsio's control plane, not the agent's words
      frames++;
      conn.feed(f.payload);
    }
  }
  // Turns taken after the agent's last word — and, when the anchors were
  // measured against a stream that has since rotated, every turn whose
  // anchor overshot this one. Misplaced beats missing.
  session.flushPrompts();
  if (unread) pushPast({ kind: "error", text: `${unread} segment(s) of this transcript could not be read.` });
  if (!frames) pushPast({ kind: "note", text: "this transcript holds no agent messages — the session ended before the agent said anything." });
  // Two seams, two separate facts, both said out loud rather than left to
  // look deliberate: what the folder no longer holds (#57, D26 rule 1), and
  // what the page's own anchors can no longer be trusted to place (#123).
  const head: { kind: "note"; text: string }[] = [];
  if (isTail(p))
    head.push({
      kind: "note",
      text: "the earlier part of this conversation had already rotated out of the retained stream when it was kept — what follows is the tail.",
    });
  if (mine?.prompts.length && !anchorsAlign(mine, p.gen))
    head.push({
      kind: "note",
      text: "your own turns are from this browser's record of the conversation, and the stream they were anchored against has rotated since — they are all here, but not necessarily in the right places.",
    });
  // A third seam (#117): this browser joined the conversation partway
  // through, so its record of the human half starts where the page did. The
  // turns before that point are not late or misplaced — they were never
  // here, and no browser is holding them.
  if (mine?.adopted)
    head.push({
      kind: "note",
      text: "this page joined this conversation while it was already running, so what it kept of your side starts from that moment. Anything typed into it before then rode the uplink and was recorded in a browser that is not this one.",
    });
  if (head.length) pastEntries.set([...head, ...pastEntries.get()]);
  reporter.event("history-rendered", {
    id: p.id,
    frames,
    entries: pastEntries.get().length,
    unreadSegments: unread,
    prompts: mine?.prompts.length ?? 0,
    placed: mine ? anchorsAlign(mine, p.gen) : null,
  });
  log(`past conversation ${p.id}: ${frames} frames → ${pastEntries.get().length} entries`);
}

/** Leave the read-only view. The live conversation was never touched — it
 *  is a separate list, and an agent that kept working while it was being
 *  read back has been appending to it the whole time. */
export function closePast(): void {
  if (!viewing.get()) return;
  reporter.event("history-close", { id: viewing.get()?.id ?? null });
  viewing.set(null);
  viewingHalf.set(null);
  pastEntries.set([]);
}
