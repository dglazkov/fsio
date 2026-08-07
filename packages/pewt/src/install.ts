// `repos.install` — the host runs `npm install` in a project, asked first.
//
// The other half of clone (#193), and the half that IS asked. Clone's
// no-question pass rests on "fetches and executes nothing it fetched";
// `npm install` is precisely where that stops being true — lifecycle
// scripts run, and postinstall is arbitrary code from the thing just
// fetched plus everything it depends on. Install is the first execution of
// fetched code, which is exactly what the host's question exists for.
//
// It rides the **run rung** (settled with the owner, 2026-08-07): asked
// with its own label and its own honest lines, but covered by
// `--allow-runs` and by a standing `run/<project>` grant — that grant
// already means "I trust this project's code to execute", and any script
// run executes `node_modules` anyway. The question itself is in ask.ts;
// this file supplies what it needs (`planInstall`) and decides nothing.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { HostLogger, KindContext, KindHandler, KindSession } from "@fsio/host";
import { crSplitter } from "./clone.js";
import type { Pewter } from "./pewter.js";
import { isProjectName } from "./repos.js";
import { stopTree, type RunFrame } from "./run.js";

/** What the page or the terminal asked to install: one project. There is no
 *  "install the pewter itself" spelling — the pewter's own install is `npm i`
 *  in your terminal, in the folder you are already standing in. */
export interface InstallSpec {
  name: string;
}

/** The install cannot start, and this is the sentence saying why. */
export class InstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "InstallError";
  }
}

export interface InstallPlan {
  name: string;
  /** absolute working directory for npm. */
  cwd: string;
  /** how it reads in one line: `install --repo fsio`. */
  label: string;
  /** `cwd`, relative to the pewter. */
  where: string;
}

/** Resolve a spec against the disk, or refuse it. Nothing is spawned here:
 *  the host asks its question between this and the spawn, and a question
 *  about a project with nothing to install would not be worth asking. */
export function planInstall(p: Pewter, spec: InstallSpec): InstallPlan {
  const name = spec.name;
  if (typeof name !== "string" || !isProjectName(name)) {
    throw new InstallError("bad_name", `${JSON.stringify(String(name))} is not a project name`, "a project is a directory under repos/ — `pewt repos` lists them");
  }
  const cwd = path.join(p.repos, name);
  if (!fs.existsSync(cwd)) {
    throw new InstallError("no_repo", `no project named ${name} in this pewter`, "`pewt repos` lists them");
  }
  if (!fs.existsSync(path.join(cwd, "package.json"))) {
    throw new InstallError("no_manifest", `${name} has no package.json, so there is nothing to install`, "a manifest is what declares dependencies");
  }
  return { name, cwd, label: `install --repo ${name}`, where: path.join("repos", name) };
}

/** The spec a session carries, read back out. Null when it is not an
 *  install spec at all — the spawn policy sees every kind. */
export function asInstallSpec(spec: Readonly<Record<string, unknown>>): InstallSpec | null {
  const name = spec["name"];
  return typeof name === "string" ? { name } : null;
}

/** A repaint becomes a frame at most this often (clone.ts's bound — npm's
 *  spinner paints as fast as git's progress does). */
const PROGRESS_MS = 200;

/** The `repos.install` session kind.
 *
 *  One session, one `npm install`. Same rails as a clone: frames out, exit
 *  code ends it, stdin closed so nothing can hang on a prompt nobody sees.
 *  Unlike a clone there is no cleanup on failure — a half-written
 *  `node_modules` is npm's own recoverable state, and `installed` stays
 *  false either way because the read is the directory, not this exit. */
export function installKind(p: Pewter, log: HostLogger): KindHandler {
  return (ctx: KindContext): KindSession => {
    const spec = asInstallSpec(ctx.spec);
    if (!spec) throw new InstallError("bad_params", "an install session needs a project name in its spec");
    let plan: InstallPlan;
    try {
      plan = planInstall(p, spec);
    } catch (e) {
      throw e instanceof InstallError && e.hint ? new InstallError(e.code, `${e.message} — ${e.hint}`) : e;
    }

    const child = spawn("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: plan.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so the host can stop the whole tree (D6) —
      // npm spawns lifecycle scripts, and they go with it.
      detached: true,
    });

    const say = (frame: RunFrame): void => ctx.write(JSON.stringify(frame));
    let pendingProgress: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flushProgress = (): void => {
      timer = null;
      if (pendingProgress === null) return;
      say({ e: pendingProgress });
      pendingProgress = null;
    };
    const repaint = (line: string): void => {
      pendingProgress = line;
      if (!timer) {
        timer = setTimeout(flushProgress, PROGRESS_MS);
        timer.unref();
      }
    };
    const out = crSplitter((line) => say({ o: line }), repaint);
    const err = crSplitter((line) => {
      pendingProgress = null;
      say({ e: line });
    }, repaint);
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));

    let done = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      flushProgress();
      out.flush();
      err.flush();
      const exitCode = code ?? (signal ? 128 : null);
      say({ end: exitCode });
      log.info(`${plan.label} → exit ${exitCode ?? "?"}${signal ? ` (${signal})` : ""}`);
      ctx.exit(exitCode);
    };
    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", (e) => {
      say({ e: `pewt: could not start npm — ${e.message}` });
      finish(127, null);
    });

    log.info(`${plan.label} → npm install in ${plan.where}/ (pid ${child.pid ?? "?"})`);

    return {
      result: { name: plan.name, where: plan.where, childPid: child.pid ?? null },
      onClose: () => stopTree(child, done),
    };
  };
}
