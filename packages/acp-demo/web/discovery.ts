// Finding a running conversation the page has no record of (#117): the half
// that needs a directory handle.
//
// The reading is here; the judging is in `../src/discovery.ts`, where it is
// testable in Node. Same split as history.ts / transcripts.ts, for the same
// reason — and the same posture towards what it reads: every byte comes out
// of the folder the human granted, which any co-tenant can write (D20), so
// it is parsed defensively and rendered as text. The one thing a row is
// trusted *into* is `attachSession(id)`, and that id came from the sessions
// directory itself, judged again by the host.
//
// This costs no new capability, which is most of the argument for it (P3):
// the page already holds this folder, and `listSessions()` is D18 discovery
// that the terminal demo has been using since #58. What was missing was not
// permission but a reason — /acp shipped without a picker on the grounds
// that one wanted a transcript story first, and #113's sticky sessions
// supplied it.
import { OUT_LOG_RE } from "@fsio/common";
import type { FsioClient } from "@fsio/client";
import { adoptableIds, peekConversation, startedAt, type Peek } from "../src/discovery.js";

/** One offer in the picker: a live conversation in this folder, described
 *  well enough to choose by. */
export interface Adoptable {
  /** the fsio session id — what `attachSession()` takes. */
  id: string;
  /** roster name from the spawn request, or "". */
  agent: string;
  /** what `initialize` answered, if the handshake is still in the retained
   *  stream (D26); "" once it has rotated away. */
  agentName: string;
  agentVersion: string;
  /** D17's marking: nothing is holding the uplink. */
  detached: boolean;
  /** who is holding it, when something is. */
  client: string;
  origin: string;
  startedAt: number | null;
  /** the last thing the agent said, one line of it. */
  lastLine: string;
  /** the agent's own conversation id, recovered from the stream. */
  acpSessionId: string | null;
  /** why this one cannot be rejoined, or "" when it can. A row that cannot
   *  be rejoined is still shown: "there is something running here that this
   *  page cannot get back into" is the fact the human needs before deciding
   *  to start a second conversation beside it. */
  blocked: string;
}

/** Every running ACP session in this folder that this page is not already
 *  driving. `exclude` carries what it holds and what it has deliberately
 *  walked away from (see `adoptableIds`).
 *
 *  A failure anywhere reads as "nothing to offer" for that row rather than
 *  an error for the whole list: the host sweeps directories underneath a
 *  scan, and half a picker beats no picker. */
export async function listAdoptable(root: FileSystemDirectoryHandle, client: FsioClient, exclude: ReadonlySet<string>): Promise<Adoptable[]> {
  let rows;
  try {
    rows = await client.listSessions();
  } catch {
    return []; // a torn scan (host GC mid-list); the next arrival corrects it
  }
  const wanted = adoptableIds(rows, exclude);
  if (!wanted.length) return [];
  const dir = await sessionsDir(root);
  if (!dir) return [];
  const out: Adoptable[] = [];
  for (const id of wanted) {
    const row = rows.find((r) => r.id === id)!;
    const one = await describe(dir, id).catch(() => null);
    if (!one) continue;
    out.push({
      id,
      agent: one.agent,
      agentName: one.peek.agentName,
      agentVersion: one.peek.agentVersion,
      detached: row.status?.detached === true,
      client: row.client ?? "",
      origin: row.origin ?? "",
      startedAt: startedAt(id),
      lastLine: one.peek.lastLine,
      acpSessionId: one.peek.acpSessionId,
      blocked: one.peek.acpSessionId
        ? ""
        : "this page could not find the conversation's own id in what the folder still holds, so it can't rejoin this one — only the page that started it can talk to this agent.",
    });
  }
  return out;
}

const sessionsDir = async (root: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle | null> => {
  try {
    return await (await root.getDirectoryHandle(".fsio")).getDirectoryHandle("sessions");
  } catch {
    return null;
  }
};

/** One session's directory, read for the picker.
 *
 *  The newest segment is tried alone first, and answers in every case that
 *  is not a fresh rotation: a conversation still going emits `session/update`
 *  constantly and each one names the ACP session. Falling back to the whole
 *  retained set covers the two that it doesn't — a segment that just rolled
 *  over, and a session that has done nothing since its handshake. */
async function describe(sessions: FileSystemDirectoryHandle, id: string): Promise<{ agent: string; peek: Peek } | null> {
  const dir = await sessions.getDirectoryHandle(id);
  const names: string[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "file" && OUT_LOG_RE.test(name)) names.push(name);
  }
  if (!names.length) return null;
  names.sort();
  const agent = await spawnedAgent(dir);
  const newest = await readSegment(dir, names[names.length - 1]!);
  const peek = peekConversation(newest ? [newest] : []);
  if (peek.acpSessionId && peek.lastLine) return { agent, peek };
  const all: Uint8Array[] = [];
  for (const name of names) {
    const bytes = await readSegment(dir, name);
    if (bytes) all.push(bytes);
  }
  return { agent, peek: peekConversation(all) };
}

/** The roster name the page asked for, out of the spawn request the host
 *  copied beside the session. Missing or unparseable is a normal state (a
 *  session mid-creation), not an error. */
async function spawnedAgent(dir: FileSystemDirectoryHandle): Promise<string> {
  try {
    const raw = JSON.parse(await (await (await dir.getFileHandle("spawn.json")).getFile()).text()) as Record<string, unknown>;
    // spawn.json carries the JSON-RPC spawn request; a legacy bare spec has
    // the fields at the top level (the same tolerance listSessions() has).
    const params = (raw["params"] && typeof raw["params"] === "object" ? raw["params"] : raw) as Record<string, unknown>;
    return typeof params["agent"] === "string" ? params["agent"] : "";
  } catch {
    return "";
  }
}

async function readSegment(dir: FileSystemDirectoryHandle, name: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer());
  } catch {
    return null; // torn or swept mid-read — normal (invariant 3, F11)
  }
}
