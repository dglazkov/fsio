// Reading back a conversation that ended (#119, D26 rule 4): the pure half.
//
// The helper keeps ended sessions' out logs under `.fsio/transcripts/<id>/`
// rather than deleting them with the session. What arrives here is that
// directory's paperwork — `meta.json`, the copied `spawn.json`, and the
// names of the segments beside them — and what leaves is one row a page can
// render, or null.
//
// Everything is checked, and the reason is sharper than ordinary hygiene.
// Live replay's frames came off a stream the host was writing; a *stored*
// transcript is a file any co-tenant of the folder can write, and the page
// cannot tell a real one from a planted one (D20). So this parses like a
// stranger wrote it, renders as text, and never yields anything a caller
// could act on. Pure so it can be tested without a browser
// (test-transcripts.ts); the parts that need a directory handle live in
// web/history.ts.
import { OUT_LOG_RE } from "@fsio/common";

/** One ended conversation, as a page can safely show it. Not a session:
 *  nothing here is attachable, and the agent that spoke these words exited
 *  before the reader arrived. */
export interface PastConversation {
  id: string;
  /** roster name from the spawn request the page itself sent, or "". */
  agent: string;
  /** session kind (`acp`), or "". */
  kind: string;
  /** epoch ms the host swept the session; 0 when the meta did not say. */
  ended: number;
  /** what ended it, for display: "closed", "host closed", … */
  why: string;
  /** generation of the oldest segment kept. */
  gen: number;
  /** cumulative bytes the session ever wrote, against what survived. */
  total: number;
  bytes: number;
  /** segment file names, oldest first. Never empty — a transcript with no
   *  log is not a transcript, and offering one is offering a blank page. */
  logs: string[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** The segments of a transcript directory, oldest first. Anything that is
 *  not a segment name is not a segment: a directory in the folder the human
 *  granted holds whatever the human (or anything else) put there. */
export function segmentsOf(names: readonly string[]): string[] {
  return names.filter((n) => OUT_LOG_RE.test(n)).sort();
}

/** One row, or null when there is nothing honest to show. `rawMeta` and
 *  `rawSpawn` are whatever `JSON.parse` returned — including null, when the
 *  file was missing or unparseable, which is a normal state and not an
 *  error: an older transcript, or one written by a host mid-sweep. */
export function parseTranscript(id: string, rawMeta: unknown, rawSpawn: unknown, names: readonly string[]): PastConversation | null {
  if (!id) return null;
  const logs = segmentsOf(names);
  if (!logs.length) return null;
  const meta = (rawMeta && typeof rawMeta === "object" ? rawMeta : {}) as Record<string, unknown>;
  const spawn = (rawSpawn && typeof rawSpawn === "object" ? rawSpawn : {}) as Record<string, unknown>;
  // spawn.json carries the JSON-RPC spawn request; a legacy bare spec has
  // the fields at the top level (the same tolerance listSessions() has).
  const params = (spawn["params"] && typeof spawn["params"] === "object" ? spawn["params"] : spawn) as Record<string, unknown>;
  return {
    id,
    agent: str(params["agent"]) ?? "",
    kind: str(meta["kind"]) ?? str(params["kind"]) ?? "",
    ended: num(meta["ended"]) ?? 0,
    why: str(meta["why"]) ?? "",
    gen: num(meta["gen"]) ?? 0,
    total: num(meta["total"]) ?? 0,
    bytes: num(meta["bytes"]) ?? 0,
    logs,
  };
}

/** Whether what was kept is the tail of a longer conversation rather than
 *  the whole of it (#57): either the retained segments start above
 *  generation 0, or fewer bytes survived than the session ever wrote. A
 *  reader that does not say so is lying by omission — the transcript would
 *  simply appear to begin mid-sentence. */
export function isTail(p: Pick<PastConversation, "gen" | "total" | "bytes">): boolean {
  return p.gen > 0 || (p.total > 0 && p.total > p.bytes);
}

/** Newest first. Ties (and transcripts whose meta gave no time, which sort
 *  last) fall back to the session id, whose `s-<ts36>-<rand>` prefix is
 *  itself a timestamp — so the order stays stable rather than depending on
 *  the order the directory happened to enumerate. */
export function newestFirst(list: readonly PastConversation[]): PastConversation[] {
  return [...list].sort((a, b) => b.ended - a.ended || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}
