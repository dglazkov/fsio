// The Seatbelt profile for the ACP agent this demo spawns.
//
// The wall is @fsio/confine's — the same one terminal-demo uses. What is
// here is where an agent's posture differs from a shell's (#18's scope note:
// "a starting point, not a copy-paste"):
//
//  1. **State is a declared carve, per agent, or no carve at all.** A shell
//     writes its dotfiles wherever $HOME says; an agent's state dir is a
//     known thing with a known name (agents.ts), so the wall opens exactly
//     there and the profile *says which agent it opened for*. Where the
//     agent honors a placement variable, there is no carve at all.
//  2. **No tty.** The child speaks NDJSON on a pipe. terminal-demo's profile
//     carves `/dev/tty*` because a shell is a terminal; here it would only
//     let a confused child draw on a terminal nobody is watching.
//  3. **No `/private/tmp`.** "Some tools hardcode /tmp" is a shell-tool
//     habit, so terminal-demo opens it wholesale. An agent gets one scratch
//     dir and is told about it (TMPDIR) — and where that turned out not to
//     be enough, the hole is a measured shape rather than a subtree (F30).
//
// What did NOT change is the load-bearing part, and it is worth saying
// plainly because the demo's safety sentence depends on it: this is a
// **write** wall. The agent reads everything the user can read and
// talks to the network — it must, inference is remote — so the honest
// sentence is @fsio/confine's `profileSummary`, not "the agent is
// sandboxed".
import { sandboxProfile, type Carve } from "@fsio/confine";

export interface AgentProfileInputs {
  /** absolute, realpath'd dirs the agent may write its own state into.
   *  Empty for a "place" posture — placement needs no hole in the wall. */
  stateDirs: string[];
  /** the agent name, for the comment that says who the carve is for. */
  agent: string;
  /** absolute, realpath'd scratch dirs outside $HOME that the agent's own
   *  tooling hardcodes (F30). A separate carve from `stateDirs` on purpose:
   *  this is not the agent's state, it is a place its tools insist on, and
   *  the profile should not blur the two when a human reads it. */
  scratchDirs?: string[];
  /** SBPL regexes for individual scratch files with unpredictable names
   *  (F30). A filename shape, never a subtree. */
  scratchPatterns?: string[];
}

export function agentProfile(inputs: AgentProfileInputs): string {
  const carves: Carve[] = [];

  carves.push(
    inputs.stateDirs.length === 0
      ? {
          why: `...and nothing else: this agent's state is *placed* by env
(agents.ts), so the wall needs no hole for it.`,
        }
      : {
          why: `...the state dirs ${inputs.agent} declares (agents.ts): its own
transcripts, session index, and — for an agent whose credential lives
beside its state — its identity. Named, not inferred.`,
          dirs: inputs.stateDirs,
        }
  );

  if (inputs.scratchDirs?.length) {
    carves.push({
      why: `...and the scratch dirs ${inputs.agent}'s own tooling hardcodes.
F30: this agent's Bash tool mkdirs a per-workspace dir under /tmp and does
NOT read TMPDIR, so denying /private/tmp broke every Bash call at setup.
One workspace's dir, never the /tmp/claude-<uid> root — that root holds an
entry per workspace on this machine.`,
      dirs: inputs.scratchDirs,
    });
  }

  if (inputs.scratchPatterns?.length) {
    carves.push({
      why: `...and the scratch FILES it names at random, matched by shape.
F30: every Bash call writes /tmp/claude-<random>-cwd. Denying it does not
stop the command — stdout arrives — but the shell exits 1, so the agent is
told every command failed: a denial that names the wrong cause. One
filename shape, never a subtree.`,
      patterns: inputs.scratchPatterns,
    });
  }

  return sandboxProfile({
    subject: `acp-demo agent sandbox (fsio #18), agent: ${inputs.agent}.`,
    posture: `Posture: read the world, write only the shared folder — minus the
protocol's own .fsio area — plus one scratch dir and this agent's own
state. Network is allowed: the agent's brain is remote.`,
    carves,
  });
}
