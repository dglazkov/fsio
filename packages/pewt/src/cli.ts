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
//   4  no page is open, for the operations only a page can answer
//
// 3 and 4 are two codes because they are two things to do: start the host, or
// open the shell and hand it this folder. Everything before `tabs` could only
// fail the first way.
//
// `pewt run` and `pewt shell` are the exception, and it is the one `npm run`
// set: they exit with the process's own code, because a caller scripting a
// build wants the build's answer. The collision with the codes above is real —
// a script that exits 3 and a pewter with no host look alike from the outside
// — and the message on stderr is what tells them apart.
//
// `pewt check` is the other exception, and it never reaches a host at all: 0
// clean, 1 the compiler found errors, 2 there was nothing to check with. The
// last one is 2 rather than 1 because a git hook wants "your code is wrong"
// and "this pewter has no compiler" to be different things.
import path from "node:path";
import { parseArgs } from "./args.js";
import { call, CallError } from "./call.js";
import { check, CheckError, render as renderCheck } from "./check.js";
import { planClone, CloneError, type CloneSpec } from "./clone.js";
import { planInstall, InstallError, type InstallSpec } from "./install.js";
import { NodeDirectory } from "./node-fs.js";
import { byMethod } from "./ops.js";
import { planAgent, AgentError, type AgentSpec } from "./agent.js";
import { inPewter } from "./paths.js";
import { findPewter, NotAPewter } from "./pewter.js";
import { pipeAgent } from "./pipe.js";
import { planRun, RunError, type RunSpec } from "./run.js";
import { serve, stop } from "./serve.js";
import { runOnHost } from "./stream.js";
import { attachTerminal, sizeOf } from "./terminal.js";

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

