// What crosses the message channel between an extension and the shell.
//
// Both sides import this file, which is the point: two parties that
// disagree about the payload are the whole risk surface of a channel. The
// shell speaks it in packages/pewter-shell; an extension speaks it through
// `pewt` in api.ts and never sees it directly.
//
// The channel is the extension's only reach. It runs in a sandboxed iframe
// with no `allow-same-origin`, so it has an opaque origin of its own: no
// access to the shell's storage, none to the shell's DOM, and none to
// another extension. Everything it does, it does by asking here.

/** Bumped when a field's meaning changes. A shell and an extension from
 *  different builds meet in a tab more often than you would think — the
 *  shell ships on our schedule, and the extension was bundled from source
 *  in a folder somebody owns. */
export const WIRE_VERSION = 1;

/** Extension → shell, once, on the parent window: "I am here".
 *
 *  The handshake is the child's to start. The alternative is the shell
 *  handing over a port on the frame's `load` event, and that works —
 *  measured: Chrome fires an iframe's `load` about 15 ms in while the
 *  frame's module script is still suspended on a 1500 ms top-level await, so
 *  an extension whose first line is `await pewt.repos.list()` still gets its
 *  port. (That was checked because the opposite seemed likely and would have
 *  deadlocked: the port waiting for the call and the call for the port.)
 *
 *  What the child speaking first buys is not having to be right about that
 *  ordering. The shell listens from before the frame exists, so there is no
 *  event it can be late for and no relationship between "the document
 *  finished loading" and "the extension is ready to be handed something"
 *  that either side has to model. */
export interface Hello {
  v: number;
  type: "pewt:hello";
}

/** Shell → extension: "here is your port".
 *
 *  The port IS the capability. The extension holds no origin it could check
 *  and needs none: a party that did not receive this port cannot talk to the
 *  shell at all, and one that did is whoever the shell handed it to. */
export interface Connect {
  v: number;
  type: "pewt:connect";
}

/** Extension → shell, on the port. */
export interface Call {
  v: number;
  id: number;
  method: string;
  params: unknown;
}

/** Shell → extension, on the port. One per call, ever. */
export type Answer =
  | { v: number; id: number; ok: true; result: unknown }
  | { v: number; id: number; ok: false; error: ApiError };

/** Why the answer was no. `code` is the operation's own word for it and
 *  `hint` is what to do instead — both travel from the host untouched, so an
 *  extension can act on them rather than parse a sentence. */
export interface ApiError {
  code: string;
  message: string;
  hint?: string;
}

const isType = (value: unknown, type: string): boolean =>
  !!value && typeof value === "object" && (value as Hello).type === type && (value as Hello).v === WIRE_VERSION;

export const isHello = (value: unknown): value is Hello => isType(value, "pewt:hello");

export const isConnect = (value: unknown): value is Connect => isType(value, "pewt:connect");

/** A call, or null. Null means the frame is not one — which is a thing to
 *  drop and log, never a thing to throw over: the channel outlives one bad
 *  message, and the sender of a bad one is code somebody is still writing. */
export function asCall(value: unknown): Call | null {
  if (!value || typeof value !== "object") return null;
  const msg = value as Call;
  if (msg.v !== WIRE_VERSION) return null;
  if (typeof msg.id !== "number" || typeof msg.method !== "string") return null;
  return msg;
}

export function asAnswer(value: unknown): Answer | null {
  if (!value || typeof value !== "object") return null;
  const msg = value as Answer;
  if (msg.v !== WIRE_VERSION || typeof msg.id !== "number" || typeof msg.ok !== "boolean") return null;
  return msg;
}

export const answer = (id: number, result: unknown): Answer => ({ v: WIRE_VERSION, id, ok: true, result });

export const refusal = (id: number, error: ApiError): Answer => ({ v: WIRE_VERSION, id, ok: false, error });

export const connect = (): Connect => ({ v: WIRE_VERSION, type: "pewt:connect" });

export const hello = (): Hello => ({ v: WIRE_VERSION, type: "pewt:hello" });
