// `run` — the host starts a script a project already declares.
//
// A run is a process, and a process is a session. The operation table
// (ops.ts) holds requests that have one answer; this has a stream that ends
// in an exit code, so it gets a session of its own: the spec names the script
// and the project, the output rides DATA frames, and the code rides the
// session's exit. The two slices after this one — `shell` and `agent` — are a
// pty and an ACP stdio process, and both are sessions in the demos they come
// from, so a run-id multiplexer over the shell's one control session would be
// a mechanism those two immediately replace.
//
// What an extension may ask for is bounded by a file it can read, not by a
// capability this code grants: the script has to be in the project's
// `package.json`. That is NARRATIVE.md's "an extension cannot invent a
// script" — the set of runnable things is a file.
//
// The question the host asks before spawning is in serve.ts. This file
// supplies what that question needs to be answerable (`planRun`) and decides
// nothing itself.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { HostLogger, KindContext, KindHandler, KindSession } from "@fsio/host";
import { isSegment, type Pewter } from "./pewter.js";

/** What the page or the terminal asked to run. */
export interface RunSpec {
  /** the script's name in a `package.json`. */
  script: string;
  /** a directory under `repos/`, or absent for the pewter itself. */
  repo?: string | undefined;
}

/** A run, resolved against the disk: everything the question needs and
 *  everything the spawn needs, worked out once. */
export interface RunPlan {
  script: string;
  repo?: string | undefined;
  /** what the project's `package.json` declares this script to be — shown to
   *  the human, never executed directly (npm runs it, with its own PATH). */
  declared: string;
  /** absolute working directory for the child. */
  cwd: string;
  /** how the run reads in one line: `run build --repo fsio`. */
  label: string;
  /** `cwd`, relative to the pewter — what a human recognizes. */
  where: string;
}

/** The run cannot start, and this is the sentence saying why. Thrown by
 *  `planRun`, which runs before anything is spawned. */
export class RunError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "RunError";
  }
}

/** A run's DATA frames, one JSON object per frame.
 *
 *  `end` is in-band on purpose. `status.json` and `out.log` are separate
 *  files with no ordering between them, so a client that finished on the
 *  status change could return before the last lines of a build arrived. A
 *  final frame cannot overtake the output it follows. */
export type RunFrame = { o: string } | { e: string } | { end: number | null };


/** Resolve a spec against the disk, or refuse it. Nothing is spawned here:
 *  the host asks its question between this and the spawn, and a question
 *  about a script that does not exist would be a question not worth asking. */
export function planRun(p: Pewter, spec: RunSpec): RunPlan {
  const script = spec.script;
  if (typeof script !== "string" || script === "") {
    throw new RunError("bad_params", "run needs a script name");
  }
  const repo = spec.repo;
  let cwd = p.root;
  if (repo !== undefined) {
    if (typeof repo !== "string" || !isSegment(repo)) {
      // A project is a directory name under `repos/` and nothing else. The
      // host is the only party that sees paths (D22's shape), so a name that
      // could climb out of `repos/` is refused here rather than normalized
      // into something that works.
      throw new RunError("bad_repo", `${JSON.stringify(String(repo))} is not a project name`, "a project is a directory under repos/ — `pewt repos` lists them");
    }
    cwd = path.join(p.repos, repo);
    if (!fs.existsSync(cwd)) {
      throw new RunError("no_repo", `no project named ${repo} in this pewter`, "`pewt repos` lists them");
    }
  }

  const manifest = path.join(cwd, "package.json");
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(fs.readFileSync(manifest, "utf8")) as { scripts?: Record<string, string> };
  } catch {
    throw new RunError(
      "no_manifest",
      `${where(p, cwd)} has no package.json to declare scripts in`,
      "`pewt run` runs what a project already declares; a project with no package.json declares nothing"
    );
  }
  const scripts = pkg.scripts ?? {};
  const declared = scripts[script];
  if (typeof declared !== "string") {
    const names = Object.keys(scripts);
    throw new RunError(
      "no_script",
      `${where(p, cwd)}/package.json declares no script named ${JSON.stringify(script)}`,
      names.length ? `it declares: ${names.join(", ")}` : "it declares no scripts at all"
    );
  }

  return {
    script,
    repo,
    declared,
    cwd,
    label: `run ${script}${repo ? ` --repo ${repo}` : ""}`,
    where: where(p, cwd),
  };
}

/** A path a human recognizes: relative to the pewter, or the pewter itself. */
function where(p: Pewter, dir: string): string {
  const rel = path.relative(p.root, dir);
  return rel === "" ? p.name : rel;
}

/** The spec a session carries, read back out. Returns null when this is not
 *  a run spec at all — the spawn policy sees every kind. */
export function asRunSpec(spec: Readonly<Record<string, unknown>>): RunSpec | null {
  const script = spec["script"];
  if (typeof script !== "string") return null;
  const repo = spec["repo"];
  return { script, ...(typeof repo === "string" ? { repo } : {}) };
}

/** How much of a line is kept before it is cut. A build that writes a
 *  megabyte with no newline is a build with a bug, and holding it in memory
 *  to find that out helps nobody. */
const LINE_MAX = 64 * 1024;

