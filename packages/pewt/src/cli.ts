#!/usr/bin/env node
// `pewt` — the command line for a pewter.
//
// It runs inside a pewter and nowhere else: outside one it is not installed,
// so there is nothing to run. Inside one, every command but `serve` is a
// call over the folder to the host — the same session, the same methods, and
// the same operation table an extension reaches through `pewt.*`.
//
// Exit codes, because this exists to be scripted (by a person or an agent):
//   0  done
//   1  the operation refused it — it arrived and the answer was no
//   2  usage error, or this is not a pewter
//   3  no host is running
//
// `pewt run` is the exception, and it is the one `npm run` set: it exits with
// the script's own code, because a caller scripting a build wants the build's
// answer. The collision with the codes above is real — a script that exits 3
// and a pewter with no host look alike from the outside — and the message on
// stderr is what tells them apart.
import { parseArgs } from "./args.js";
import { call, CallError } from "./call.js";
import { NodeDirectory } from "./node-fs.js";
import { byMethod } from "./ops.js";
import { findPewter, NotAPewter } from "./pewter.js";
import { planRun, RunError, type RunSpec } from "./run.js";
import { serve, stop } from "./serve.js";
import { runOnHost } from "./stream.js";

const parsed = parseArgs(process.argv.slice(2));

if (parsed.kind === "help") {
  console.log(parsed.text);
  process.exit(0);
}
if (parsed.kind === "error") {
  console.error(`pewt: ${parsed.message}\n\nRun \`pewt --help\` for usage.`);
  process.exit(2);
}

const pewter = (() => {
  try {
    return findPewter(parsed.dir ?? process.cwd());
  } catch (e) {
    if (!(e instanceof NotAPewter)) throw e;
    console.error(`pewt: ${e.message} (${e.dir})`);
    if (e.hint) console.error(`  ${e.hint}`);
    process.exit(2);
  }
})();

if (parsed.kind === "serve") {
  const server = await serve(pewter, {
    ...(parsed.url ? { url: parsed.url } : {}),
    open: parsed.open,
    allowRuns: parsed.allowRuns,
  }).catch((e: unknown) => {
    // A second host on the same folder is an operator message, not a crash.
    console.error(`pewt: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    void stop(server, pewter, signal).then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
} else if (parsed.kind === "process") {
  // --dry-run is answered here, on this side of the folder. Resolving a run
  // is reading two things off the disk — the project and its package.json —
  // and this process can read both, so asking a host to describe a run it is
  // not going to start would only mean the answer needs a host to exist.
  if (parsed.dryRun) {
    try {
      const plan = planRun(pewter, parsed.spec as unknown as RunSpec);
      console.log(
        parsed.json
          ? JSON.stringify({ dryRun: true, ...plan }, null, 2)
          : `would run  npm run ${plan.script}\n  declared  ${plan.declared}\n       cwd  ${plan.where}/\n\n(nothing started — the host was not asked)`
      );
      process.exit(0);
    } catch (e) {
      if (!(e instanceof RunError)) throw e;
      console.error(`pewt: ${e.message}`);
      if (e.hint) console.error(`  ${e.hint}`);
      process.exit(1);
    }
  }

  try {
    const outcome = await runOnHost(new NodeDirectory(pewter.root), parsed.method, parsed.spec, {
      onLine: (line, stream) => {
        // The child's two streams stay two streams: a build's diagnostics
        // belong on stderr here too, or `pewt run build > out.txt` quietly
        // captures the wrong thing.
        const text = parsed.json ? JSON.stringify(stream === "out" ? { o: line } : { e: line }) : line;
        (stream === "out" || parsed.json ? process.stdout : process.stderr).write(`${text}\n`);
      },
      onWaiting: () => process.stderr.write("pewt: waiting for the host to allow this run — it is asking on its own terminal\n"),
    });
    if (parsed.json) console.log(JSON.stringify({ end: outcome.exitCode }));
    if (outcome.ended === "host_gone") {
      process.stderr.write("pewt: the host stopped before the run finished; anything it started stopped with it\n");
      process.exit(outcome.exitCode ?? 3);
    }
    process.exit(outcome.exitCode ?? 1);
  } catch (e) {
    const err = e instanceof CallError ? e : null;
    const message = err ? err.message : e instanceof Error ? e.message : String(e);
    if (parsed.json) {
      console.log(JSON.stringify({ reason: err?.reason ?? "internal", code: err?.code, message, hint: err?.hint }, null, 2));
    } else {
      console.error(`pewt: ${message}`);
      if (err?.hint) console.error(`  ${err.hint}`);
    }
    process.exit(err?.reason === "refused" ? 1 : 3);
  }
} else {
  const op = byMethod(parsed.method)!;
  try {
    const result = await call(new NodeDirectory(pewter.root), parsed.method, parsed.params);
    console.log(parsed.json ? JSON.stringify(result, null, 2) : op.render(result));
    process.exit(0);
  } catch (e) {
    const err = e instanceof CallError ? e : null;
    const message = err ? err.message : e instanceof Error ? e.message : String(e);
    if (parsed.json) {
      console.log(JSON.stringify({ reason: err?.reason ?? "internal", code: err?.code, message, hint: err?.hint }, null, 2));
    } else {
      console.error(`pewt: ${message}`);
      if (err?.hint) console.error(`  ${err.hint}`);
    }
    process.exit(err?.reason === "refused" ? 1 : err?.reason === "no_host" ? 3 : 3);
  }
}
