// `pewter` — the package an extension imports.
//
//     import { pewt } from "pewter";
//     for (const repo of (await pewt.repos.list()).repos) list.append(row(repo));
//
// It is an ordinary package in your pewter's node_modules, so an extension
// imports it like anything else and your editor knows the types.
//
// The handshake is why there is nothing to call first. This module announces
// itself to the shell as it evaluates and listens for the port that comes
// back; an extension that calls `pewt.repos.list()` on its first line gets an
// answer rather than a race, because the call waits in the channel until the
// port lands.
//
// The extension speaks first so that neither side has to model when a frame
// is "ready" — see wire.ts for what was measured about the alternative.
import { apiFor, Channel } from "./api.js";
import { hello, isConnect } from "./wire.js";
export { PewtError, explain, METHODS, PROCESS_METHODS } from "./api.js";
export { Channel, apiFor } from "./api.js";
export * from "./agent.js";
export * from "./shell.js";
export * from "./files.js";
export * from "./grants.js";
export * from "./tabs.js";
export * from "./wire.js";
// The host↔page wire. Not an extension's business — it never sees a command
// or a receipt — but this package is the one place the host and the shell can
// both import from, which is what keeps them agreeing about the payload.
export * from "./control.js";
const channel = new Channel();
let openedWith;
/** What this tab was opened with — `tabs.add`'s `args`, or `undefined` when
 *  the tab was opened bare.
 *
 *  A promise rather than a value because an extension's first line runs
 *  before the shell's handshake lands; it settles when the port does, which
 *  is the same moment the first API call can be answered. It is not on
 *  `pewt` because `pewt` mirrors the operation table and this is not an
 *  operation — nothing is asked, it is what arrived with the tab. */
export const args = new Promise((resolve) => {
    openedWith = resolve;
});
/** Take the port the shell offers. Exported so the shell's own tests — and
 *  anything driving an extension outside a browser — can hand one over
 *  directly instead of staging a window message. */
export function connectTo(port, openArgs) {
    channel.attach(port);
    openedWith(openArgs);
}
// Both halves run at import, in a browser only: this package is compiled and
// tested in Node too, where there is no window and nobody to talk to.
if (typeof window !== "undefined" && window.parent !== window) {
    addEventListener("message", (event) => {
        // The port is the capability, so there is no origin here worth checking:
        // an extension's own origin is opaque, the shell's arrives as "null"
        // through a sandboxed frame, and a party that never received a port
        // cannot reach the shell whatever it claims to be. What is checked is
        // that this is the message being waited for and that a port came with it.
        if (!isConnect(event.data) || channel.attached)
            return;
        const port = event.ports[0];
        if (port) {
            channel.attach(port);
            openedWith(event.data.args);
        }
    });
    // "*" because this frame cannot name the shell's origin any more than the
    // shell can name its own opaque one. The shell answers the frame it
    // recognizes by identity, not by what this message claims to be.
    window.parent.postMessage(hello(), "*");
    // What escaped, reported out of the frame (#210).
    //
    // An extension's console is inside an opaque-origin iframe. A human has to
    // think to open devtools; an agent that wrote the screen cannot open one at
    // all — which is how a `TypeError` on a first draw cost a whole session,
    // with the page's own report showing a healthy bundle and nothing wrong.
    // These two listeners are what put the reason in the folder instead.
    //
    // Listening rather than wrapping: an error that reaches here has already
    // gone unhandled, so nothing is being intercepted and no behaviour changes.
    // The console still gets it, because devtools is better than a report when
    // you have devtools.
    //
    // `screen()` in `pewter-ui` dispatches a synthetic `error` event for a
    // throw it caught and drew, which is how a contained failure still gets
    // reported — it renders, so nothing else would ever say it happened.
    addEventListener("error", (e) => {
        const where = e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined;
        channel.trouble("error", e.message || String(e.error), e.error instanceof Error ? e.error.stack : undefined, where);
    });
    addEventListener("unhandledrejection", (e) => {
        const why = e.reason;
        channel.trouble("rejection", why instanceof Error ? `${why.name}: ${why.message}` : String(why), why instanceof Error ? why.stack : undefined);
    });
}
/** The API. Everything an extension can ask for, and nothing else. */
export const pewt = apiFor(channel);
//# sourceMappingURL=index.js.map