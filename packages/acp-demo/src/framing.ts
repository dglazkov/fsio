// Framing: the seam between two JSON-RPC layers that must never be confused.
//
// fsio's own RPC (D10) is *transport control* — spawn, ping, ack, close —
// and rides RPC frames. ACP is *payload* and rides DATA frames. The rule
// this file enforces, in both directions, is one sentence:
//
//   **one DATA frame carries exactly one complete ACP message.**
//
// The agent speaks newline-delimited JSON on a pipe, where message
// boundaries are a property of the byte stream; DATA frames chunk on
// whatever boundary the transport felt like. Doing the reassembly here, in
// the host, means the browser never owns a buffer and can never see half a
// message — which is what makes the layering safe to reason about. It also
// means the malformed-input handling lives in one place instead of in UI
// code.
//
// Junk on stdout is expected in the wild (version notices, npm chatter) and
// must not reach the page's parser: a line that is not a JSON *object* is
// diverted to diagnostics, never delivered.

/** A single line longer than this is a runaway, not a message. NDJSON has
 *  no other resync point, so the partial line is dropped and the stream
 *  picks up at the next newline. Sized well above any real ACP message and
 *  well below the 4 MiB-window caveat's neighborhood (#10: kinds have no
 *  backpressure hook — don't pipe file dumps through one). */
export const MAX_LINE_BYTES = 1 << 20;

export interface SplitterEvents {
  /** one complete line, `\n` (and any `\r`) stripped. */
  line: (text: string) => void;
  /** a line exceeded MAX_LINE_BYTES and was dropped. */
  overflow: (bytes: number) => void;
}

/** Newline-delimited reassembly over arbitrarily chunked pipe reads. */
export class LineSplitter {
  #parts: Buffer[] = [];
  #len = 0;
  #dropping = false;

  constructor(
    private readonly ev: SplitterEvents,
    private readonly max: number = MAX_LINE_BYTES
  ) {}

  push(chunk: Buffer): void {
    let rest = chunk;
    for (;;) {
      const nl = rest.indexOf(0x0a);
      if (nl < 0) break;
      const head = rest.subarray(0, nl);
      rest = rest.subarray(nl + 1);
      if (this.#dropping) {
        // tail of an over-long line: discard through the newline and resync
        this.#dropping = false;
        this.#reset();
        continue;
      }
      this.#parts.push(head);
      this.#len += head.length;
      const text = Buffer.concat(this.#parts, this.#len).toString("utf8");
      this.#reset();
      const trimmed = text.endsWith("\r") ? text.slice(0, -1) : text;
      if (trimmed.length > 0) this.ev.line(trimmed);
    }
    if (rest.length === 0) return;
    if (this.#dropping) return;
    this.#parts.push(rest);
    this.#len += rest.length;
    if (this.#len > this.max) {
      this.ev.overflow(this.#len);
      this.#dropping = true;
      this.#reset();
    }
  }

  /** Bytes held back waiting for a newline (diagnostics; a child that exits
   *  mid-line leaves them here — they are never delivered as a message). */
  get pending(): number {
    return this.#len;
  }

  #reset(): void {
    this.#parts = [];
    this.#len = 0;
  }
}

export type Classified = { ok: true; text: string } | { ok: false; reason: string; text: string };

/** Is this line an ACP message, or junk that happened to share the pipe?
 *  The bar is deliberately low — a JSON *object* — because the host is not
 *  an ACP validator: it is the thing that guarantees a frame boundary is a
 *  message boundary. A conforming JSON-RPC envelope is checked only far
 *  enough to count non-conforming ones in diagnostics. */
export function classify(text: string): Classified {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `not JSON (${e instanceof Error ? e.message : String(e)})`, text };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not a JSON object", text };
  }
  return { ok: true, text };
}

/** True when a classified message also looks like JSON-RPC 2.0. Advisory:
 *  counted, never enforced (a strict gate here would make this helper the
 *  arbiter of a protocol it only carries). */
export function isJsonRpc(text: string): boolean {
  try {
    return (JSON.parse(text) as { jsonrpc?: unknown }).jsonrpc === "2.0";
  } catch {
    return false;
  }
}

/** The uplink half of the contract: a DATA frame from the page must be
 *  exactly one message. Frames arrive whole (they are length-prefixed), so
 *  there is nothing to reassemble — only to refuse. An embedded newline is
 *  refused rather than split: it would let one frame inject a second
 *  message into the agent's stdin, which is the confusion this file exists
 *  to prevent. */
export function toAgentLine(bytes: Uint8Array): { ok: true; line: string } | { ok: false; reason: string } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "not valid UTF-8" };
  }
  const body = text.replace(/\r?\n$/, "");
  if (body.includes("\n")) return { ok: false, reason: "more than one line in a DATA frame" };
  const c = classify(body);
  if (!c.ok) return { ok: false, reason: c.reason };
  return { ok: true, line: body + "\n" };
}
