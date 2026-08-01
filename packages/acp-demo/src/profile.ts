// The Seatbelt profile for the ACP agent this demo spawns.
//
// It starts from terminal-demo's shell profile — same posture family, same
// last-match-wins discipline — and differs everywhere an agent is not a
// shell (#18's scope note: "a starting point, not a copy-paste"):
//
//  1. **State is a declared carve, per agent, or no carve at all.** A shell
//     writes its dotfiles wherever $HOME says; an agent's state dir is a
//     known thing with a known name (agents.ts), so the wall opens exactly
//     there and the profile *says which agent it opened for*. Where the
//     agent honors a placement variable, the carve is empty (R4/R17).
//  2. **No tty.** The child speaks NDJSON on a pipe. `/dev/tty*` is in the
//     shell profile because a shell is a terminal; here it would only let a
//     confused child draw on a terminal nobody is watching.
//  3. **No `/private/tmp`.** "Some tools hardcode /tmp" is a shell-tool
//     habit; the agent gets one scratch dir and is told about it (TMPDIR).
//
// What did NOT change is the load-bearing part, and it is worth saying
// plainly because the demo's safety sentence depends on it: this is a
// **write** wall (F24). The agent reads everything the user can read and
// talks to the network — it must, inference is remote — so the honest
// sentence is `profileSummary()` below, not "the agent is sandboxed".
//
// Parameters (passed by sandbox.ts via `-D`, all realpath'd — Seatbelt
// matches kernel-real paths):
//   ROOT — the shared directory (the folder the browser picked)
//   FSIO — ROOT/.fsio (the protocol area; host-owned, D6)
//   TMP  — the scratch dir the child gets as TMPDIR

/** SBPL string literal escaping for the paths embedded below. State dirs
 *  vary per agent, so they cannot be `-D` params (their count varies) —
 *  they are written into the profile text instead, which is strictly more
 *  inspectable (R1: the file in `.fsio/` is the whole policy). */
const sbplString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export interface AgentProfileInputs {
  /** absolute, realpath'd dirs the agent may write its own state into.
   *  Empty for a "place" posture — placement needs no hole in the wall. */
  stateDirs: string[];
  /** the agent name, for the comment that says who the carve is for. */
  agent: string;
}

export function agentProfile(inputs: AgentProfileInputs): string {
  const carves =
    inputs.stateDirs.length === 0
      ? `;; ...and nothing else: this agent's state is *placed* by env
;; (agents.ts), so the wall needs no hole for it.`
      : [
          `;; ...the state dirs ${inputs.agent} declares (agents.ts): its own`,
          `;; transcripts, session index, and — for an agent whose credential`,
          `;; lives beside its state — its identity. Named, not inferred.`,
          ...inputs.stateDirs.map((d) => `(allow file-write* (subpath ${sbplString(d)}))`),
        ].join("\n");
  return `(version 1)

;; acp-demo agent sandbox (fsio #18), agent: ${inputs.agent}.
;; Posture: read the world, write only the shared folder — minus the
;; protocol's own .fsio area — plus one scratch dir and this agent's own
;; state. Network is allowed: the agent's brain is remote.

;; Everything not about writing files: allowed (process-exec, network,
;; file-read*, signals, ...). The wall we hold is what the agent can MODIFY.
(allow default)

;; The wall: no file writes anywhere...
(deny file-write*)

;; ...except the shared folder — the folder the human granted the page, now
;; granted to the agent the page drives. That symmetry is the demo.
(allow file-write* (subpath (param "ROOT")))

;; ...one scratch dir, handed to the child as TMPDIR (env.ts),
(allow file-write* (subpath (param "TMP")))

;; ...the bit bucket (no /dev/tty: this child is on a pipe, not a terminal),
(allow file-write* (literal "/dev/null"))

${carves}

;; Final word (last match wins): the protocol area inside ROOT stays
;; host-owned even though ROOT is writable. An agent that could edit .fsio
;; could corrupt or spoof its own transport (D6) — including the frames
;; carrying the permission prompts the human is answering.
(deny file-write* (subpath (param "FSIO")))
`;
}

/** The one honest line (R15), for the banner and for the page's session
 *  header. Says what the wall does NOT bound, because F24 made that a MUST
 *  in the threat model: reads and network are unbounded. */
export function profileSummary(folderName: string, stateDirs: string[]): string {
  const state = stateDirs.length ? ` and its own state (${stateDirs.join(", ")})` : "";
  return `writes: ${folderName}/ (not .fsio), a scratch dir${state} — nothing else. reads: everything you can read. network: on.`;
}
