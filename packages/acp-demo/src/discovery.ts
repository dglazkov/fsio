// Finding a running conversation the page has no record of (#117): the
// pure half.
//
// Sticky sessions (D32) made the browser's IndexedDB record the only route
// back to a live agent. That is one route too few. The record is a
// *shortcut* — it names the session so the page can skip straight to it —
// but the folder is the **index**, and it always was: `listSessions()` is
// D18 discovery, and the terminal demo has picked sessions out of it since
// [#58](https://github.com/dglazkov/fsio/issues/58). A page whose record is
// missing, stale, or simply somebody else's (a second browser profile, an
// incognito window, localhost against the deployed page — separate
// IndexedDB by design) can still see every running session in the folder it
// was granted, and should say so rather than starting a second conversation
// on top of one.
//
// What a picker needs beyond the id, and where each piece comes from:
//
//   which agent      `spawn.json` — the request the *page* sent, copied
//                    beside the session by the host.
//   when it started  the session id. `s-<ts36>-<rand>` (client/index.ts),
//                    so the id carries its own birthday and no file has to
//                    be read for it.
//   is it detached   `status.json`, via `listSessions()` (D17's marking).
//   what it was      the out log. The agent's half of the conversation rode
//   just saying      the folder (P2), so the folder can be asked what the
//                    last thing said was — the same bytes the page would
//                    replay, read for one line instead of a transcript.
//   the ACP id       the out log again, and this is the load-bearing one:
//                    `session/new`'s reply and every `session/update` carry
//                    it, and without it a rejoined page can watch but never
//                    speak. #115 recovered one by hand, from this same file,
//                    in DevTools. This is that grep, written down.
//
// Pure so it can be tested in Node (test-discovery.ts); the parts that need
// a directory handle live in web/discovery.ts.
import { FrameType, parseFrames } from "@fsio/common";

/** A session id is `s-<epoch-ms in base 36>-<random>` — minted in
 *  `FsioClient.createSession()`, which is why the picker can date a session
 *  without opening anything. Anything else in the sessions directory was not
 *  minted by this library and gets no birthday. */
const SESSION_ID_RE = /^s-([0-9a-z]+)-[0-9a-z]+$/;

/** Plausible epoch-ms window for a decoded id: 2001-09 to 2286-11. A
 *  co-tenant of the folder can name a directory anything (D20), so a number
 *  that decodes to the year 400 is a coincidence, not a timestamp. */
const MIN_TS = 1e12;
const MAX_TS = 1e13;

/** When a session was created, from its id alone, or null if the id was not
 *  minted by this library. */
export function startedAt(id: string): number | null {
  const m = SESSION_ID_RE.exec(id);
  if (!m) return null;
  const ms = parseInt(m[1]!, 36);
  return Number.isFinite(ms) && ms >= MIN_TS && ms < MAX_TS ? ms : null;
}

/** "started 28 minutes ago" — the half of that sentence that varies. Takes
 *  `now` rather than reading the clock so it is testable, and rounds down
 *  because "an hour ago" reading as 59 minutes is the harmless direction. */
