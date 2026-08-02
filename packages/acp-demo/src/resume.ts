// Sticky sessions (#113): what the page must carry across a refresh, and
// the two rules for putting a conversation back together.
//
// The shape of the problem. Three lifetimes are involved and only the
// middle one changed with #113: the folder grant lives in Chrome,
// the fsio session lives in the helper — and now outlives the page — and
// the ACP conversation lives in the agent process, which never noticed the
// page was gone.
//
// On return the page reattaches with `replay: true`, and the session's out
// stream gives back the agent's whole side of the conversation. What it
// cannot give back is the human's side: prompts rode the *uplink*, and
// replay is downlink-only (D18). So the page persists its own turns, each
// anchored to the stream position where it was sent, and weaves them back
// in — `bucketPrompts` below is that weave.
//
// The second rule is about what a replayed frame is allowed to *do*. The
// downlink carries the agent's requests as well as its words, and re-running
// them would re-execute writes a human approved against a folder that has
// moved on. Replayed requests therefore never act; a permission question is
// the one exception, because the agent is still blocked on it — and
// `answers` is how the page tells a question it already settled from one it
// still owes.
//
// ---- and after it is over (#123)
//
// The record dies with the session it describes — it points at something
// that is not there. But it is also the only copy of the human's half, and
// the moment those turns stop being state is the moment they become
// history, which is exactly when a reader wants them. So the record is
// demoted rather than deleted: the half the folder cannot have moves to a
// `PastRecord`, keyed by session id, and the read-only view weaves it into
// the transcript with the same `promptsBefore` the live page uses.
//
// The bound on that is the folder's, not ours. D26 rule 4 bounds what the
// *folder* keeps; a browser-side copy needs its own sentence, and the one
// that keeps the folder in charge is: as many as the folder keeps, keyed by
// session id, dropped once the folder has demonstrably moved past them
// (`prunablePast`). The browser copy is a satellite that cannot outlive the
// transcript it annotates.
//
// Everything here is pure so it can be tested without a browser
// (test-resume.ts); the parts that need a directory handle or a signal live
// in web/.

/** One turn the human took. `atFrame` is the number of DATA frames the page
 *  had consumed from the session's out stream when it was sent — the anchor
 *  that puts it back between the right two things the agent said. */
export interface StickyPrompt {
  text: string;
  atFrame: number;
}

/** Everything the page must remember about a session it intends to come
 *  back to. Small on purpose: the agent's half of the transcript is NOT in
 *  here, because the folder already has it (P2 — the conversation rode the
 *  folder, so the folder is where it is read back from). */
export interface StickyRecord {
  /** the fsio session id — what `attachSession()` takes. */
  sessionId: string;
  /** the agent's own conversation id, from `session/new`. Reused verbatim:
   *  a reattached page does not re-handshake (#113). */
  acpSessionId: string;
  /** roster name of the agent that was chosen (#102), for the record's own
   *  display and for the fallback when the session turns out to be gone. */
  agent: string;
  /** what `initialize` said. Persisted because there is no second
   *  `initialize` to ask again (#113). */
  agentName: string;
  agentVersion: string;
  /** the agent's cwd, from `acp/info`. Needed before `ready` resolves,
   *  because replayed frames arrive first and `fs/*` containment is judged
   *  against it. */
  cwd: string;
  /** the granted folder's name. Not used to find anything — the handle in
   *  IndexedDB does that — but to say which folder this conversation
   *  belongs to once it is over (#123), so that connecting to a *second*
   *  folder cannot read its transcripts as a verdict on the first one's
   *  records. "" for a record written before this existed. */
  folder: string;
  /** out-segment generation last seen. A higher one on return means the
   *  head rotated and the replay is a suffix of the conversation, not all
   *  of it (D26, #57) — the page says so rather than pretending. */
  gen: number;
  /** the human's turns, oldest first. */
  prompts: StickyPrompt[];
  /** prompts typed while the agent was busy and not yet sent. */
  queued: string[];
  /** permission requests already settled: the agent's request id → the
   *  option chosen, or null for a cancel. Replay re-delivers the question;
   *  this is what keeps the page from asking it twice. */
  answers: Record<string, string | null>;
  /** the id of a `session/prompt` that was still in flight when the page
   *  left, or null. Its response will arrive addressed to a connection that
   *  no longer exists, so the returning page adopts the id (see
   *  web/acp.ts) — otherwise the turn spins forever. */
  pendingPromptId: number | null;
  /** true when this record was rebuilt by the session picker (#117) rather
   *  than written by the page that started the conversation.
   *
   *  It is durable because what it says is durable: everything before the
   *  moment of adoption has no human half *anywhere* — the turns are in an
   *  IndexedDB this browser cannot reach, or in none at all — and no later
   *  refresh can make that untrue. A page that forgot it would go on to
   *  present half a conversation as the whole of one, which is the failure
   *  the rest of this file exists to avoid. It also changes what a replayed
   *  permission card may claim: with no `answers` to consult, "never
   *  answered" and "answered by somebody else" are indistinguishable, and
   *  the card has to say so. */
  adopted: boolean;
}

