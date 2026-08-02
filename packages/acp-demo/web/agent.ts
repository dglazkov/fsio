// The ACP client role, played by the page (D30 rule 3).
//
// Two of the things an ACP client owes an agent are things only this side
// can do, and together they are the demo:
//
//   `session/request_permission` — the agent asks whether it may act. The
//   page renders the question as UI, next to the file it is about, and the
//   human answers there. Nothing in the terminal, nothing the agent drew
//   itself, no ambient yes. (R6; P5: the party asking is not the party
//   deciding.)
//
//   `fs/read_text_file` / `fs/write_text_file` — the agent asks the *page*
//   to touch a file, and the page serves it through the directory handle
//   the human granted. A path outside the folder is refused here, in the
//   browser, with an error the agent can relay (R9). There is no profile to
//   author for this rung — the browser is the sandbox
//   ([#74](https://github.com/dglazkov/fsio/issues/74)'s rung 2, R8: don't
//   duplicate a wall another party enforces).
//
// Both are the agent's choice to use, and that is the honest caveat: an
// agent that reads files with its own hands is bounded by the Seatbelt
// profile, which is a *write* wall (F24) — it reads the world. Measured in
// the first field test: pi-acp answered "read /etc/passwd" without ever
// calling `fs/read_text_file`, and edited a file without asking. What these
// handlers bound is what the page does **on the agent's behalf**; what the
// profile bounds is what the child may write. Neither one bounds reads, and
// no wording here should suggest otherwise.
//
// ---- coming back (#113/D32)
//
// A refreshed page reattaches to a session that never stopped, and the
// agent never knew. That makes this file the place where two rules live:
//
//   The conversation is rebuilt by re-running these same handlers over the
//   session's replayed history. The agent's words, its tool calls and its
//   questions all come back from the folder (P2); the human's turns come
//   from the sticky record, woven in at the anchors they were sent at
//   (resume.ts).
//
//   A replayed request must not *act*. The downlink carries the agent's
//   `fs/*` calls as well as its words, and re-running a write the human
//   approved an hour ago, against a folder that has moved on, is the worst
//   thing this page could do. So: a request the page already answered is
//   history and gets silence; one it never answered is a request the agent
//   is STILL blocked on, and gets a real answer — the permission card comes
//   back live and clickable, an `fs/*` call comes back refused, because
//   "the page reloaded, ask me again" is honest and rewriting a file on a
//   guess is not.
import { AcpConnection, NO_RESPONSE, type Origin } from "./acp";
import { log } from "./reporter";
import { entries, pastEntries, pushEntry, pushPast, queued, turn, type EntrySink, type PermissionEntry, type TextEntry, type ToolEntry } from "./state";
import { signal } from "@lit-labs/signals";
import { touched } from "./workspace";
import { containedRelative } from "../src/paths.js";
import { permissionVerdict, promptsBefore, type StickyRecord } from "../src/resume.js";
import { currentRecord, updateRecord } from "./store";

/** The protocol version this client speaks. */
const PROTOCOL_VERSION = 1;

interface ContentBlock {
  type?: string;
  text?: string;
  path?: string;
  oldText?: string | null;
  newText?: string;
  content?: ContentBlock;
}

interface ToolCallShape {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  content?: ContentBlock[];
  locations?: { path?: string }[];
  rawInput?: unknown;
}

export interface InitResult {
  agentName: string;
  agentVersion: string;
  authMethods: { id: string; name: string }[];
}

export class AgentSession {
  readonly conn: AcpConnection;
  #root: FileSystemDirectoryHandle;
  #cwd: string;
  #sessionId: string | null = null;
  #tools = new Map<string, ToolEntry>();
  #streaming: TextEntry | null = null;
  /** how many of the record's prompts have been woven back in. */
  #promptCursor = 0;

  /** true when this session is a *document*: an ended conversation read
   *  back from `.fsio/transcripts/` (#119). Same handlers, same rendering,
   *  three differences — no wire (the connection has no session), no turns
   *  of the human's to weave (they rode the uplink and the record died with
   *  the session), and nothing that could act. */
  #history: boolean;
  /** Which conversation this session's output belongs to. A property of the
   *  session, not of the moment: the live agent may well be mid-turn while
   *  someone is reading a past conversation, and its words belong in the
   *  live log either way. */
  #push: EntrySink;

