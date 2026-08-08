// `exec` — run a program and read what it printed.
//
// The gap this fills, found by watching an agent build a screen (#210). The
// API's reach was projects, scripts a project already declares, and a shell.
// A screen that wanted one fact from git — how many commits, when the last
// one landed — had none of those: `run` cannot invent a command, and a shell
// is a keyboard. So it opened a shell, wrote a marker protocol over it, and
// spent about 95 lines recovering from a byte stream the things a process
// gives you for free: which output belongs to which command, when it ended,
// its status, and stderr kept apart.
//
// It also had to fight the terminal it did not want. `unalias -a`,
// `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `CLICOLOR=0` — because a shell
// runs your rc file and `git log` on a tty opens a pager and sits there
// forever — plus `cols: 400`, because a pty wraps at its width and a wrapped
// line is a value with a newline in the middle of it. None of that exists
// here: there is no shell, no tty, and no terminal semantics to undo.
//
// **argv, never a command line.** The program and its arguments arrive as
// separate strings and are passed to the OS that way, so there is nothing to
// quote, nothing to interpolate, and no shell to expand a glob nobody meant.
// A pipeline moves into the extension, which is where the joining belonged:
// `git log --format=%cd | sort | uniq -c` is a `--format` and a `reduce`.
//
// It is one rung with `run` and `shell`: the host asks a human at its own
// terminal before starting anything (ask.ts), and this is no different.
import { spawn } from "node:child_process";
import path from "node:path";
import type { HostLogger, KindContext, KindHandler, KindSession } from "@fsio/host";
import { childEnv, splitter, stopTree, type RunFrame } from "./run.js";
import { isSegment, type Pewter } from "./pewter.js";

/** An exec said no before anything started. */
export class ExecError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "ExecError";
  }
}

/** What arrived, once it is a command this host will consider. */
export interface ExecSpec {
  cmd?: unknown;
  args?: unknown;
  repo?: unknown;
}

/** Everything the spawn needs, worked out once. */
export interface ExecPlan {
  cmd: string;
  args: string[];
  repo?: string | undefined;
  /** absolute working directory for the child. */
  cwd: string;
  /** how it reads in one line, for the question and the log. */
  label: string;
  /** `cwd`, relative to the pewter — what a human recognizes. */
  where: string;
}

export function asExecSpec(spec: Readonly<Record<string, unknown>>): ExecSpec {
  return spec as ExecSpec;
}

/** A program name, not a path and not a sentence.
 *
 *  Resolved by the OS against `PATH` (which `childEnv` puts the pewter's own
 *  `node_modules/.bin` at the front of), so an extension names `git` rather
 *  than locating it. A name with a separator in it is refused: an extension
 *  that can name `../../anything` is naming a path, and paths are the host's
 *  business (spec/PROTOCOL.md, threat model). */
const PROGRAM = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;

/** Resolve a spec against the disk, or refuse it. Nothing is spawned here:
 *  the host asks its question between this and the spawn. */
export function planExec(p: Pewter, spec: ExecSpec): ExecPlan {
  const cmd = spec.cmd;
  if (typeof cmd !== "string" || cmd === "") throw new ExecError("bad_params", "exec needs a program to run");
  if (!PROGRAM.test(cmd)) {
    throw new ExecError(
      "bad_program",
      `${JSON.stringify(cmd)} is not a program name`,
      "name the program the way a terminal would — `git`, not a path to it"
    );
  }
  const given: unknown = spec.args ?? [];
  if (!Array.isArray(given) || given.some((a) => typeof a !== "string")) {
    throw new ExecError("bad_params", "exec's arguments must be a list of strings", "each argument is its own string — there is no shell here to split one for you");
  }
  const args = given as string[];

  const repo = spec.repo;
  let cwd = p.root;
  let where = ".";
  if (repo !== undefined) {
    if (typeof repo !== "string" || !isSegment(repo)) {
      throw new ExecError("bad_repo", `${JSON.stringify(String(repo))} is not a project name`, "a project is a directory under repos/ — `pewt repos` lists them");
    }
    cwd = path.join(p.repos, repo);
    where = `repos/${repo}`;
  }
  return {
    cmd,
    args,
    ...(typeof repo === "string" ? { repo } : {}),
    cwd,
    label: `exec ${[cmd, ...args].join(" ")}${typeof repo === "string" ? ` --repo ${repo}` : ""}`,
    where,
  };
}

/** The `exec` kind: a program, its output as it arrives, and an exit code.
 *
 *  The same shape as `run` — this is deliberately not a new kind of thing,
 *  only a different child. Output frames are `run`'s, so both front ends
 *  already know how to print them. */
export function execKind(p: Pewter, log: HostLogger): KindHandler {
  return (ctx: KindContext): KindSession => {
    // Planned twice, once for the question and once here: between the two, a
    // human had time to change something.
    let plan: ExecPlan;
    try {
      plan = planExec(p, asExecSpec(ctx.spec));
    } catch (e) {
      throw e instanceof ExecError && e.hint ? new ExecError(e.code, `${e.message} — ${e.hint}`) : e;
    }

    const child = spawn(plan.cmd, plan.args, {
      cwd: plan.cwd,
      env: childEnv(p),
      // No stdin. A program that wants to ask something has nobody to ask,
      // and a program that would have blocked on a prompt now ends instead —
      // which is the honest outcome for something nobody is sitting at.
      stdio: ["ignore", "pipe", "pipe"],
      // Its own group, so stopping this stops what it started.
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
    // "close" rather than "exit", so the last line a failing program printed
    // still becomes a frame.
    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", (e) => {
      // ENOENT is the common one and deserves its own sentence: an extension
      // named a program this machine does not have, which is a fact about the
      // machine rather than a bug in the screen.
      const why = (e as NodeJS.ErrnoException).code === "ENOENT" ? `pewt: ${plan.cmd} is not on this machine's PATH` : `pewt: could not start ${plan.cmd} — ${e.message}`;
      say({ e: why });
      finish(127, null);
    });

    log.info(`${plan.label} → ${plan.cmd} in ${plan.where}/ (pid ${child.pid ?? "?"})`);

    return {
      result: { cmd: plan.cmd, args: plan.args, repo: plan.repo ?? null, where: plan.where, childPid: child.pid ?? null },
      onClose: () => stopTree(child, done),
    };
  };
}