/** What survives the session: the half of a conversation the folder never
 *  had. Everything a *live* record carries about a session that is still
 *  there — the ids to attach with, the cwd to judge paths against, the turn
 *  in flight — is gone with it, which is the point: nothing in here names
 *  anything attachable, and nothing in here can be acted on. */
export interface PastRecord {
  /** the fsio session id, which is also the transcript directory's name —
   *  the join between this and what the folder kept. */
  sessionId: string;
  /** which folder that transcript would be in. Only the folder that owned a
   *  conversation gets a say in whether its record is stale. */
  folder: string;
  /** what `initialize` said, so the view can name who was talking even when
   *  the transcript's own paperwork did not survive. */
  agentName: string;
  /** the out-segment generation the live page last counted frames against.
   *  Anchors are positions *within* a generation, so this is what says
   *  whether they line up with the transcript's numbering
   *  (`anchorsAlign`). */
  gen: number;
  /** the human's turns, oldest first — the whole reason this is kept. */
  prompts: StickyPrompt[];
  /** what was clicked, by the agent's request id. Kept for the permission
   *  cards, which can otherwise only ever say "not knowable from here". */
  answers: Record<string, string | null>;
  /** the conversation was joined in progress (#117), so this half starts
   *  where the page did — not where the conversation did. A reader is
   *  looking at a transcript missing a beginning that no browser has. */
  adopted: boolean;
}

/** Session over: keep the half that was only ever here. */
export function demote(rec: StickyRecord): PastRecord {
  return {
    sessionId: rec.sessionId,
    folder: rec.folder,
    agentName: rec.agentName,
    gen: rec.gen,
    prompts: [...rec.prompts],
    answers: { ...rec.answers },
    adopted: rec.adopted,
  };
}

/** Fold answers this record has not seen into it, and say how many landed.
 *
 *  One conversation can be open in more than one window since #120 — the URL
 *  carries it — and each window holds its own copy of this record while both
 *  write through to one key. A plain overwrite loses whichever window's
 *  clicks came second, and what it loses is the human's verdicts on the
 *  agent's consent questions: those rode the uplink, so the folder never had
 *  them and nothing else can supply them (D18, D32 rule 2).
 *
 *  A union is the right merge, and it is sound rather than a best guess: an
 *  answered question is never un-answered, so an id present in one copy and
 *  absent in the other means only that one window saw a click the other did
 *  not. `null` is a real answer — the human cancelled — which is why this
 *  tests for the KEY rather than for a truthy value. Nothing else here
 *  merges: every other field describes the session as its writer sees it,
 *  and a session has one writer at a time (D18/F8). */
export function mergeAnswers(into: Record<string, string | null>, from: Readonly<Record<string, string | null>>): number {
  let added = 0;
  for (const [id, answer] of Object.entries(from)) {
    if (Object.prototype.hasOwnProperty.call(into, id)) continue;
    into[id] = answer;
    added++;
  }
  return added;
}

