// `repos.clone` — the host fetches a project into `repos/`.
//
// A clone is a process, and a process is a session (run.ts said it first):
// the spec names the url and the destination, git's own output rides DATA
// frames, and the exit code ends it. Both front ends stream it — `pewt repos
// clone <url>` in a terminal, `pewt.repos.clone(url)` in an extension — the
// same way a run's output already travels.
//
// **It starts a process and does not ask.** Settled with the owner (#189),
// on `pewt check`'s precedent: git fetches and executes nothing it fetched —
// a clone runs no hooks of the cloned repository — and it writes only inside
// `repos/`, in the folder the page was already granted. What this widens is
// network egress to a caller-chosen URL, which is named in #164's strain list
// rather than put behind a prompt (P3: a question with no scope behind it is
// fatigue, not consent).
//
// Progress is throttled here, not downstream. git repaints its progress line
// with `\r` many times a second, every frame is a file write on the folder,
// and a transport is not a terminal. A repaint becomes a frame at most every
// PROGRESS_MS; real lines always travel.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { HostLogger, KindContext, KindHandler, KindSession } from "@fsio/host";
import type { Pewter } from "./pewter.js";
import { isProjectName } from "./repos.js";
import { stopTree, type RunFrame } from "./run.js";

/** What the page or the terminal asked to clone. */
export interface CloneSpec {
  url: string;
  /** the directory name under `repos/`. Derived from the url when absent. */
  name?: string | undefined;
}

/** The clone cannot start, and this is the sentence saying why. Thrown by
 *  `planClone`, which runs before anything is spawned. */
export class CloneError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "CloneError";
  }
}

/** A clone, resolved against the disk: everything the spawn needs and
 *  everything a header prints, worked out once. */
export interface ClonePlan {
  url: string;
  name: string;
  /** absolute destination directory. Did not exist when this plan was made. */
  dest: string;
  /** how it reads in one line: `repos.clone fsio`. */
  label: string;
  /** `dest`, relative to the pewter — what a human recognizes. */
  where: string;
}

/** The project name a url implies: its last path segment, `.git` stripped.
 *  Handles the three spellings git takes — `https://…/owner/repo.git`,
 *  `git@host:owner/repo.git`, and a plain path. Null when the url ends in
 *  nothing nameable — including a bare host, which is an authority and not a
 *  name — and that is the caller's cue to ask for one. */
export function deriveName(url: string): string | null {
  const trimmed = url.replace(/\/+$/, "");
  let tail: string;
  const scheme = trimmed.indexOf("://");
  if (scheme !== -1) {
    const rest = trimmed.slice(scheme + 3);
    const slash = rest.indexOf("/");
    if (slash === -1) return null;
    tail = rest.slice(slash + 1);
  } else {
    const colon = trimmed.indexOf(":");
    tail = colon !== -1 ? trimmed.slice(colon + 1) : trimmed;
  }
  const last = tail.split("/").pop() ?? "";
  const name = last.endsWith(".git") ? last.slice(0, -".git".length) : last;
  return isProjectName(name) ? name : null;
}

/** Resolve a spec against the disk, or refuse it. Nothing is spawned here. */
export function planClone(p: Pewter, spec: CloneSpec): ClonePlan {
  const url = spec.url;
  // What a url has to be here is only "one argument git could take": git is
  // the authority on what it can fetch, and a pre-check that second-guessed
  // it would refuse things git accepts. Whitespace is the exception — it can
  // only be a quoting accident, and git's own error for it is opaque.
  if (typeof url !== "string" || url === "" || /\s/.test(url)) {
    throw new CloneError("bad_url", "clone needs a repository url", "https, ssh, or a local path — whatever your git can fetch");
  }
  const name = spec.name ?? deriveName(url);
  if (name === null) {
    throw new CloneError("bad_url", `cannot work out a project name from ${JSON.stringify(url)}`, "give it one: pewt repos clone <url> <name>");
  }
  if (!isProjectName(name)) {
    throw new CloneError("bad_name", `${JSON.stringify(name)} is not a project name`, "a project is a directory under repos/ — one path segment, not hidden");
  }
  const dest = path.join(p.repos, name);
  if (fs.existsSync(dest)) {
    throw new CloneError("exists", `there is already a project named ${name} in this pewter`, "pick another name: pewt repos clone <url> <name>");
  }
  return { url, name, dest, label: `repos.clone ${name}`, where: path.join("repos", name) };
}

/** The spec a session carries, read back out. Null when it is not a clone
 *  spec at all — the spawn policy sees every kind. */
export function asCloneSpec(spec: Readonly<Record<string, unknown>>): CloneSpec | null {
  const url = spec["url"];
  if (typeof url !== "string") return null;
  const name = spec["name"];
  return { url, ...(typeof name === "string" ? { name } : {}) };
}

