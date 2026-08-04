// What rides the DATA frames, in one place — the same reason acp-demo's
// framing.ts exists: two parties that disagree about the payload are the
// whole risk surface of a kind.
//
//   RPC frames  → the fsio control plane, untouched. `spawn`, `ping`,
//                 `close`. The host answers those; this demo adds none.
//   DATA frames → one JSON object per frame, the shapes below. Host → page
//                 carries commands, page → host carries receipts.
//
// v0's JSON-RPC methods are all client → host, and this demo does not ask
// for more: a command is not an RPC *request to the page*, it is a payload
// the page happens to answer. That distinction is what keeps the demo
// inside the protocol (PROCESS.md rule 4 — nothing here is strain).
import { MAX_FLING_BYTES, type Operation } from "./model.js";

/** Bumped when a field's meaning changes. A helper and a page from
 *  different builds meet in a folder more often than you would think. */
export const WIRE_VERSION = 1;

/** Host → page. */
export type Downstream =
  | ({ v: number; type: "command"; id: string } & Operation)
  /** Another page took over this folder (newest wins). The displaced page
   *  stops applying and says so; it is still a working app, just not the
   *  one being actuated. */
  | { v: number; type: "displaced" };

/** Page → host. */
export type Upstream =
  | { v: number; type: "receipt"; id: string; ok: true; result: Record<string, unknown> }
  | { v: number; type: "receipt"; id: string; ok: false; error: { code: string; message: string; hint?: string } };

/** CLI → helper, on the `actuate` session's uplink. One per invocation. */
export type Invocation = { v: number; type: "invoke" } & Operation;

/** Helper → CLI, on the same session's downlink. `error.kind` separates
 *  "the page said no" from "the command never got there", because the two
 *  need different things from whoever is reading. */
export type Outcome =
  | { v: number; type: "outcome"; ok: true; result: Record<string, unknown> }
  | {
      v: number;
      type: "outcome";
      ok: false;
      error: { kind: "app" | "channel"; code: string; message: string; hint?: string };
    };

export const encode = (msg: Downstream | Upstream | Invocation | Outcome): string => JSON.stringify(msg);

/** Parse one DATA frame. Returns null for anything unrecognizable — a
 *  garbled frame is a thing to log and drop, never a thing to throw over:
 *  the session carries a working app and outlives one bad message. */
export function decode<T extends { type: string }>(bytes: Uint8Array | string, types: readonly string[]): T | null {
  let value: unknown;
  try {
    value = JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const msg = value as { type?: unknown; v?: unknown };
  if (typeof msg.type !== "string" || !types.includes(msg.type)) return null;
  if (msg.v !== WIRE_VERSION) return null;
  return value as T;
}

export const decodeDownstream = (bytes: Uint8Array | string): Downstream | null =>
  decode<Downstream>(bytes, ["command", "displaced"]);

export const decodeUpstream = (bytes: Uint8Array | string): Upstream | null =>
  decode<Upstream>(bytes, ["receipt"]);

export const decodeInvocation = (bytes: Uint8Array | string): Invocation | null =>
  decode<Invocation>(bytes, ["invoke"]);

export const decodeOutcome = (bytes: Uint8Array | string): Outcome | null =>
  decode<Outcome>(bytes, ["outcome"]);

export const invoke = (op: Operation): Invocation => ({ v: WIRE_VERSION, type: "invoke", ...op }) as Invocation;

export const outcome = (result: Record<string, unknown>): Outcome => ({
  v: WIRE_VERSION,
  type: "outcome",
  ok: true,
  result,
});

export const failure = (error: {
  kind: "app" | "channel";
  code: string;
  message: string;
  hint?: string;
}): Outcome => ({ v: WIRE_VERSION, type: "outcome", ok: false, error });

export const command = (id: string, op: Operation): Downstream =>
  ({ v: WIRE_VERSION, type: "command", id, ...op }) as Downstream;

export const displaced = (): Downstream => ({ v: WIRE_VERSION, type: "displaced" });

export const receipt = (id: string, result: Record<string, unknown>): Upstream => ({
  v: WIRE_VERSION,
  type: "receipt",
  id,
  ok: true,
  result,
});

export const refusal = (id: string, error: { code: string; message: string; hint?: string }): Upstream => ({
  v: WIRE_VERSION,
  type: "receipt",
  id,
  ok: false,
  error,
});

/** Validate a decoded message's operation half. Both ends do this — the
 *  helper before it dispatches, the page before it applies — because
 *  "anything that can write the folder can write anything" is the standing
 *  assumption (spec/PROTOCOL.md, threat model), and a demo is not exempt
 *  from checking what it was handed. */
export function asOperation(value: { method?: unknown; params?: unknown }): Operation | null {
  const params = (value.params ?? {}) as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof params[k] === "string" ? (params[k] as string) : undefined);
  const num = (k: string): number | undefined =>
    typeof params[k] === "number" && Number.isFinite(params[k]) ? (params[k] as number) : undefined;
  switch (value.method) {
    case "tabs.add": {
      const title = str("title");
      const message = str("message");
      if (title === undefined || message === undefined) return null;
      const activate = params["activate"];
      return {
        method: "tabs.add",
        params: { title, message, ...(typeof activate === "boolean" ? { activate } : {}) },
      };
    }
    case "tabs.remove":
    case "tabs.activate": {
      const id = str("id");
      return id === undefined ? null : { method: value.method, params: { id } };
    }
    case "tabs.update": {
      const id = str("id");
      if (id === undefined) return null;
      const title = str("title");
      const message = str("message");
      if (title === undefined && message === undefined) return null;
      return {
        method: "tabs.update",
        params: { id, ...(title !== undefined ? { title } : {}), ...(message !== undefined ? { message } : {}) },
      };
    }
    case "tabs.list":
      return { method: "tabs.list", params: {} };
    case "files.list":
      return { method: "files.list", params: {} };
    case "files.open": {
      // The path is *not* normalized here: `safeRelPath` is the reducer's
      // job, and a validator that quietly rewrites what it was handed makes
      // the refusal it should have raised unreachable.
      const path = str("path");
      return path === undefined ? null : { method: "files.open", params: { path } };
    }
    case "files.show":
    case "files.drop": {
      const id = str("id");
      return id === undefined ? null : { method: value.method, params: { id } };
    }
    case "files.fling": {
      const name = str("name");
      const from = str("from");
      const type = str("type");
      const data = str("data");
      const size = num("size");
      if (name === undefined || from === undefined || type === undefined || data === undefined || size === undefined) {
        return null;
      }
      // Two cheap checks the reducer cannot make, both about the payload
      // rather than the application: a size that disagrees with the bytes
      // means the frame is not what it says it is, and the cap is enforced
      // before a megabyte of base64 is decoded rather than after.
      if (size < 0 || size > MAX_FLING_BYTES) return null;
      if (Math.ceil(size / 3) * 4 !== data.length) return null;
      const open = params["open"];
      return {
        method: "files.fling",
        params: { name, from, type, size, data, ...(typeof open === "boolean" ? { open } : {}) },
      };
    }
    default:
      return null;
  }
}
