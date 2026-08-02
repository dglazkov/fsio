// Sticky sessions (#113): what the page must carry across a refresh, and
// the two rules for putting a conversation back together.
//
// The shape of the problem. Three lifetimes are involved and only the
// middle one changed with #113 (D32): the folder grant lives in Chrome,
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
   *  a reattached page does not re-handshake (D32). */
  acpSessionId: string;
  /** roster name of the agent that was chosen (#102), for the record's own
   *  display and for the fallback when the session turns out to be gone. */
  agent: string;
  /** what `initialize` said. Persisted because there is no second
   *  `initialize` to ask again (D32). */
  agentName: string;
  agentVersion: string;
  /** the agent's cwd, from `acp/info`. Needed before `ready` resolves,
   *  because replayed frames arrive first and `fs/*` containment is judged
   *  against it. */
  cwd: string;
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
  const prompts: StickyPrompt[] = [];
  if (Array.isArray(r["prompts"])) {
    for (const p of r["prompts"] as unknown[]) {
      if (!p || typeof p !== "object") continue;
      const q = p as Record<string, unknown>;
      if (typeof q["text"] !== "string" || typeof q["atFrame"] !== "number") continue;
      prompts.push({ text: q["text"], atFrame: q["atFrame"] });
    }
  }
  const answers: Record<string, string | null> = {};
  if (r["answers"] && typeof r["answers"] === "object") {
    for (const [k, v] of Object.entries(r["answers"] as Record<string, unknown>)) {
      if (v === null || typeof v === "string") answers[k] = v;
    }
  }
  return {
    sessionId,
    acpSessionId,
    cwd,
    agent: str("agent") ?? "",
    agentName: str("agentName") ?? "agent",
    agentVersion: str("agentVersion") ?? "",
    gen: typeof r["gen"] === "number" ? r["gen"] : 0,
    prompts,
    queued: Array.isArray(r["queued"]) ? (r["queued"] as unknown[]).filter((q): q is string => typeof q === "string") : [],
    answers,
    pendingPromptId: typeof r["pendingPromptId"] === "number" ? r["pendingPromptId"] : null,
  };
}
