// Spawning the agent: pipes, not a pty, wrapped in `sandbox-exec`.
//
// terminal-demo wraps a *PtyModule* because a terminal needs a terminal.
// ACP needs the opposite (#18): clean pipes, because a pty echoes input and
// translates newlines, and newline-delimited JSON does not survive either.
// So this is a plain `child_process.spawn` with `stdio: ["pipe","pipe","pipe"]`
// and @fsio/confine's sandbox-exec prefix.
//
// What is left here after the extraction is this demo's *failure policy*,
// which is the opposite of terminal-demo's and is why neither one moved into
// the library: if the profile is missing or `sandbox-exec` is not there,
// this throws. Nothing here silently degrades to an unconfined agent — a
// thrown handler fails the spawn with `1002` (D13), which the page renders
// as a refusal. Confinement is also reported as a session fact (`sandboxed`
// in the spawn result) rather than assumed by the page.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { assertSandboxUsable, sandboxArgv, type SandboxConfig } from "@fsio/confine";

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
    assertSandboxUsable(opts.sandbox);
    ({ file, args } = sandboxArgv(opts.sandbox, file, args));
  }
  return spawn(file, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as AgentProcess;
}