if (parsed.kind === "check") {
  // No host, no session, no folder round trip. `check` reads this pewter's
  // own compiler off its own node_modules and runs it here (check.ts).
  try {
    const result = await check(pewter);
    console.log(parsed.json ? JSON.stringify(result, null, 2) : renderCheck(result));
    process.exit(result.ok ? 0 : 1);
  } catch (e) {
    if (!(e instanceof CheckError)) throw e;
    if (parsed.json) {
      console.log(JSON.stringify({ reason: "cannot_check", code: e.code, message: e.message, hint: e.hint }, null, 2));
    } else {
      console.error(`pewt: ${e.message}`);
      if (e.hint) console.error(`  ${e.hint}`);
    }
    // 2 rather than 1: "your code is wrong" and "this pewter cannot answer
    // that question" are different things to do about it, and a git hook
    // running this wants to tell them apart.
    process.exit(2);
  }
} else if (parsed.kind === "serve") {
  const server = await serve(pewter, {
    ...(parsed.url ? { url: parsed.url } : {}),
    open: parsed.open,
    allowRuns: parsed.allowRuns,
    allowShells: parsed.allowShells,
    allowAgents: parsed.allowAgents,
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
    if (parsed.method === "agent") {
      // Resolvable here, on this side of the folder: which adapters this
      // pewter depends on is two files this process can read. Asking a host
      // to describe an agent it is not going to start would only mean the
      // answer needs a host to exist.
      try {
        const plan = planAgent(pewter, parsed.spec as AgentSpec);
        console.log(
          parsed.json
            ? JSON.stringify({ dryRun: true, agent: plan.adapter.name, version: plan.version, asks: plan.adapter.asks, unmeasured: plan.unmeasured, where: plan.where }, null, 2)
            : `would start  ${plan.adapter.title}${plan.version ? ` ${plan.version}` : ""}\n         cwd  ${plan.where}/\n              ${plan.adapter.asks ? "it asks before it edits" : "it edits with its own hands"}\n\n(nothing started — the host was not asked)`
        );
        process.exit(0);
      } catch (e) {
        if (!(e instanceof AgentError)) throw e;
        console.error(`pewt: ${e.message}`);
        if (e.hint) console.error(`  ${e.hint}`);
        process.exit(1);
      }
    }
    if (parsed.method === "shell") {
      // A shell's spec is already resolved (args.ts), so there is nothing to
      // look up: what a dry run can say is where it would start. Which
      // program, and whether the host has a pty, are the host's facts and
      // this deliberately does not guess at them.
      const cwd = typeof parsed.spec["cwd"] === "string" ? parsed.spec["cwd"] : ".";
      const where = path.join(pewter.name, cwd);
      console.log(
        parsed.json
          ? JSON.stringify({ dryRun: true, cwd, where }, null, 2)
          : `would open  a shell\n       cwd  ${where}/\n\n(nothing started — the host was not asked, and which shell it runs is its own)`
      );
      process.exit(0);
    }
    if (parsed.method === "repos.install") {
      try {
        const plan = planInstall(pewter, parsed.spec as unknown as InstallSpec);
        console.log(
          parsed.json
            ? JSON.stringify({ dryRun: true, name: plan.name, where: plan.where }, null, 2)
            : `would run  npm install\n      cwd  ${plan.where}/\n\n(nothing started — the host asks first: an install runs lifecycle scripts)`
        );
        process.exit(0);
      } catch (e) {
        if (!(e instanceof InstallError)) throw e;
        console.error(`pewt: ${e.message}`);
        if (e.hint) console.error(`  ${e.hint}`);
        process.exit(1);
      }
    }
    if (parsed.method === "repos.clone") {
      // Resolvable here: the name and the destination are two reads of this
      // disk. Whether the url fetches is git's answer, and a dry run that
      // fetched to find out would not be one.
      try {
        const plan = planClone(pewter, parsed.spec as unknown as CloneSpec);
        console.log(
          parsed.json
            ? JSON.stringify({ dryRun: true, url: plan.url, name: plan.name, where: plan.where }, null, 2)
            : `would clone  ${plan.url}\n       into  ${plan.where}/\n\n(nothing started — and nothing would be asked: a clone fetches and executes nothing)`
        );
        process.exit(0);
      } catch (e) {
        if (!(e instanceof CloneError)) throw e;
        console.error(`pewt: ${e.message}`);
        if (e.hint) console.error(`  ${e.hint}`);
        process.exit(1);
      }
    }
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

  if (parsed.method === "agent") {
    // --json is what this already is. Every line out is one JSON message, so
    // a flag promising JSON would either change nothing or wrap the agent's
    // protocol in a second one.
    if (parsed.json) {
      console.error("pewt: agent has no --json — every line it prints is already one JSON message");
      process.exit(2);
    }
    try {
      const outcome = await pipeAgent(
        new NodeDirectory(pewter.root),
        parsed.spec,
        { input: process.stdin, output: process.stdout, errors: process.stderr },
        { onWaiting: () => process.stderr.write("pewt: waiting for the host to allow this agent — it is asking on its own terminal\n") }
      );
      if (outcome.ended === "host_gone") {
        process.stderr.write("pewt: the host stopped, and the agent stopped with it\n");
        process.exit(3);
      }
      process.exit(outcome.exitCode ?? 1);
    } catch (e) {
      const err = e instanceof CallError ? e : null;
      console.error(`pewt: ${err ? err.message : e instanceof Error ? e.message : String(e)}`);
      if (err?.hint) console.error(`  ${err.hint}`);
      process.exit(err?.reason === "refused" ? 1 : 3);
    }
  }

  if (parsed.method === "shell") {
    // --json has nothing to describe here: what a shell produces is a
    // terminal's bytes, and wrapping those in JSON would produce neither
    // usable output nor a usable terminal.
    if (parsed.json) {
      console.error("pewt: shell has no --json — what it produces is a terminal, not a result");
      process.exit(2);
    }
    try {
      const outcome = await attachTerminal(
        new NodeDirectory(pewter.root),
        { ...parsed.spec, ...sizeOf(process.stdout) },
        { input: process.stdin, output: process.stdout },
        { onWaiting: () => process.stderr.write("pewt: waiting for the host to allow this shell — it is asking on its own terminal\n") }
      );
      if (outcome.ended === "host_gone") {
        process.stderr.write("pewt: the host stopped, and the shell stopped with it\n");
        process.exit(3);
      }
      // No code means the shell did not report one, which is not the same as
      // success and must not be spelled like it (`run` does the same).
      process.exit(outcome.exitCode ?? 1);
    } catch (e) {
      const err = e instanceof CallError ? e : null;
      console.error(`pewt: ${err ? err.message : e instanceof Error ? e.message : String(e)}`);
      if (err?.hint) console.error(`  ${err.hint}`);
      process.exit(err?.reason === "refused" ? 1 : 3);
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
      onWaiting: () =>
        process.stderr.write(
          parsed.method === "repos.clone"
            ? "pewt: waiting for the host to start this clone\n" // nothing is asked (#189); a slow answer here is a busy host
            : parsed.method === "repos.install"
              ? "pewt: waiting for the host to allow this install — it is asking on its own terminal\n"
              : "pewt: waiting for the host to allow this run — it is asking on its own terminal\n"
        ),
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
  // The two commands that name a file: what a shell completed becomes the one
  // spelling the page reads (paths.ts). Done here rather than in the operation
  // because it needs a working directory and a pewter, and an operation has
  // neither — an extension calling `pewt.open()` has no cwd to resolve against.
  if (parsed.method === "files.open" || parsed.method === "files.fling") {
    const typed = (parsed.params as { path: string }).path;
    const where = inPewter(typed, pewter.root, process.cwd());
    if ("outside" in where) {
      console.error(`pewt: ${where.outside} is outside ${pewter.name}/, so this page cannot read it`);
      console.error(`  The page's reach is exactly the folder you granted it, and neither open nor fling moves bytes across that edge.`);
      process.exit(2);
    }
    parsed.params = { ...(parsed.params as object), path: where.path };
  }
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
    process.exit(err?.reason === "refused" ? 1 : err?.reason === "no_page" ? 4 : 3);
  }
}
