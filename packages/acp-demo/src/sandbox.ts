// Spawning the agent: pipes, not a pty, wrapped in `sandbox-exec`.
//
// terminal-demo wraps a *PtyModule* because a terminal needs a terminal.
// ACP needs the opposite (#18): clean pipes, because a pty echoes input and
// translates newlines, and newline-delimited JSON does not survive either.
// So this is a plain `child_process.spawn` with `stdio: ["pipe","pipe","pipe"]`
// and the same sandbox-exec prefix.
//
// Fail-closed, like `deadPty` before it (R3): if the profile is missing or
// `sandbox-exec` is not there, this throws. Nothing here silently degrades
// to an unconfined agent — a thrown handler fails the spawn with `1002`
// (D13), which the page renders as a refusal. Confinement is also reported
// as a session fact (`sandboxed` in the spawn result) rather than assumed
// by the page.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import type { Readable, Writable } from "node:stream";

export interface SandboxConfig {
  /** absolute path to the written profile (ROOT/.fsio/agent.sb). */
  profilePath: string;
  /** realpath of the shared directory. */
  root: string;
  /** realpath of ROOT/.fsio. */
  fsio: string;
  /** realpath of the child's scratch dir (its TMPDIR). */
  tmp: string;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Build the argv prefix; exported so tests exercise the exact invocation
 *  sessions use (no drift — same reasoning as terminal-demo's). */
export function sandboxArgv(cfg: SandboxConfig, file: string, args: string[]): { file: string; args: string[] } {
  return {
    file: SANDBOX_EXEC,
    args: ["-f", cfg.profilePath, "-D", `ROOT=${cfg.root}`, "-D", `FSIO=${cfg.fsio}`, "-D", `TMP=${cfg.tmp}`, file, ...args],
  };
}

export type AgentProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export interface SpawnAgentOptions {
  file: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** null runs the agent unconfined — only legal when the caller has said
   *  so out loud (tests, non-macOS), and always reported to the page. */
  sandbox: SandboxConfig | null;
}

export function spawnAgent(opts: SpawnAgentOptions): AgentProcess {
  let file = opts.file;
  let args = opts.args;
  if (opts.sandbox) {
    // Cheap invariants first: a missing profile or sandbox-exec would
    // otherwise surface as an unexplained child exit.
    fs.accessSync(opts.sandbox.profilePath, fs.constants.R_OK);
    fs.accessSync(SANDBOX_EXEC, fs.constants.X_OK);
    ({ file, args } = sandboxArgv(opts.sandbox, file, args));
  }
  return spawn(file, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as AgentProcess;
}