  /** `resume` is the record of a session this page is coming back to; null
   *  for one it is starting. Everything a returning page needs before the
   *  attach even completes is in it — the ACP session id, the agent's cwd,
   *  and the id of a turn that was in flight — because replayed frames
   *  start arriving before `ready` resolves. */
  constructor(conn: AcpConnection, root: FileSystemDirectoryHandle, cwd: string, resume: StickyRecord | null = null, history = false) {
    this.conn = conn;
    this.#root = root;
    this.#cwd = cwd.replace(/\/+$/, "");
    this.#history = history;
    this.#push = history ? pushPast : pushEntry;

    conn.onNotification("session/update", (params, origin) => this.#update(params, origin));
    conn.onRequest("session/request_permission", (params, origin) => this.#permission(params, origin));
    conn.onRequest("fs/read_text_file", (params, origin) => this.#readTextFile(params, origin));
    conn.onRequest("fs/write_text_file", (params, origin) => this.#writeTextFile(params, origin));

    if (!resume) return;
    this.#sessionId = resume.acpSessionId;
    // Adopted here, not at the end of replay: a turn that finished while the
    // page was away answered into the history, so the id has to be claimed
    // before the first replayed frame is delivered or the reply is dropped
    // as an unknown id and the turn spins forever.
    if (resume.pendingPromptId !== null) {
      turn.set("thinking");
      void this.#finishAdoptedTurn(resume.pendingPromptId);
    }
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  /** initialize + session/new. Capabilities are a promise: only claim the
   *  `fs` methods because they are implemented below.
   *
   *  There is deliberately no reattach counterpart to this (D32). The
   *  handshake belongs to the agent *process*, and a refresh does not
   *  restart it — the agent has been talking to the same stdio pipe the
   *  whole time and never saw a disconnect. A second `initialize` is
   *  undefined territory, `session/new` would silently start a second
   *  conversation, and `session/load` is for resuming into an agent that
   *  did die. A returning page just keeps using the session id it had. */
  async start(): Promise<InitResult> {
    const init = (await this.conn.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    })) as {
      agentInfo?: { name?: string; version?: string };
      authMethods?: { id: string; name: string }[];
    };
    const created = (await this.conn.request("session/new", { cwd: this.#cwd, mcpServers: [] })) as { sessionId?: string };
    this.#sessionId = created.sessionId ?? null;
    if (!this.#sessionId) throw new Error("agent returned no sessionId");
    return {
      agentName: init.agentInfo?.name ?? "agent",
      agentVersion: init.agentInfo?.version ?? "",
      authMethods: init.authMethods ?? [],
    };
  }

  // ------------------------------------------------------------- replay

  /** The library's replay bracket (D18), forwarded by the connection. */
  onReplay(replaying: boolean, gen: number): void {
    const rec = currentRecord();
    if (replaying) {
      // Replay is head-segment-only (D26): a generation higher than the one
      // this page left behind means older frames rotated away and what comes
      // back is a suffix. Say it in the transcript, at the top, where the
      // missing part would have been (#57).
      if (rec && gen !== rec.gen) {
        this.#push({
          kind: "note",
          text: "the earlier part of this conversation has rotated out of the session's retained stream and cannot be shown — what follows is the tail.",
        });
      }
      updateRecord((r) => {
        r.gen = gen;
      });
      return;
    }
    // Live again. Anything anchored past the last replayed frame is a turn
    // taken after the agent's last word (or one whose anchor overshot a
    // rotated stream) — it goes here, at the end.
    this.#weavePrompts(Number.POSITIVE_INFINITY);
    this.#streaming = null;
    if (rec?.queued.length) queued.set([...rec.queued]);
  }

  /** Called once per incoming DATA frame, before it is dispatched. */
  onFrame(index: number, replayed: boolean): void {
    if (replayed) this.#weavePrompts(index);
  }

  #weavePrompts(upTo: number): void {
    // A past conversation has no human half to weave: the record that
    // carried it died with the session it described. Reading the *live*
    // record here would splice the current conversation's prompts into a
    // document about a different one (#119).
    if (this.#history) return;
    const rec = currentRecord();
    if (!rec) return;
    const next = promptsBefore(rec.prompts, this.#promptCursor, upTo);
    for (let i = this.#promptCursor; i < next; i++) {
      this.#streaming = null;
      this.#push({ kind: "user", text: rec.prompts[i]!.text });
    }
    this.#promptCursor = next;
  }

  /** A `session/prompt` the previous page sent and never heard back about.
   *  The agent answers to that id whenever it finishes — during replay if it
   *  finished while the page was away, live if it is still working. */
  async #finishAdoptedTurn(id: number): Promise<void> {
    try {
      const r = (await this.conn.adopt(id)) as { stopReason?: string };
      if (r.stopReason && r.stopReason !== "end_turn") this.#push({ kind: "note", text: `turn ended: ${r.stopReason}` });
    } catch (e) {
      this.#push({ kind: "error", text: `the turn that was running when this page reloaded ended: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      this.#endTurn();
    }
  }

  // ------------------------------------------------------------- prompting

  async prompt(text: string): Promise<void> {
    if (!this.#sessionId) throw new Error("no ACP session");
    this.#push({ kind: "user", text });
    this.#streaming = null;
    turn.set("thinking");
    // Anchored *before* the send: the position is "how much of the agent's
    // stream this turn had seen when it was typed", which is what puts it
    // back between the right two things on the way home.
    const atFrame = this.conn.frameIndex;
    const sent = this.conn.requestTracked<{ stopReason?: string }>("session/prompt", {
      sessionId: this.#sessionId,
      prompt: [{ type: "text", text }],
    });
    updateRecord((r) => {
      r.prompts.push({ text, atFrame });
      r.pendingPromptId = sent.id;
    });
    try {
      const r = await sent.result;
      if (r.stopReason && r.stopReason !== "end_turn") this.#push({ kind: "note", text: `turn ended: ${r.stopReason}` });
    } catch (e) {
      // A turn that failed because the session ended has already been
      // narrated by whoever ended it (the agent's exit, or the human's "end
      // session"). Only a failure inside a live session is news here.
      if (turn.get() !== "gone") this.#push({ kind: "error", text: `prompt failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      this.#endTurn();
    }
  }

  #endTurn(): void {
    this.#streaming = null;
    updateRecord((r) => {
      r.pendingPromptId = null;
    });
    turn.set(turn.get() === "gone" ? "gone" : "idle");
  }

  cancel(): void {
    if (!this.#sessionId) return;
    turn.set("cancelling");
    this.conn.notify("session/cancel", { sessionId: this.#sessionId });
  }

  // -------------------------------------------------------------- updates

  #update(params: Record<string, unknown> | undefined, origin: Origin): void {
    const u = (params?.["update"] ?? {}) as Record<string, unknown>;
    const type = String(u["sessionUpdate"] ?? "");
    switch (type) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const kind = type === "agent_message_chunk" ? "agent" : "thought";
        const text = blockText(u["content"] as ContentBlock);
        if (!text) return;
        if (!this.#streaming || this.#streaming.kind !== kind) {
          this.#streaming = this.#push({ kind, text: signal(text) }) as TextEntry;
        } else {
          this.#streaming.text.set(this.#streaming.text.get() + text);
        }
        return;
      }
      case "tool_call": {
        this.#streaming = null;
        const tc = u as ToolCallShape;
        const id = tc.toolCallId ?? `t-${Math.random().toString(36).slice(2)}`;
        const entry = this.#push({
          kind: "tool",
          toolCallId: id,
          title: signal(tc.title ?? "tool call"),
          status: signal(tc.status ?? "pending"),
          locations: signal(locationPaths(tc)),
          detail: signal(contentSummary(tc.content)),
        }) as ToolEntry;
        this.#tools.set(id, entry);
        return;
      }
      case "tool_call_update": {
        const tc = u as ToolCallShape;
        const entry = tc.toolCallId ? this.#tools.get(tc.toolCallId) : undefined;
        if (!entry) return;
        if (tc.status) entry.status.set(tc.status);
        if (tc.title) entry.title.set(tc.title);
        const locs = locationPaths(tc);
        if (locs.length) entry.locations.set(locs);
        const detail = contentSummary(tc.content);
        if (detail) entry.detail.set(detail);
        // A finished edit is a file that just changed — nudge the workspace
        // pane rather than waiting for its next poll. Not while replaying:
        // that edit landed before this page existed, and the pane's first
        // scan already has it.
        if (tc.status === "completed" && !origin.replayed) void touched();
        return;
      }
      case "plan": {
        const items = (u["entries"] as { content?: string; status?: string }[] | undefined) ?? [];
        if (!items.length) return;
        this.#streaming = null;
        this.#push({ kind: "note", text: "plan: " + items.map((i) => `${i.status === "completed" ? "✓" : "•"} ${i.content ?? ""}`).join("  ") });
        return;
      }
      default:
        return; // available_commands_update, current_mode_update, … — not this demo's business
    }
  }

  // ---------------------------------------------------------- permission

  #permission(params: Record<string, unknown> | undefined, origin: Origin): Promise<unknown> | typeof NO_RESPONSE {
    const tc = (params?.["toolCall"] ?? {}) as ToolCallShape;
    const options = ((params?.["options"] as { optionId?: string; name?: string; kind?: string }[] | undefined) ?? [])
      .filter((o) => o.optionId)
      .map((o) => ({ optionId: o.optionId!, name: o.name ?? o.optionId!, ...(o.kind ? { kind: o.kind } : {}) }));
    this.#streaming = null;
    const card = {
      kind: "permission" as const,
      id: tc.toolCallId ?? `p-${Math.random().toString(36).slice(2)}`,
      title: tc.title ?? "the agent wants to do something",
      toolKind: tc.kind ?? "other",
      locations: locationPaths(tc),
      detail: contentSummary(tc.content),
      options,
    };

    // From a transcript (#119): the question is in the folder, the answer
    // never was. Show what was asked, mark it historic, and let the card
    // say that the verdict is not knowable from here — the alternative is
    // inferring it from what the agent did next, which D32 already refused
    // as a guess dressed as a fact.
    if (this.#history) {
      this.#push({ ...card, answer: signal<string | null>(null), respond: null, historic: true });
      return NO_RESPONSE;
    }

    // A question this page already settled: it is transcript now. Render the
    // verdict, say nothing on the wire — the agent read the answer long ago
    // and has moved on.
    const verdict = origin.replayed ? permissionVerdict(currentRecord()?.answers ?? {}, origin.id) : ({ state: "open" } as const);
    if (verdict.state === "settled") {
      this.#push({ ...card, answer: signal<string | null>(verdict.option ?? "(cancelled)"), respond: null });
      return NO_RESPONSE;
    }

    // Open — including on replay, and that case is the whole argument for
    // replaying at all: the agent is still parked on this request id, so
    // the card comes back clickable and answering it writes the response it
    // has been waiting for since before the refresh.
    log(`permission ${origin.replayed ? "still open from before the refresh" : "requested"}: ${tc.title ?? "(untitled)"} [${options.map((o) => o.optionId).join(", ")}]`);
    if (origin.replayed) {
      this.#push({ kind: "note", text: "this question was still waiting when the page reloaded — the agent is holding for an answer." });
    }
    return new Promise((resolve) => {
      const entry = this.#push({
        ...card,
        answer: signal<string | null>(null),
        respond: (optionId: string | null) => {
          if (entry.answer.get() !== null) return;
          entry.answer.set(optionId ?? "(cancelled)");
          entry.respond = null;
          entries.set([...entries.get()]); // the card's buttons become a verdict
          log(`permission answered: ${optionId ?? "cancelled"}`);
          // Written down before the response goes out: a card answered but
          // not remembered would be asked again on the next visit, which is
          // the failure this record exists to prevent.
          if (origin.id !== undefined) {
            updateRecord((r) => {
              r.answers[String(origin.id)] = optionId;
            });
          }
          resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
        },
      }) as PermissionEntry;
    });
  }

