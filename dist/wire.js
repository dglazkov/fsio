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
const isType = (value, type) => !!value && typeof value === "object" && value.type === type && value.v === WIRE_VERSION;
export const isHello = (value) => isType(value, "pewt:hello");
export const isConnect = (value) => isType(value, "pewt:connect");
/** A call, or null. Null means the frame is not one — which is a thing to
 *  drop and log, never a thing to throw over: the channel outlives one bad
 *  message, and the sender of a bad one is code somebody is still writing. */
export function asCall(value) {
    if (!value || typeof value !== "object")
        return null;
    const msg = value;
    if (msg.v !== WIRE_VERSION)
        return null;
    if (typeof msg.id !== "number" || typeof msg.method !== "string")
        return null;
    return msg;
}
export function asAnswer(value) {
    if (!value || typeof value !== "object")
        return null;
    const msg = value;
    if (msg.v !== WIRE_VERSION || typeof msg.id !== "number" || typeof msg.ok !== "boolean")
        return null;
    return msg;
}
export function asEvent(value) {
    if (!isType(value, "pewt:event"))
        return null;
    const msg = value;
    return typeof msg.id === "number" ? msg : null;
}
export function asSend(value) {
    if (!isType(value, "pewt:send"))
        return null;
    const msg = value;
    return typeof msg.id === "number" ? msg : null;
}
export const event = (id, payload) => ({ v: WIRE_VERSION, id, type: "pewt:event", event: payload });
export const send = (id, body) => ({ v: WIRE_VERSION, id, type: "pewt:send", body });
export const answer = (id, result) => ({ v: WIRE_VERSION, id, ok: true, result });
export const refusal = (id, error) => ({ v: WIRE_VERSION, id, ok: false, error });
export const connect = () => ({ v: WIRE_VERSION, type: "pewt:connect" });
export const hello = () => ({ v: WIRE_VERSION, type: "pewt:hello" });
//# sourceMappingURL=wire.js.map