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
 *  in a folder somebody owns.
 *
 *  2: calls may now be answered by zero or more `Event` messages before the
 *  one `Answer`. Nothing is published and no shell is deployed, so no old
 *  build exists to meet this one in a tab.
 *
 *  3: a call in flight can now be sent more (`Send`), which is what a shell
 *  needs and nothing before it did. */
export const WIRE_VERSION = 3;

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
 *  shell at all, and one that did is whoever the shell handed it to.
 *
 *  `args` is what the tab was opened with — `tabs.add`'s `args`, delivered
 *  here because the handshake already happens at exactly the right moment
 *  and a second message would buy nothing. Absent when the tab was opened
 *  bare. Added without a version bump: absence means what it always meant,
 *  and no old build exists to meet this one in a tab (nothing is published —
 *  if the shell ever deploys ahead of installed `pewt`s, that disagreement
 *  is #164 item 9's business, version agreement). */
export interface Connect {
  v: number;
  type: "pewt:connect";
  args?: unknown;
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

/** Shell → extension, on the port: something happened while a call is still
 *  running. Zero or more per call, always before that call's `Answer`.
 *
 *  This exists because a run is not a question with an answer — it is a
 *  process, and its output is worth having while it is still going. The
 *  callback an extension passes to `pewt.run` never leaves the frame: the
 *  shell keys events to the call's id and `api.ts` finds the callback again
 *  on this side. (NARRATIVE.md used to spell this `proxy(...)`, which is
 *  Comlink's word for shipping a function across; nothing here ships one.) */
export interface Event {
  v: number;
  id: number;
  type: "pewt:event";
  /** what happened, in the operation's own vocabulary. A run sends
   *  `{o: line}` and `{e: line}`; the extension never sees the run's final
   *  frame, because that one is the `Answer`. */
  event: unknown;
}

/** Extension → shell, on the port: more for a call that is still running.
 *  Zero or more per call, always before that call's `Answer`.
 *
 *  `Event` runs the other way, and the pair is what makes a shell possible: a
 *  terminal is not a question with an answer, it is bytes in both directions
 *  until one side stops. Before this existed a call could only be asked once,
 *  which is why the version went to 3.
 *
 *  A `Send` for a call that has already been answered is dropped. There is no
 *  acknowledgement and no ordering guarantee beyond the channel's own, which
 *  is what a terminal already assumes about a keyboard. */
export interface Send {
  v: number;
  id: number;
  type: "pewt:send";
  /** what to send, in the operation's own vocabulary. A shell sends
   *  `{d: keystrokes}`, `{cols, rows}` and `{close: true}`. */
  body: unknown;
}

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

export function asEvent(value: unknown): Event | null {
  if (!isType(value, "pewt:event")) return null;
  const msg = value as Event;
  return typeof msg.id === "number" ? msg : null;
}

export function asSend(value: unknown): Send | null {
  if (!isType(value, "pewt:send")) return null;
  const msg = value as Send;
  return typeof msg.id === "number" ? msg : null;
}

export const event = (id: number, payload: unknown): Event => ({ v: WIRE_VERSION, id, type: "pewt:event", event: payload });

export const send = (id: number, body: unknown): Send => ({ v: WIRE_VERSION, id, type: "pewt:send", body });

export const answer = (id: number, result: unknown): Answer => ({ v: WIRE_VERSION, id, ok: true, result });

export const refusal = (id: number, error: ApiError): Answer => ({ v: WIRE_VERSION, id, ok: false, error });

export const connect = (args?: unknown): Connect => ({ v: WIRE_VERSION, type: "pewt:connect", ...(args !== undefined ? { args } : {}) });

export const hello = (): Hello => ({ v: WIRE_VERSION, type: "pewt:hello" });