/** A repaint becomes a frame at most this often. Chosen for a progress bar a
 *  human watches, not for fidelity nobody wants: git repaints far faster and
 *  a folder transport pays per frame. */
const PROGRESS_MS = 200;

/** How much of a line is kept before it is cut (run.ts's bound, same reason). */
const LINE_MAX = 64 * 1024;

/** The `repos.clone` session kind.
 *
 *  One session, one `git clone`. The client sends nothing after the spec: a
 *  clone that asks questions (credentials, host keys) is a clone that fails
 *  here — stdin is closed, so git errors instead of hanging on a prompt
 *  nobody can see. The message names the fix (ssh keys, a public url). */
export function cloneKind(p: Pewter, log: HostLogger): KindHandler {
  return (ctx: KindContext): KindSession => {
    const spec = asCloneSpec(ctx.spec);
    if (!spec) throw new CloneError("bad_params", "a clone session needs a url in its spec");
    // A failed spawn carries a message and nothing else, so the hint travels
    // inside the sentence or it does not travel at all (run.ts's shape).
    let plan: ClonePlan;
    try {
      plan = planClone(p, spec);
    } catch (e) {
      throw e instanceof CloneError && e.hint ? new CloneError(e.code, `${e.message} — ${e.hint}`) : e;
    }

    // `repos/` may not exist yet — a fresh pewter's first clone is the normal
    // first clone, and "mkdir it yourself first" would be a scaffold detail
    // promoted to an error.
    fs.mkdirSync(p.repos, { recursive: true });

    const child = spawn("git", ["clone", "--progress", plan.url, plan.dest], {
      cwd: p.root,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so the host can stop what it started (D6) —
      // git spawns helpers (ssh, credential managers) and they go with it.
      detached: true,
    });

    const say = (frame: RunFrame): void => ctx.write(JSON.stringify(frame));

    // git repaints progress with `\r` on stderr. A repaint replaces the one
    // before it, so only the newest is worth a frame — kept here and flushed
    // on a timer, while completed lines travel at once and drop the repaint
    // they finish ("Receiving objects: 100% …, done." supersedes every
    // "Receiving objects: n%" before it).
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
    const errLine = (line: string): void => {
      pendingProgress = null;
      say({ e: line });
    };
    const outLine = (line: string): void => say({ o: line });

    const err = crSplitter(errLine, repaint);
    const out = crSplitter(outLine, repaint);
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
      // A dead clone leaves no half-repo in the list (#189). Safe because the
      // plan refused an existing destination, so whatever is there now is
      // git's partial work and nobody's — git cleans up after its own
      // failures, but not after a SIGKILL.
      if (exitCode !== 0) fs.rmSync(plan.dest, { recursive: true, force: true });
      say({ end: exitCode });
      log.info(`${plan.label} → exit ${exitCode ?? "?"}${signal ? ` (${signal})` : ""}`);
      ctx.exit(exitCode);
    };
    // "close" rather than "exit": stdio is drained first, so git's last line
    // — which is where "Permission denied (publickey)" lives — still travels.
    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", (e) => {
      say({ e: `pewt: could not start git — ${e.message}` });
      finish(127, null);
    });

    log.info(`${plan.label} → git clone ${plan.url} ${plan.where}/ (pid ${child.pid ?? "?"})`);

    return {
      // What the client needs to print a header without asking again.
      result: { url: plan.url, name: plan.name, where: plan.where, childPid: child.pid ?? null },
      onClose: () => stopTree(child, done),
    };
  };
}

/** Bytes in; whole lines out one way, `\r` repaints the other. run.ts's
 *  splitter with one more boundary. Exported for the other child that
 *  paints: npm's spinner rides `\r` exactly as git's progress does
 *  (install.ts). */
export function crSplitter(onLine: (line: string) => void, onRepaint: (line: string) => void): { push(chunk: Buffer): void; flush(): void } {
  let buf = "";
  return {
    push(chunk: Buffer): void {
      buf += chunk.toString("utf8");
      for (;;) {
        const nl = buf.indexOf("\n");
        const cr = buf.indexOf("\r");
        if (nl === -1 && cr === -1) break;
        // The nearer boundary wins; `\r\n` is one boundary, not a repaint.
        if (nl !== -1 && (cr === -1 || nl < cr || cr === nl - 1)) {
          onLine(buf.slice(0, cr === nl - 1 ? cr : nl));
          buf = buf.slice(nl + 1);
        } else {
          const line = buf.slice(0, cr);
          buf = buf.slice(cr + 1);
          if (line !== "") onRepaint(line);
        }
      }
      if (buf.length > LINE_MAX) {
        onLine(buf.slice(0, LINE_MAX) + " …[cut: no newline in 64 KB]");
        buf = "";
      }
    },
    flush(): void {
      if (buf !== "") {
        onLine(buf);
        buf = "";
      }
    },
  };
}