  // ------------------------------------------------------------- fs/*

  /** Replayed `fs/*`: history, or an unanswered request the agent is still
   *  blocked on. Neither one may re-run the call.
   *
   *  History is silent — the file operation happened, its response was read,
   *  and the only trace it leaves is in the log. An unanswered one gets a
   *  refusal rather than a second attempt: this page cannot prove its
   *  predecessor's answer never landed, and the folder has moved on since
   *  the request was made. An error unblocks the agent and lets it ask
   *  again against the folder as it is now; a write on a guess is
   *  unrecoverable. Returns `NO_RESPONSE` for the silent case, throws for
   *  the refusal, and null when the call is live and should just happen. */
  #replayGuard(method: string, path: string, origin: Origin): typeof NO_RESPONSE | null {
    // A transcript (#119). This call was served — or refused — by a page
    // that is gone, against a folder that has moved on, on behalf of an
    // agent that has exited. Every branch below is about answering someone;
    // there is nobody to answer. Render the fact and stop.
    if (this.#history) {
      this.#push({
        kind: "note",
        text: `the agent asked the page to ${method === "fs/write_text_file" ? "write" : "read"} ${path}${path ? "" : "(no path)"} — served then, not now.`,
      });
      return NO_RESPONSE;
    }
    if (!origin.replayed) return null;
    if (origin.id !== undefined && Object.prototype.hasOwnProperty.call(currentRecord()?.answers ?? {}, String(origin.id))) {
      log(`${method} ${path} — replayed, already served before the reload`);
      return NO_RESPONSE;
    }
    log(`${method} ${path} — outstanding since the reload; refusing rather than repeating it`);
    this.#push({
      kind: "note",
      text: `the agent asked to ${method === "fs/write_text_file" ? "write" : "read"} ${path} while this page was away — it was told to ask again rather than have it done blind.`,
    });
    throw { code: -32603, message: "the page that received this request reloaded; nothing was done. Send it again." };
  }

  #remember(origin: Origin): void {
    if (origin.id === undefined) return;
    updateRecord((r) => {
      r.answers[String(origin.id)] = "fs";
    });
  }

  async #readTextFile(params: Record<string, unknown> | undefined, origin: Origin): Promise<{ content: string } | typeof NO_RESPONSE> {
    // Guarded before containment: a replayed request must not produce a
    // second answer of any kind, refusal included.
    const guarded = this.#replayGuard("fs/read_text_file", String(params?.["path"] ?? ""), origin);
    if (guarded) return guarded;
    const rel = this.#contain(String(params?.["path"] ?? ""));
    const file = await this.#file(rel, false);
    let text = await (await file.getFile()).text();
    const line = params?.["line"] as number | undefined;
    const limit = params?.["limit"] as number | undefined;
    if (line !== undefined || limit !== undefined) {
      const lines = text.split("\n");
      const from = Math.max(0, (line ?? 1) - 1);
      text = lines.slice(from, limit === undefined ? undefined : from + limit).join("\n");
    }
    log(`fs/read_text_file ${rel} (${text.length} chars) — served from the page's handle`);
    this.#remember(origin);
    return { content: text };
  }

  async #writeTextFile(params: Record<string, unknown> | undefined, origin: Origin): Promise<null | typeof NO_RESPONSE> {
    const guarded = this.#replayGuard("fs/write_text_file", String(params?.["path"] ?? ""), origin);
    if (guarded) return guarded;
    const rel = this.#contain(String(params?.["path"] ?? ""));
    const content = String(params?.["content"] ?? "");
    const file = await this.#file(rel, true);
    const w = await file.createWritable();
    await w.write(new TextEncoder().encode(content) as Uint8Array<ArrayBuffer>);
    await w.close();
    log(`fs/write_text_file ${rel} (${content.length} chars) — written through the page's grant`);
    this.#remember(origin);
    void touched();
    return null;
  }

  /** Absolute path → path relative to the granted folder, or a refusal.
   *  The rule and its tests live in `../src/paths.ts` (Node-testable);
   *  here it becomes a JSON-RPC error the agent can relay (R9). */
  #contain(abs: string): string {
    const r = containedRelative(this.#cwd, abs);
    if (!r.ok) {
      log(`refused ${abs}: ${r.reason}`);
      throw { code: -32602, message: r.reason };
    }
    return r.rel;
  }

  async #file(rel: string, create: boolean): Promise<FileSystemFileHandle> {
    const parts = rel.split("/").filter((p) => p.length > 0);
    const name = parts.pop();
    if (!name) throw { code: -32602, message: "refused: that path names a directory, not a file" };
    let dir = this.#root;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
    return dir.getFileHandle(name, { create });
  }
}

function blockText(block: ContentBlock | undefined): string {
  if (!block) return "";
  if (typeof block.text === "string") return block.text;
  if (block.content) return blockText(block.content);
  return "";
}

function locationPaths(tc: ToolCallShape): string[] {
  return (tc.locations ?? []).map((l) => l.path ?? "").filter((p) => p.length > 0);
}

/** One line of what a tool call is about — enough for a human to judge the
 *  permission question without expanding anything. */
function contentSummary(content: ContentBlock[] | undefined): string {
  if (!content?.length) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (c.type === "diff" && c.path) {
      const added = (c.newText ?? "").split("\n").length;
      const removed = (c.oldText ?? "").split("\n").length;
      parts.push(`diff ${c.path} (+${added}/−${removed} lines)`);
    } else {
      const t = blockText(c).trim();
      if (t) parts.push(t.length > 400 ? t.slice(0, 400) + "…" : t);
    }
  }
  return parts.join("\n");
}