/** Whether the record's anchors are measured from the same place the
 *  transcript's frames are. A prompt's anchor counts DATA frames from the
 *  start of the segment generation the page was attached to; a transcript's
 *  frames start at the oldest generation the host kept. Same number, same
 *  origin, the turns land where they were typed; different, and they are
 *  somewhere in the right conversation but not the right place in it —
 *  which the view says out loud rather than letting the seam look
 *  deliberate (#57). */
export function anchorsAlign(rec: Pick<PastRecord, "gen">, transcriptGen: number): boolean {
  return rec.gen === transcriptGen;
}

/** How many demoted records this origin keeps: the folder's own bound (D26
 *  rule 4's newest-N), so the browser copy cannot outnumber the transcripts
 *  it annotates. The byte half of that bound is not mirrored — a record is
 *  the human's typing, kilobytes against the transcript's megabytes. */
export const KEEP_PAST = 10;

/** Which demoted records the folder now open has moved past, given what it
 *  kept. `index` is every record this origin holds, tagged with the folder
 *  it came from; `folder` is the one whose transcripts `kept` describes.
 *
 *  Two ways to get this wrong, and both delete the human's own words.
 *
 *  A record whose transcript is absent is not automatically stale: the host
 *  archives at the sweep, which lags the session's end, so "not there yet"
 *  and "never going to be there" look identical for a minute. What tells
 *  them apart is a *newer* transcript — session ids are `s-<ts36>-…`, so
 *  they sort by when the session started. If the folder kept a conversation
 *  that ended after this one and not this one, this one either never made
 *  it or has rotated out of the folder's N, and either way the folder has
 *  spoken. Nothing kept, nothing pruned: an origin whose helper keeps no
 *  transcripts at all holds at most KEEP_PAST records and drops them the
 *  day it does keep one.
 *
 *  And a folder only speaks for itself. One origin can hold conversations
 *  from several folders; opening the second must not be read as a verdict
 *  on the first, whose transcripts are simply not in the directory being
 *  listed. A record from before folders were tagged ("") belongs to nobody
 *  and is therefore never pruned — it ages out by count instead. */
export function prunablePast(index: readonly { id: string; folder: string }[], kept: readonly string[], folder: string): string[] {
  const keep = new Set(kept);
  let newest = "";
  for (const id of kept) if (id > newest) newest = id;
  return index.filter((e) => !!e.folder && e.folder === folder && !keep.has(e.id) && e.id < newest).map((e) => e.id);
}

/** The weave, one frame at a time. About to replay the DATA frame at
 *  `index`, with `cursor` turns already put back: this returns the new
 *  cursor, and everything between the two is what belongs *before* that
 *  frame. A turn anchored at `atFrame = k` was typed when k frames had been
 *  consumed — so it precedes frame k, hence `<=`.
 *
 *  Call it once per replayed frame, then once at the end with
 *  `Number.POSITIVE_INFINITY` to flush the tail: turns taken after the
 *  agent's last word, and — after a rotation left the replay a suffix of
 *  the conversation (#57) — turns whose anchors overshoot it entirely.
 *  Those land at the end, which is wrong in position but not in content;
 *  the page shows the #57 note beside them so the seam is visible rather
 *  than silently plausible. Losing the human's own words is the one outcome
 *  worse than misplacing them. */
export function promptsBefore(prompts: readonly StickyPrompt[], cursor: number, index: number): number {
  let i = Math.max(0, Math.trunc(cursor));
  while (i < prompts.length && prompts[i]!.atFrame <= index) i++;
  return i;
}

/** How a replayed `session/request_permission` should be rendered.
 *
 *  `settled` — the page answered it before it left; show the verdict, and
 *  say nothing on the wire (the agent got its answer and moved on).
 *  `open` — the page never answered. The agent is still blocked on that
 *  request id, which is exactly why replay is worth the trouble: the card
 *  comes back live, and clicking it writes the response the agent has been
 *  waiting for. */
export function permissionVerdict(
  answers: Readonly<Record<string, string | null>>,
  id: string | number | undefined
): { state: "settled"; option: string | null } | { state: "open" } {
  if (id === undefined) return { state: "open" };
  const key = String(id);
  if (!Object.prototype.hasOwnProperty.call(answers, key)) return { state: "open" };
  return { state: "settled", option: answers[key] ?? null };
}

