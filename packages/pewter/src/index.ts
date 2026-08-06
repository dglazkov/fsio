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
import { apiFor, Channel, type PewtApi } from "./api.js";
import { hello, isConnect } from "./wire.js";

export { PewtError, METHODS, type PewtApi, type Project, type Bundle, type RunOptions, type RunResult } from "./api.js";
export { Channel, apiFor } from "./api.js";
export * from "./agent.js";
export * from "./shell.js";
export * from "./wire.js";

const channel = new Channel();

/** Take the port the shell offers. Exported so the shell's own tests — and
 *  anything driving an extension outside a browser — can hand one over
 *  directly instead of staging a window message. */
export function connectTo(port: MessagePort): void {
  channel.attach(port);
}

// Both halves run at import, in a browser only: this package is compiled and
// tested in Node too, where there is no window and nobody to talk to.
if (typeof window !== "undefined" && window.parent !== window) {
  addEventListener("message", (event: MessageEvent) => {
    // The port is the capability, so there is no origin here worth checking:
    // an extension's own origin is opaque, the shell's arrives as "null"
    // through a sandboxed frame, and a party that never received a port
    // cannot reach the shell whatever it claims to be. What is checked is
    // that this is the message being waited for and that a port came with it.
    if (!isConnect(event.data) || channel.attached) return;
    const port = event.ports[0];
    if (port) channel.attach(port);
  });
  // "*" because this frame cannot name the shell's origin any more than the
  // shell can name its own opaque one. The shell answers the frame it
  // recognizes by identity, not by what this message claims to be.
  window.parent.postMessage(hello(), "*");
}

/** The API. Everything an extension can ask for, and nothing else. */
export const pewt: PewtApi = apiFor(channel);
