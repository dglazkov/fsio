// An extension, in a frame of its own, reaching the host through one port.
//
// This is the load-bearing part of Pewter and the only part with no
// precedent in the other demos, so the reasoning is written out.
//
// **Why the sandbox is not optional.** The shell is hosted, so its origin is
// shared by everyone who uses Pewter, and that origin stores the File System
// Access grants for every folder anybody has ever opened here. Code running
// on it can read all of them. An extension is not necessarily code you
// wrote: an agent may have written it, or it may have arrived with a pewter
// you cloned. So it runs with `sandbox="allow-scripts"` and no
// `allow-same-origin`, which gives it an opaque origin of its own — no
// access to the shell's storage, none to the shell's DOM, and none to
// another extension. This is P5's shape: the party that benefits from the
// permission is not the party that enforces it.
//
// **Why `srcdoc` and not a URL.** The bundle is one self-contained HTML file
// the host built (its JavaScript and CSS inlined, which is why an extension
// cannot code-split). Handing it over as a document is what keeps the shell
// from having to serve anything: no blob URL to revoke, no fetch, no origin
// to get wrong. The bytes come off the folder through the grant the page
// already holds and go straight into the frame.
//
// **Why `postMessage(..., "*")`.** An opaque origin cannot be named. There
// is no string that means "that frame and only that frame", so the target
// origin is a wildcard and the *port* is the capability instead: a party
// that did not receive it cannot reach the shell at all. The frame is one we
// just created with content we just read, so there is nobody else in it to
// overhear the handshake.
//
// What this removes is ambient access. It does not narrow the API — any
// extension can ask for any operation, which is stated plainly in
// NARRATIVE.md's "Looking into the Future" and is the honest description of where
// this stands.
import { asCall, answer, connect, event, isHello, refusal } from "pewter";
import { callHost, runOnHost, ShellCallError } from "./session";
import { opaque, served } from "./state";
import { log, reporter } from "./reporter";

/** Put an extension's bundle in a frame and wire it to the host.
 *
 *  Returns the frame, already loading. The caller owns where it goes in the
 *  document; everything about what it can reach is decided here. */
export function mount(html: string, name: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  // No `allow-same-origin`. Everything else an extension might want —
  // forms, popups, top-level navigation — is absent for the same reason:
  // this list is what an extension has, so it starts at the minimum and
  // grows only when something real needs it.
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("title", `${name} (extension)`);
  frame.srcdoc = html;

  // The extension speaks first (pewter/src/wire.ts says why, and what was
  // measured about handing the port over on `load` instead), so the shell
  // listens for its hello from before the frame exists.
  //
  // The sender is matched by identity — `event.source === frame.contentWindow`
  // — and not by origin. The frame's origin is opaque and arrives as "null",
  // which every sandboxed frame on the page would also claim; the window
  // reference is the only thing here that cannot be spoofed.
  const listener = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow || !isHello(event.data)) return;
    removeEventListener("message", listener);
    opaque.set(isOpaque(frame));
    handshake(frame, name);
  };
  addEventListener("message", listener);
  // An extension that never imports `pewter` never says hello and never needs
  // a port — but whether the wall is up is still worth knowing about it.
  frame.addEventListener("load", () => opaque.set(isOpaque(frame)));
  return frame;
}

/** Does the frame really have an origin of its own?
 *
 *  Measured rather than asserted, because the sandbox attribute is a string
 *  and a typo in it fails open — an extension would get `allow-same-origin`
 *  and nothing would look wrong. A same-origin frame hands over its document
 *  here; a sandboxed one gives null or throws. Both answers are recorded, so
 *  the rig can fail a run in which the wall quietly came down. */
function isOpaque(frame: HTMLIFrameElement): boolean {
  try {
    return frame.contentDocument === null;
  } catch {
    return true; // a SecurityError is the same answer, said louder
  }
}

function handshake(frame: HTMLIFrameElement, name: string): void {
  const channel = new MessageChannel();
  channel.port1.onmessage = (event: MessageEvent) => void serve(event.data, channel.port1, name);
  channel.port1.start();
  // The frame is opaque, so "*" is the only target origin there is. See the
  // header note: the port is what carries the authority, not the origin.
  frame.contentWindow?.postMessage(connect(), "*", [channel.port2]);
}

/** One call from an extension: check it, pass it to the host, answer it.
 *
 *  The shell adds nothing to the request and removes nothing from it. That
 *  is the whole point of the level — an extension reaches exactly what the
 *  command line reaches, because both end up at the same session. */
async function serve(data: unknown, port: MessagePort, name: string): Promise<void> {
  const call = asCall(data);
  if (!call) {
    // Unreadable, or from a build that does not speak this version. Dropping
    // it leaves the extension's call outstanding, which is honest: answering
    // a frame we could not parse would be a guess.
    log(`${name}: dropped an unreadable frame`);
    return;
  }
  const t0 = performance.now();
  try {
    // Two shapes, one channel. Most operations are a question with an answer;
    // a process has output while it runs, which arrives here as events keyed
    // to this call's id and ends with the ordinary answer. The extension's
    // callback never crosses the boundary — only the id does.
    const result =
      call.method === "run"
        ? await runOnHost(call.params as Record<string, unknown>, (line, stream) =>
            port.postMessage(event(call.id, stream === "out" ? { o: line } : { e: line }))
          )
        : await callHost(call.method, call.params);
    port.postMessage(answer(call.id, result));
    record(call.method, true, t0);
  } catch (e) {
    const err =
      e instanceof ShellCallError ? e : new ShellCallError("internal", e instanceof Error ? e.message : String(e));
    port.postMessage(refusal(call.id, { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) }));
    record(call.method, false, t0);
  }
}

function record(method: string, ok: boolean, t0: number): void {
  const ms = Math.round(performance.now() - t0);
  served.set([...served.get(), { method, ok, ms }]);
  reporter.event("api-call", { method, ok, ms });
  log(`${method} → ${ok ? "ok" : "refused"} (${ms} ms)`);
}
