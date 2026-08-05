// `shell` — a terminal on your machine, from a tab or from a terminal.
//
// There is no session kind in this file, and that is the decision worth
// knowing: a shell is @fsio/host's own kind. The library already has the pty,
// the resize plumbing, and the ack window that keeps a chatty command from
// drowning the folder — the last of which a registered kind cannot have,
// because pause/resume has no hook in the kind API. `run` earned its own kind
// (it resolves an npm script and ends with an in-band frame); re-implementing
// a pty on top of one would be a rewrite of the wrong thing.
//
// What is here is the half the library leaves to the embedder: working out
// what a shell request means in this pewter, so the host's question can show
// it and the policy can refuse it.
//
// The library's spec is the wire form, so `--repo site` becomes `cwd:
// "repos/site"` on the client (packages/pewter/src/shell.ts) rather than on
// the host. That is the one asymmetry with `run`, and it is why this file
// reads the *resolved* command the policy hands it instead of parsing a spec.
import fs from "node:fs";
import path from "node:path";
import { repoOfCwd } from "pewter";
import type { Pewter } from "./pewter.js";

/** A shell request, worked out against the disk: what the question needs and
 *  what the log line needs. */
export interface ShellPlan {
  /** the program that would run — `$SHELL`, or whatever the spec named. */
  cmd: string;
  /** absolute working directory, already contained by the host (D22). */
  cwd: string;
  /** `cwd`, relative to the pewter — what a human recognizes. */
  where: string;
  /** how the request reads in one line: `shell --repo site`. */
  label: string;
  /** false when node-pty is missing and this would be pipes, not a terminal.
   *  Worth saying out loud in the question: a shell without a pty has no job
   *  control, no prompt redraw, and no `vim`. */
  pty: boolean;
}

/** The shell cannot start, and this is the sentence saying why. */
export class ShellError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "ShellError";
  }
}

/** What the policy hook is told about a spawn, narrowed to the fields a
 *  shell has. Declared rather than imported so this file does not depend on
 *  the host's whole surface to read four strings. */
export interface ResolvedShell {
  cmd?: string | undefined;
  cwd?: string | undefined;
  pty?: boolean | undefined;
}

/** Resolve a shell request against the disk, or refuse it.
 *
 *  The host has already contained `cwd` inside the folder, so what is left to
 *  check is whether it is a project at all. A pty spawned into a directory
 *  that does not exist fails somewhere inside node-pty and arrives as a dead
 *  terminal; refusing it here makes it a sentence instead. */
export function planShell(p: Pewter, spec: Readonly<Record<string, unknown>>, resolved: ResolvedShell): ShellPlan {
  const cwd = resolved.cwd ?? p.root;
  const asked = typeof spec["cwd"] === "string" ? (spec["cwd"] as string) : undefined;
  const repo = repoOfCwd(asked);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw new ShellError(
      repo ? "no_repo" : "no_cwd",
      repo ? `no project named ${repo} in this pewter` : `${where(p, cwd)} is not a directory in this pewter`,
      "a project is a directory under repos/ — `pewt repos` lists them"
    );
  }
  if (!stat.isDirectory()) {
    throw new ShellError("no_cwd", `${where(p, cwd)} is a file, and a shell needs a directory`);
  }

  return {
    cmd: resolved.cmd ?? process.env["SHELL"] ?? "/bin/bash",
    cwd,
    where: where(p, cwd),
    // `--repo site` is the spelling both front ends offer, so it is the one
    // the question shows back. A spec written by hand can name any directory
    // in the folder, and that one says where instead of pretending to a flag
    // nobody typed.
    label: repo ? `shell --repo ${repo}` : cwd === p.root ? "shell" : `shell in ${where(p, cwd)}/`,
    pty: resolved.pty !== false,
  };
}

/** A path a human recognizes: relative to the pewter, or the pewter itself. */
function where(p: Pewter, dir: string): string {
  const rel = path.relative(p.root, dir);
  return rel === "" ? p.name : rel;
}
