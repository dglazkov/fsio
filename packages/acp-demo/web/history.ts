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
// Two things this view cannot do, both of them structural rather than
// unfinished:
//
//   The human's turns are not here. Prompts rode the *uplink*, and the out
//   log is downlink-only (D18) — the same asymmetry D32 rule 2 handles for
//   a refresh by carrying the human's half in the page. A session that has
//   ended has no such record left, so what a past conversation shows is the
//   agent's half, and the banner says exactly that rather than presenting a
//   half as a whole.
//
//   Nothing here may act. A replayed request never acts even when the
//   session is alive (D32 rule 3); a *stored* transcript is weaker still —
//   it is a file any co-tenant of the folder can write, with none of live
//   replay's provenance, and the page cannot tell a real one from a planted
//   one (D20). So it is parsed defensively, rendered as text, and the
//   connection it replays through has no wire attached to send anything on.
import { FrameType, parseFrames } from "@fsio/common";
import { isTail, newestFirst, parseTranscript, type PastConversation } from "../src/transcripts.js";
import { AcpConnection } from "./acp";
import { AgentSession } from "./agent";
import { log, reporter } from "./reporter";
import { past, pastEntries, pushPast, viewing } from "./state";

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
  reporter.event("history-open", { id: p.id, agent: p.agent, bytes: p.bytes, logs: p.logs.length });
  const conn = new AcpConnection(null, {
    onUnhandled: (method) => log(`past conversation: nothing renders ${method}`),
  });
  // cwd "" — every path in here is history, and the containment check it
  // would feed is never reached: history mode answers no `fs/*` call.
  new AgentSession(conn, root, "", null, true);

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
  if (unread) pushPast({ kind: "error", text: `${unread} segment(s) of this transcript could not be read.` });
  if (!frames) pushPast({ kind: "note", text: "this transcript holds no agent messages — the session ended before the agent said anything." });
  // The rotation seam, said out loud rather than left to look like the
  // start of the conversation (#57, D26 rule 1).
  if (isTail(p)) {
    pastEntries.set([
      { kind: "note", text: "the earlier part of this conversation had already rotated out of the retained stream when it was kept — what follows is the tail." },
      ...pastEntries.get(),
    ]);
  }
  reporter.event("history-rendered", { id: p.id, frames, entries: pastEntries.get().length, unreadSegments: unread });
  log(`past conversation ${p.id}: ${frames} frames → ${pastEntries.get().length} entries`);
}

/** Leave the read-only view. The live conversation was never touched — it
 *  is a separate list, and an agent that kept working while it was being
 *  read back has been appending to it the whole time. */
export function closePast(): void {
  if (!viewing.get()) return;
  reporter.event("history-close", { id: viewing.get()?.id ?? null });
  viewing.set(null);
  pastEntries.set([]);
}