export function sinceLabel(started: number | null, now: number): string {
  if (started === null) return "start time unknown";
  const s = Math.max(0, Math.round((now - started) / 1000));
  if (s < 45) return "started just now";
  const plural = (n: number, unit: string): string => `started ${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (s < 5400) return plural(Math.max(1, Math.round(s / 60)), "minute");
  if (s < 172800) return plural(Math.round(s / 3600), "hour");
  return plural(Math.round(s / 86400), "day");
}

/** One row of `listSessions()`, as much of it as the filter needs. Structural
 *  rather than the imported `SessionSummary` so this file stays testable
 *  without a client. */
export interface SessionRow {
  id: string;
  kind: string | null;
  status: { state?: string } | null;
}

/** The sessions in this folder that this page could rejoin: ACP, running,
 *  and not already held by this page. Newest first — ids sort by start time,
 *  which is the order a picker wants and costs no second read.
 *
 *  `exclude` is what the page is already driving *or* has deliberately
 *  walked away from ("leave it running and start a new one" — offering that
 *  session back one keystroke later would be a loop, not a recovery). */
export function adoptableIds(rows: readonly SessionRow[], exclude: ReadonlySet<string>): string[] {
  return rows
    .filter((r) => r.kind === "acp" && r.status?.state === "running" && !exclude.has(r.id))
    .map((r) => r.id)
    .sort()
    .reverse();
}

/** What the folder can tell a picker about a conversation nothing here has
 *  a record of. Every field is optional in practice: this is read out of a
 *  file in the granted folder, which any co-tenant can write (D20), so it is
 *  parsed like a stranger wrote it and rendered as text. */
export interface Peek {
  /** the agent's own conversation id — what `session/prompt` must carry.
   *  Null means the folder no longer holds a frame that names it, and the
   *  session can be seen but not rejoined. */
  acpSessionId: string | null;
  /** what `initialize` answered, if that exchange is still in the retained
   *  stream. "" once it has rotated away. */
  agentName: string;
  agentVersion: string;
  /** the last thing the agent said, one line of it — enough to choose by. */
  lastLine: string;
  /** DATA frames seen, so a caller can tell "nothing yet" from "unreadable". */
  frames: number;
}

/** How much of a streaming message to keep while scanning. The tail is all
 *  `lastLine` can use, and an agent mid-essay must not cost the picker a
 *  megabyte of string concatenation. */
const RUN_CAP = 4096;
/** One line, and a line is a glance. */
const LINE_CAP = 160;

/** Read a session's retained out segments for the things a picker needs.
 *  `segments` are the raw bytes, oldest first — the same frames replay would
 *  deliver, walked once for their metadata instead of rendered.
 *
 *  A trailing partial frame is normal (the host is appending as this reads,
 *  invariant 3/F11) and `parseFrames` stops before it. A payload that is not
 *  JSON, or JSON that is not a message, is skipped: the picker's job is to
 *  find what it recognizes, never to judge the rest. */
export function peekConversation(segments: readonly Uint8Array[]): Peek {
  let acpSessionId: string | null = null;
  let agentName = "";
  let agentVersion = "";
  let frames = 0;
  // The agent's current streaming run, and the last tool call it announced.
  // `run` is cleared by any other kind of update, which is exactly what the
  // chat's own renderer does — so the line this produces is the line the
  // page would have been showing.
  let run = "";
  let lastTool = "";
  for (const bytes of segments) {
    for (const f of parseFrames(bytes).frames) {
      if (f.type !== FrameType.DATA) continue; // fsio's control plane, not the agent's words
      frames++;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(new TextDecoder().decode(f.payload)) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!msg || typeof msg !== "object") continue;

      // A response: `initialize` names the agent, `session/new` names the
      // conversation. Both are the first two frames of a session, so both
      // are gone once the head has rotated (D26) — hence the notification
      // path below, which never rotates out of a conversation still going.
      const result = msg["result"];
      if (result && typeof result === "object") {
        const r = result as Record<string, unknown>;
        if (typeof r["sessionId"] === "string" && r["sessionId"]) acpSessionId = r["sessionId"];
        const info = r["agentInfo"];
        if (info && typeof info === "object") {
          const i = info as Record<string, unknown>;
          if (typeof i["name"] === "string") agentName = i["name"];
          if (typeof i["version"] === "string") agentVersion = i["version"];
        }
      }

      if (msg["method"] !== "session/update") continue;
      const params = (msg["params"] ?? {}) as Record<string, unknown>;
      if (typeof params["sessionId"] === "string" && params["sessionId"]) acpSessionId = params["sessionId"];
      const u = (params["update"] ?? {}) as Record<string, unknown>;
      switch (String(u["sessionUpdate"] ?? "")) {
        case "agent_message_chunk": {
          run = (run + blockText(u["content"])).slice(-RUN_CAP);
          break;
        }
        case "tool_call":
        case "tool_call_update": {
          const title = u["title"];
          if (typeof title === "string" && title) lastTool = title;
          run = "";
          break;
        }
        default:
          // A thought, a plan, a mode change: not the agent's last word, but
          // it does end the run that was streaming.
          run = "";
      }
    }
  }
  return { acpSessionId, agentName, agentVersion, lastLine: lastLine(run) || truncate(lastTool), frames };
}

/** ACP content blocks nest; the text is wherever it is. Deliberately the
 *  same shape web/agent.ts reads, minus the parts only a renderer needs. */
function blockText(block: unknown): string {
  if (!block || typeof block !== "object") return "";
  const b = block as Record<string, unknown>;
  if (typeof b["text"] === "string") return b["text"];
  if (b["content"]) return blockText(b["content"]);
  return "";
}

function lastLine(run: string): string {
  const lines = run.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.replace(/\s+/g, " ").trim();
    if (t) return truncate(t);
  }
  return "";
}

const truncate = (s: string): string => (s.length > LINE_CAP ? s.slice(0, LINE_CAP - 1) + "…" : s);