/** The `run` session kind.
 *
 *  One session, one child. The client sends nothing after the spec: a run has
 *  no stdin, because npm scripts that read one are asking for a terminal and
 *  that is what `pewt shell` will be for. */
export function runKind(p: Pewter, log: HostLogger): KindHandler {
  return (ctx: KindContext): KindSession => {
    // The plan is made twice — once for the question, once here. Both reads
    // are cheap and the second is the one that matters: between the question
    // and the spawn, a human had time to edit the file.
    const spec = asRunSpec(ctx.spec);
    if (!spec) throw new RunError("bad_params", "a run session needs a script name in its spec");
    // A failed spawn carries a message and nothing else (the host answers
    // `1002` with text), so the hint travels inside the sentence or it does
    // not travel at all.
    let plan: RunPlan;
    try {
      plan = planRun(p, spec);
    } catch (e) {
      throw e instanceof RunError && e.hint ? new RunError(e.code, `${e.message} — ${e.hint}`) : e;
    }

    const child = spawn("npm", ["run", plan.script], {
      cwd: plan.cwd,
      env: childEnv(p),
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so the host can stop the whole tree it
      // started. `npm run` is a parent — killing only npm leaves the build
      // it launched running, which is how orphaned vite servers happen.
      detached: true,
    });

    const say = (frame: RunFrame): void => ctx.write(JSON.stringify(frame));
    let lines = 0;
    const out = splitter((line) => {
      lines++;
      say({ o: line });
    });
    const err = splitter((line) => {
      lines++;
      say({ e: line });
    });
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));

    let done = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (done) return;
      done = true;
      out.flush();
      err.flush();
      const exitCode = code ?? (signal ? 128 : null);
      say({ end: exitCode });
      log.info(`${plan.label} → exit ${exitCode ?? "?"}${signal ? ` (${signal})` : ""} · ${lines} line${lines === 1 ? "" : "s"}`);
      ctx.exit(exitCode);
    };
    // "close" rather than "exit": stdio is drained first, so the last line a
    // failing build printed still becomes a frame (acp-kind.ts learned this).
    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", (e) => {
      say({ e: `pewt: could not start npm — ${e.message}` });
      finish(127, null);
    });

    log.info(`${plan.label} → npm run ${plan.script} in ${plan.where}/ (pid ${child.pid ?? "?"})`);

    return {
      // What the client needs to print a header without asking again.
      result: { script: plan.script, repo: plan.repo ?? null, declared: plan.declared, where: plan.where, childPid: child.pid ?? null },
      onClose: () => stopTree(child, done),
    };
  };
}

/** The environment a script runs in.
 *
 *  `pewt` on PATH is the load-bearing part (NARRATIVE.md: "the script runs
 *  with the project as its working directory and `pewt` on its `PATH`, so an
 *  existing build can call back in without ceremony"). It lives in the
 *  pewter's own `node_modules/.bin`, and the child's cwd is a project inside
 *  the pewter, so `pewt` finds this same pewter by walking up. */
export function childEnv(p: Pewter): NodeJS.ProcessEnv {
  const bin = path.join(p.root, "node_modules", ".bin");
  const current = process.env["PATH"] ?? "";
  return { ...process.env, PATH: current.includes(bin) ? current : `${bin}${path.delimiter}${current}` };
}

/** Stop the child and whatever it started. The narrative's claim is that a
 *  process the host started stops with it, and a process group is what makes
 *  that true of the build tools npm launches. Exported for the other kind
 *  that spawns (clone.ts), so D6 is one implementation. */
export function stopTree(child: ChildProcess, alreadyDone: boolean): void {
  if (alreadyDone || child.pid === undefined) return;
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-child.pid!, sig);
    } catch {
      // The group is gone, or was never made (spawn failed). Either way
      // there is nothing left to stop.
    }
  };
  signal("SIGTERM");
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signal("SIGKILL");
  }, 2000);
  t.unref();
}

/** Bytes in, whole lines out. Trailing `\r` goes with the newline so a tool
 *  writing CRLF does not put a stray carriage return in every frame. */
export function splitter(onLine: (line: string) => void): { push(chunk: Buffer): void; flush(): void } {
  let buf = "";
  return {
    push(chunk: Buffer): void {
      buf += chunk.toString("utf8");
      for (;;) {
        const at = buf.indexOf("\n");
        if (at === -1) break;
        onLine(buf.slice(0, at).replace(/\r$/, ""));
        buf = buf.slice(at + 1);
      }
      if (buf.length > LINE_MAX) {
        onLine(buf.slice(0, LINE_MAX) + " …[cut: no newline in 64 KB]");
        buf = "";
      }
    },
    flush(): void {
      if (buf !== "") {
        onLine(buf.replace(/\r$/, ""));
        buf = "";
      }
    },
  };
}

/** A frame off the wire, or null when it is not one this version knows. Used
 *  by both clients — the command line and the shell — so there is one reader
 *  for one writer. */
export function asRunFrame(bytes: Uint8Array): RunFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const f = value as Record<string, unknown>;
  if (typeof f["o"] === "string") return { o: f["o"] };
  if (typeof f["e"] === "string") return { e: f["e"] };
  if ("end" in f && (typeof f["end"] === "number" || f["end"] === null)) return { end: f["end"] as number | null };
  return null;
}
