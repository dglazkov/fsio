// The child's environment, synthesized rather than inherited.
//
// terminal-demo hands a shell `process.env` and then steers three variables
// out of $HOME. That is right for a shell — the user is sitting at it, and
// their environment is the thing they asked for. It is wrong for an agent:
// nobody is watching, the child talks to the network by design, and full
// inheritance was measured to carry the whole environment, including
// `SSH_AUTH_SOCK` (packages/confine/MEASUREMENTS.md).
//
// So this helper does what #86's env program (R4/R17) says: **synthesize,
// place, then add by exact name.** The floor below is the measured one
// (MEASUREMENTS.md) —
// eight variables ran an agent CLI identically to 48-variable inheritance —
// and it was re-measured here against a second subject: pi-acp completes
// `initialize` + `session/new` under exactly these eight (2026-08-01).
//
// This is a smaller reach than the terminal demo grants, on purpose: a
// sandbox bounds what a child may *write*, and the environment bounds what
// it is *handed*. Only the second one can withhold a socket.
import os from "node:os";
import type { AgentEntry } from "./agents.js";

/** The measured floor: PATH/HOME/TERM/LANG/USER/LOGNAME/SHELL/TMPDIR. */
export const ENV_FLOOR = ["PATH", "HOME", "TERM", "LANG", "USER", "LOGNAME", "SHELL", "TMPDIR"] as const;

export interface EnvInputs {
  /** the TMPDIR the child gets (the profile makes it writable). */
  tmp: string;
  /** for a "place" posture: the dir the agent's state env var points at. */
  stateDir?: string;
  /** the environment to draw floor values from (tests pass their own). */
  from?: NodeJS.ProcessEnv;
}

/** Build the child's env: the floor, the agent's declared extras, and the
 *  placement variable when the agent's posture is "place". Nothing else —
 *  in particular nothing the page said, since the page contributes no env
 *  at all (an env var is an argument by another name). */
export function synthesizeEnv(entry: AgentEntry, inputs: EnvInputs): Record<string, string> {
  const src = inputs.from ?? process.env;
  const env: Record<string, string> = {};
  for (const name of ENV_FLOOR) {
    const v = src[name];
    if (v !== undefined) env[name] = v;
  }
  env["TMPDIR"] = inputs.tmp;
  // An agent is not sitting at a terminal; anything it renders for a tty is
  // noise on a pipe (and CRLF on a pipe is how NDJSON gets mangled).
  env["TERM"] = "dumb";
  env["HOME"] ??= os.homedir();
  Object.assign(env, entry.env ?? {});
  if (entry.state.mode === "place") {
    if (!inputs.stateDir) throw new Error(`agent ${entry.name} needs a state dir (posture "place")`);
    env[entry.state.env] = inputs.stateDir;
  }
  return env;
}
