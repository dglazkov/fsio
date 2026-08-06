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
export const command = (id, method, params) => ({
    v: CONTROL_VERSION,
    type: "pewt:command",
    id,
    method,
    params,
});
export const receipt = (id, result) => ({
    v: CONTROL_VERSION,
    type: "pewt:receipt",
    id,
    ok: true,
    result,
});
export const receiptError = (id, error) => ({
    v: CONTROL_VERSION,
    type: "pewt:receipt",
    id,
    ok: false,
    error,
});
export const encodeControl = (msg) => JSON.stringify(msg);
/** One DATA frame → a message, or null.
 *
 *  Null means the frame is not one this build reads — a thing to log and drop,
 *  never a thing to throw over. The session carries a working page and
 *  outlives one bad message. */
function decode(bytes, type) {
    let value;
    try {
        value = JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes));
    }
    catch {
        return null;
    }
    if (!value || typeof value !== "object")
        return null;
    const msg = value;
    if (msg.type !== type || msg.v !== CONTROL_VERSION || typeof msg.id !== "string")
        return null;
    return value;
}
export const asCommand = (bytes) => {
    const msg = decode(bytes, "pewt:command");
    return msg && typeof msg.method === "string" ? msg : null;
};
export const asReceipt = (bytes) => {
    const msg = decode(bytes, "pewt:receipt");
    return msg && typeof msg.ok === "boolean" ? msg : null;
};
//# sourceMappingURL=control.js.map