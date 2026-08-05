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
import { parseArgs } from "./args.js";
import { call, CallError } from "./call.js";
import { NodeDirectory } from "./node-fs.js";
import { byMethod } from "./ops.js";
import { findPewter, NotAPewter } from "./pewter.js";
import { serve, stop } from "./serve.js";

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
