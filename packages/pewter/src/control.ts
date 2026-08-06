// What crosses the folder between the host and the page.
//
// The `pewt` session the shell holds has carried RPC in one direction since
// the skeleton: the page asks, the host answers. This is the other direction,
// and it exists because some operations are the page's. `pewt tabs add
// dashboard` typed in a terminal is a question only a browser can answer, so
// the host forwards it down the session the page already has open and waits
// for the receipt.
//
// The direction is worth being precise about. The page opens the session — a
// client always creates sessions (spec: Session lifecycle) — and yet what
// flows here is control from the machine to the page. Who dials and who drives
// are different questions, and only the first one is the protocol's. Nothing
// in here is strain: a command is not an RPC request to a client, it is a
// payload the page happens to answer, which is the shape `actuator-demo`
// established (its messages.ts says the same thing).
//
// Both sides import this file, which is the point: two parties that disagree
// about the payload are the whole risk surface of a channel. The host speaks
// it in @fsio/pewt's router.ts, the page in the shell's session.ts.

/** Bumped when a field's meaning changes. A host and a page from different
 *  builds meet in a folder more often than you would think — the shell ships
 *  on our schedule and `pewt` is installed on yours. */
export const CONTROL_VERSION = 1;

/** Host → page, on the session's downlink: answer this. */
export interface Command {
  v: number;
  type: "pewt:command";
  /** what the receipt comes back against. The host mints it; the page only
   *  ever echoes it. */
  id: string;
  method: string;
  params: unknown;
}

/** Page → host, on the same session's uplink. One per command, ever. */
export type Receipt =
  | { v: number; type: "pewt:receipt"; id: string; ok: true; result: Record<string, unknown> }
  | { v: number; type: "pewt:receipt"; id: string; ok: false; error: { code: string; message: string; hint?: string } };

export const command = (id: string, method: string, params: unknown): Command => ({
  v: CONTROL_VERSION,
  type: "pewt:command",
  id,
  method,
  params,
});

export const receipt = (id: string, result: Record<string, unknown>): Receipt => ({
  v: CONTROL_VERSION,
  type: "pewt:receipt",
  id,
  ok: true,
  result,
});

export const receiptError = (id: string, error: { code: string; message: string; hint?: string }): Receipt => ({
  v: CONTROL_VERSION,
  type: "pewt:receipt",
  id,
  ok: false,
  error,
});

export const encodeControl = (msg: Command | Receipt): string => JSON.stringify(msg);

/** One DATA frame → a message, or null.
 *
 *  Null means the frame is not one this build reads — a thing to log and drop,
 *  never a thing to throw over. The session carries a working page and
 *  outlives one bad message. */
function decode<T extends { type: string }>(bytes: Uint8Array | string, type: string): T | null {
  let value: unknown;
  try {
    value = JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const msg = value as { type?: unknown; v?: unknown; id?: unknown };
  if (msg.type !== type || msg.v !== CONTROL_VERSION || typeof msg.id !== "string") return null;
  return value as T;
}

export const asCommand = (bytes: Uint8Array | string): Command | null => {
  const msg = decode<Command>(bytes, "pewt:command");
  return msg && typeof msg.method === "string" ? msg : null;
};

export const asReceipt = (bytes: Uint8Array | string): Receipt | null => {
  const msg = decode<Receipt>(bytes, "pewt:receipt");
  return msg && typeof msg.ok === "boolean" ? msg : null;
};