/** A returning page's own JSON-RPC ids must not collide with the ids of the
 *  connection it replaced: the agent may still answer a request the previous
 *  page sent, and that response arrives *live*, on this connection. The
 *  writer epoch (D18) is the host's own monotonic counter for exactly this
 *  succession, so it partitions the id space for free.
 *
 *  Numeric rather than string ids (which JSON-RPC 2.0 would allow, and which
 *  would need no arithmetic) because agents in the wild are the ones who have
 *  to echo them back, and this demo is not the place to discover which of
 *  them assumed a number. */
export const ID_SPACE = 1_000_000;
export function firstIdForEpoch(epoch: number): number {
  return Math.max(0, Math.trunc(epoch)) * ID_SPACE + 1;
}

/** Defensive read of a record that has been sitting in IndexedDB across a
 *  browser upgrade, a schema change of ours, or a half-written write.
 *  Anything unrecognizable is "no record" — which lands the page on the
 *  wizard, the one path that is always correct. */
export function parseRecord(raw: unknown): StickyRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (k: string): string | null => (typeof r[k] === "string" && r[k] ? (r[k] as string) : null);
  const sessionId = str("sessionId");
  const acpSessionId = str("acpSessionId");
  const cwd = str("cwd");
  if (!sessionId || !acpSessionId || !cwd) return null;
  return {
    sessionId,
    acpSessionId,
    cwd,
    agent: str("agent") ?? "",
    agentName: str("agentName") ?? "agent",
    agentVersion: str("agentVersion") ?? "",
    folder: str("folder") ?? "",
    gen: typeof r["gen"] === "number" ? r["gen"] : 0,
    prompts: parsePrompts(r["prompts"]),
    queued: Array.isArray(r["queued"]) ? (r["queued"] as unknown[]).filter((q): q is string => typeof q === "string") : [],
    answers: parseAnswers(r["answers"]),
    pendingPromptId: typeof r["pendingPromptId"] === "number" ? r["pendingPromptId"] : null,
    // Absent in every record written before #117, and the default is the
    // one that cannot mislead: those records were written by the page that
    // started the conversation, so they hold its whole human half.
    adopted: r["adopted"] === true,
  };
}

/** The same defensive read for a record that has been sitting there since
 *  the session ended (#123) — longer, by design, so more of the reasons
 *  above apply. A record with neither turns nor answers is not a record: it
 *  annotates nothing, and the view is better off saying the folder's copy is
 *  all there is. */
export function parsePast(raw: unknown): PastRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const sessionId = typeof r["sessionId"] === "string" ? r["sessionId"] : "";
  if (!sessionId) return null;
  const prompts = parsePrompts(r["prompts"]);
  const answers = parseAnswers(r["answers"]);
  if (!prompts.length && !Object.keys(answers).length) return null;
  return {
    sessionId,
    folder: typeof r["folder"] === "string" ? r["folder"] : "",
    agentName: typeof r["agentName"] === "string" && r["agentName"] ? r["agentName"] : "agent",
    gen: typeof r["gen"] === "number" ? r["gen"] : 0,
    prompts,
    answers,
    adopted: r["adopted"] === true,
  };
}

function parsePrompts(raw: unknown): StickyPrompt[] {
  const prompts: StickyPrompt[] = [];
  if (!Array.isArray(raw)) return prompts;
  for (const p of raw as unknown[]) {
    if (!p || typeof p !== "object") continue;
    const q = p as Record<string, unknown>;
    if (typeof q["text"] !== "string" || typeof q["atFrame"] !== "number") continue;
    prompts.push({ text: q["text"], atFrame: q["atFrame"] });
  }
  return prompts;
}

function parseAnswers(raw: unknown): Record<string, string | null> {
  const answers: Record<string, string | null> = {};
  if (!raw || typeof raw !== "object") return answers;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === null || typeof v === "string") answers[k] = v;
  }
  return answers;
}
