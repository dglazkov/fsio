// `pewt agent` — this terminal's stdio, joined to an agent's ACP stream.
//
// It is a pipe, not a conversation. One ACP message per line in on stdin, the
// agent's own messages out on stdout, and nothing in between interprets
// either. Whatever is on the other end is the ACP client: a program driving
// an agent, or a person with `jq`. The client Pewter is building toward is a
// tab, and a tab does not come through here.
//
// Settled with the owner (2026-08-05) against the two alternatives, both of
// which needed an ACP client in the command line — a one-shot `pewt agent
// "fix the test"`, and a full terminal chat. A chat surface is what
// `extensions/chat/` is for, and a pipe is the thing a terminal can do that a
// tab cannot: be driven by another program.
//
// **The agent's stderr does not come out here, and that is a known gap rather
// than a choice.** It cannot ride DATA — a DATA frame is one ACP message and
// stderr is not ACP — so the kind keeps it for `agent/diagnostics`, and that
// method is gone from the moment the agent exits
// ([#98](https://github.com/dglazkov/fsio/issues/98): `ctx.exit()` drops the
// kind, which is the right lifecycle rule at the wrong moment). By the time a
// pipe knows to ask, there is nobody left to answer.
//
// Asking on a timer while it runs is the workaround #98 already names, and it
// is a race by construction: the useful lines are the last ones written. So
// this does not pretend. The kind logs every stderr line as it arrives, which
// puts it on the terminal running `pewt serve`, and this says where to look.
import type { FsDirectory } from "@fsio/client";
import { LineSplitter } from "./framing.js";
import { agentOnHost, type AgentDiagnostics, type ShellOutcome } from "./stream.js";

export interface PipeStreams {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  /** where the agent's own stderr goes, and where this reports itself. */
  errors: NodeJS.WritableStream;
}

/** Join `streams` to an agent and return when it exits.
 *
 *  Throws what `agentOnHost` throws when it never started — before anything
 *  has been written anywhere, so a refusal leaves a clean pipe. */
export async function pipeAgent(
  dir: FsDirectory,
  spec: Record<string, unknown>,
  streams: PipeStreams,
  opts: { onWaiting?: () => void } = {}
): Promise<ShellOutcome> {
  const { input, output, errors } = streams;
  const agent = await agentOnHost(dir, spec, {
    // Re-serialized rather than forwarded verbatim. The alternative is to
    // pass the bytes through, which would be a cheaper pipe and a worse one:
    // what a caller reads here would then be whatever the agent wrote, and
    // the framing contract this session enforces would be invisible on the
    // way out.
    onMessage: (message) => output.write(`${JSON.stringify(message)}\n`),
    ...(opts.onWaiting ? { onWaiting: opts.onWaiting } : {}),
  });

  // One line in is one message out, checked here so a malformed line is a
  // sentence on stderr rather than a frame the host refuses silently.
  const splitter = new LineSplitter({
    line: (text) => {
      if (!text.trim()) return;
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch (e) {
        errors.write(`pewt: not JSON, so not sent — ${e instanceof Error ? e.message : String(e)}\n`);
        return;
      }
      if (message === null || typeof message !== "object" || Array.isArray(message)) {
        errors.write("pewt: an ACP message is a JSON object; that line was not one, so it was not sent\n");
        return;
      }
      agent.send(message);
    },
    overflow: (bytes) => errors.write(`pewt: dropped a ${bytes}-byte line with no newline\n`),
  });

  // Asked while it is still running, which is the only time it can be
  // answered. Kept so that a pipe whose agent dies without ever speaking has
  // something to say beyond an exit code — the counters at least name whether
  // anything reached it. The lines written in the last moments are on the
  // host's terminal, not here (see the note at the top).
  const seen: { last: AgentDiagnostics | null } = { last: null };
  const watch = setInterval(() => void agent.diagnostics().then((d) => (seen.last = d)).catch(() => {}), 1000);
  watch.unref();

  const onInput = (chunk: Buffer): void => splitter.push(chunk);
  // stdin ending is the ordinary way to drive this: a program writes its
  // messages and closes the pipe. The agent keeps going — an ACP session ends
  // when the agent decides it has, not when its caller stops typing — so this
  // only stops sending.
  const onEnd = (): void => {};

  let outcome: ShellOutcome | null = null;
  try {
    input.on("data", onInput);
    input.on("end", onEnd);
    input.resume();
    outcome = await agent.exit;
    return outcome;
  } finally {
    clearInterval(watch);
    input.off("data", onInput);
    input.off("end", onEnd);
    input.pause();
    // What the last live snapshot knew, which is never the final lines. Said
    // plainly rather than dressed up as the agent's output: a caller reading
    // this needs to know it is a summary and where the rest is.
    const said = seen.last;
    if (said?.junkLines) {
      errors.write(`pewt: the agent wrote ${said.junkLines} non-message line${said.junkLines === 1 ? "" : "s"} to stdout; they were never delivered\n`);
    }
    if (said?.stderr.length) {
      errors.write(`pewt: the agent wrote to stderr — the last ${said.stderr.length} line${said.stderr.length === 1 ? "" : "s"} seen while it ran:\n`);
      for (const line of said.stderr) errors.write(`  ${line}\n`);
    }
    // Only when something went wrong. An agent that did its job and left
    // cleanly needs no footnote, and a pointer printed on every run is a
    // pointer nobody reads on the run that needed it.
    if (outcome === null || outcome.exitCode !== 0) {
      errors.write("pewt: anything it said on the way out is on the terminal running `pewt serve` (https://github.com/dglazkov/fsio/issues/98)\n");
    }
    await agent.close();
  }
}
