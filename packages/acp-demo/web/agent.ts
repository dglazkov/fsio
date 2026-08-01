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
//   the human granted. The grant is the boundary: a path outside the folder
//   is refused here, in the browser, with an error the agent can relay
//   (R9). There is no profile to author for this rung — the browser is the
//   sandbox ([#74](https://github.com/dglazkov/fsio/issues/74)'s rung 2,
//   R8: don't duplicate a wall another party enforces).
import { AcpConnection } from "./acp";
import { log } from "./reporter";
import { entries, pushEntry, turn, type PermissionEntry, type TextEntry, type ToolEntry } from "./state";
import { signal } from "@lit-labs/signals";
import { touched } from "./workspace";
import { containedRelative } from "../src/paths.js";

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
  authRequired: boolean;
}

export class AgentSession {
  readonly conn: AcpConnection;
  #root: FileSystemDirectoryHandle;
  #cwd: string;
  #sessionId: string | null = null;
  #tools = new Map<string, ToolEntry>();
  #streaming: TextEntry | null = null;

  constructor(conn: AcpConnection, root: FileSystemDirectoryHandle, cwd: string) {
    this.conn = conn;
    this.#root = root;
    this.#cwd = cwd.replace(/\/+$/, "");

    conn.onNotification("session/update", (params) => this.#update(params));
    conn.onRequest("session/request_permission", (params) => this.#permission(params));
    conn.onRequest("fs/read_text_file", (params) => this.#readTextFile(params));
    conn.onRequest("fs/write_text_file", (params) => this.#writeTextFile(params));
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  /** initialize + session/new. Capabilities are a promise: only claim the
   *  `fs` methods because they are implemented below. */
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
      authRequired: false,
    };
  }

  async prompt(text: string): Promise<void> {
    if (!this.#sessionId) throw new Error("no ACP session");
    pushEntry({ kind: "user", text });
    this.#streaming = null;
    turn.set("thinking");
    try {
      const r = (await this.conn.request("session/prompt", {
        sessionId: this.#sessionId,
        prompt: [{ type: "text", text }],
      })) as { stopReason?: string };
      if (r.stopReason && r.stopReason !== "end_turn") pushEntry({ kind: "note", text: `turn ended: ${r.stopReason}` });
    } catch (e) {
      pushEntry({ kind: "error", text: `prompt failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      this.#streaming = null;
      turn.set(turn.get() === "gone" ? "gone" : "idle");
    }
  }

  cancel(): void {
    if (!this.#sessionId) return;
    turn.set("cancelling");
    this.conn.notify("session/cancel", { sessionId: this.#sessionId });
  }

  // -------------------------------------------------------------- updates

  #update(params: Record<string, unknown> | undefined): void {
    const u = (params?.["update"] ?? {}) as Record<string, unknown>;
    const type = String(u["sessionUpdate"] ?? "");
    switch (type) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const kind = type === "agent_message_chunk" ? "agent" : "thought";
        const text = blockText(u["content"] as ContentBlock);
        if (!text) return;
        if (!this.#streaming || this.#streaming.kind !== kind) {
          this.#streaming = pushEntry({ kind, text: signal(text) }) as TextEntry;
        } else {
          this.#streaming.text.set(this.#streaming.text.get() + text);
        }
        return;
      }
      case "tool_call": {
        this.#streaming = null;
        const tc = u as ToolCallShape;
        const id = tc.toolCallId ?? `t-${Math.random().toString(36).slice(2)}`;
        const entry = pushEntry({
          kind: "tool",
          toolCallId: id,
          title: signal(tc.title ?? "tool call"),
          status: signal(tc.status ?? "pending"),
          toolKind: tc.kind ?? "other",
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
        // pane rather than waiting for its next poll.
        if (tc.status === "completed") void touched();
        return;
      }
      case "plan": {
        const items = (u["entries"] as { content?: string; status?: string }[] | undefined) ?? [];
        if (!items.length) return;
        this.#streaming = null;
        pushEntry({ kind: "note", text: "plan: " + items.map((i) => `${i.status === "completed" ? "✓" : "•"} ${i.content ?? ""}`).join("  ") });
        return;
      }
      default:
        return; // available_commands_update, current_mode_update, … — not this demo's business
    }
  }

  // ---------------------------------------------------------- permission

  #permission(params: Record<string, unknown> | undefined): Promise<unknown> {
    const tc = (params?.["toolCall"] ?? {}) as ToolCallShape;
    const options = ((params?.["options"] as { optionId?: string; name?: string; kind?: string }[] | undefined) ?? [])
      .filter((o) => o.optionId)
      .map((o) => ({ optionId: o.optionId!, name: o.name ?? o.optionId!, ...(o.kind ? { kind: o.kind } : {}) }));
    this.#streaming = null;
    log(`permission requested: ${tc.title ?? "(untitled)"} [${options.map((o) => o.optionId).join(", ")}]`);

    return new Promise((resolve) => {
      const entry = pushEntry({
        kind: "permission",
        id: tc.toolCallId ?? `p-${Math.random().toString(36).slice(2)}`,
        title: tc.title ?? "the agent wants to do something",
        toolKind: tc.kind ?? "other",
        locations: locationPaths(tc),
        detail: contentSummary(tc.content),
        options,
        answer: signal<string | null>(null),
        respond: (optionId: string | null) => {
          if (entry.answer.get() !== null) return;
          entry.answer.set(optionId ?? "(cancelled)");
          entry.respond = null;
          entries.set([...entries.get()]); // the card's buttons become a verdict
          log(`permission answered: ${optionId ?? "cancelled"}`);
          resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
        },
      }) as PermissionEntry;
    });
  }

  // ------------------------------------------------------------- fs/*

  async #readTextFile(params: Record<string, unknown> | undefined): Promise<{ content: string }> {
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
    return { content: text };
  }

  async #writeTextFile(params: Record<string, unknown> | undefined): Promise<null> {
    const rel = this.#contain(String(params?.["path"] ?? ""));
    const content = String(params?.["content"] ?? "");
    const file = await this.#file(rel, true);
    const w = await file.createWritable();
    await w.write(new TextEncoder().encode(content) as Uint8Array<ArrayBuffer>);
    await w.close();
    log(`fs/write_text_file ${rel} (${content.length} chars) — written through the page's grant`);
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
