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
import { asCall, asSend, answer, connect, event, isHello, PAGE_METHODS, refusal } from "pewter";
import { agentOnHost, callHost, runOnHost, shellOnHost, ShellCallError } from "./session";
import { opaque, served } from "./state";
import { answer as answerHere } from "./tabs";
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
  // Calls that are still running and can still be sent to. One map per
  // extension, because one channel is one extension: a frame cannot reach
  // another's calls any more than it can reach another's storage.
  const live = new Map<number, (body: unknown) => void>();
  channel.port1.onmessage = (event: MessageEvent) => void serve(event.data, channel.port1, name, live);
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
async function serve(data: unknown, port: MessagePort, name: string, live: Map<number, (body: unknown) => void>): Promise<void> {
  // More for a call already running — a keystroke, a window size. It goes to
  // the call it names and nowhere else; one for a call that has ended is
  // dropped, because the extension has no way to have known in time.
  const more = asSend(data);
  if (more) {
    live.get(more.id)?.(more.body);
    return;
  }

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
    // Three shapes, one channel. Most operations are a question with an
    // answer. A run has output while it runs, which arrives here as events
    // keyed to this call's id and ends with the ordinary answer. A shell is
    // the same and talks back. The extension's callbacks never cross the
    // boundary — only the id does.
    //
    // The page's own operations are the fourth case and the shortest: they
    // stop here. An extension asking for a tab is asking the shell, which is
    // one message away rather than a folder away — and is the only party that
    // knows the answer. Nothing about the call says which kind it was, which
    // is the point of there being one API.
    const result =
      PAGE_METHODS.includes(call.method as (typeof PAGE_METHODS)[number])
        ? await answerHere(call.method, call.params)
        : call.method === "run" || call.method === "repos.clone"
        ? await runOnHost(
            call.params as Record<string, unknown>,
            (line, stream) => port.postMessage(event(call.id, stream === "out" ? { o: line } : { e: line })),
            call.method
          )
        : call.method === "shell"
          ? await serveShell(call.id, call.params as Record<string, unknown>, port, live)
          : call.method === "agent"
            ? await serveAgent(call.id, call.params as Record<string, unknown>, port, live)
            : await callHost(call.method, call.params);
    port.postMessage(answer(call.id, result));
    record(call.method, true, t0);
  } catch (e) {
    // A refusal keeps its own code and hint whoever wrote it — the host's
    // operation, or the page's tabs (TabError). An extension acts on those,
    // and flattening them all to "internal" would leave it a sentence to
    // parse instead.
    const known = e as { code?: unknown; message?: unknown; hint?: unknown };
    const err =
      e instanceof ShellCallError
        ? e
        : new ShellCallError(
            typeof known.code === "string" ? known.code : "internal",
            typeof known.message === "string" ? known.message : String(e),
            typeof known.hint === "string" ? known.hint : undefined
          );
    port.postMessage(refusal(call.id, { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) }));
    record(call.method, false, t0);
  } finally {
    live.delete(call.id);
  }
}

/** One shell, for as long as it runs.
 *
 *  The call stays open the whole time: its answer is the exit code, and
 *  everything before that — the shell starting, and every byte it printed —
 *  is an event on the same id. `started` is its own event rather than the
 *  answer because the answer is already spoken for; an extension's
 *  `pewt.shell()` resolves on it. */
async function serveShell(id: number, spec: Record<string, unknown>, port: MessagePort, live: Map<number, (body: unknown) => void>): Promise<{ exitCode: number | null }> {
  const shell = await shellOnHost(spec, (chunk) => port.postMessage(event(id, { d: chunk })));
  live.set(id, (body) => {
    const asked = body as { d?: unknown; cols?: unknown; rows?: unknown; close?: unknown };
    if (typeof asked.d === "string") shell.write(asked.d);
    else if (typeof asked.cols === "number" && typeof asked.rows === "number") shell.resize(asked.cols, asked.rows);
    else if (asked.close) shell.close();
  });
  port.postMessage(event(id, { started: true }));
  return shell.exit;
}

/** One agent, for as long as it runs.
 *
 *  Same shape as a shell — the call stays open, `started` is an event, the
 *  exit code is the answer — carrying whole ACP messages instead of bytes.
 *  Nothing here reads one: the extension on the other side of the port is the
 *  ACP client, and this is the wire it holds. */
async function serveAgent(id: number, spec: Record<string, unknown>, port: MessagePort, live: Map<number, (body: unknown) => void>): Promise<{ exitCode: number | null }> {
  const agent = await agentOnHost(spec, (message) => port.postMessage(event(id, { m: message })));
  live.set(id, (body) => {
    const asked = body as { m?: unknown; close?: unknown };
    if ("m" in asked) agent.send(asked.m);
    else if (asked.close) agent.close();
  });
  port.postMessage(event(id, { started: true }));
  return agent.exit;
}

function record(method: string, ok: boolean, t0: number): void {
  const ms = Math.round(performance.now() - t0);
  served.set([...served.get(), { method, ok, ms }]);
  reporter.event("api-call", { method, ok, ms });
  log(`${method} → ${ok ? "ok" : "refused"} (${ms} ms)`);
}
