// The agent allow-list (#18, #6): the page names an agent, never a path.
//
// A spawn spec carries `{kind: "acp", agent: "pi-acp"}` — a *name*, looked
// up here. Nothing a page sends becomes argv. That is the whole point of an
// allow-list, and it is the first entry #6's allow-list thinking asked for:
// the browser can start the agents this helper knows about, in the folder
// the human granted, and nothing else.
//
// Each entry also declares its **state posture**, which is not decoration.
// F26 measured that a child's state and its *identity* are different things
// and may live in different places, so the posture is per-agent fact, not a
// policy this helper can guess:
//
//   - "place"  — the agent honors an env var pointing at its state dir, so
//     the profile needs no carve at all (R4/R17: placement, not carve-out).
//   - "carve"  — the agent's state dir is also where its credential lives,
//     so placing it into an empty slot would log the child out (F26's
//     lesson, second instance). The profile opens exactly those dirs.
//
// Measured for pi-acp, 2026-08-01, under this demo's profile: with no carve,
// `initialize` succeeds and **`session/new` fails** with a JSON-RPC -32603
// whose message is "Cannot call write after a stream was destroyed" — a
// denial that is legible (R9) and wrong about its cause (R19). With
// `~/.pi` carved, the same run completes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where an agent's state (transcripts, session index, credentials) goes. */
export type StatePosture =
  | {
      mode: "place";
      /** env var → subdirectory name inside the helper's state area. */
      env: string;
      /** one honest line, shown in the page and the banner (R15). */
      why: string;
    }
  | {
      mode: "carve";
      /** $HOME-relative dirs the profile makes writable. Nothing outside
       *  $HOME is expressible here on purpose. */
      homeDirs: string[];
      why: string;
    };

export interface AgentEntry {
  /** the name a page may ask for. */
  name: string;
  /** binary to look up on PATH — never taken from the wire. */
  bin: string;
  /** fixed args; the page contributes none. */
  args: string[];
  /** human-facing one-liner for the wizard/banner. */
  title: string;
  state: StatePosture;
  /** extra env this agent needs beyond the measured floor (env.ts). */
  env?: Record<string, string>;
}

export const AGENTS: AgentEntry[] = [
  {
    name: "pi-acp",
    bin: "pi-acp",
    args: [],
    title: "pi coding agent (ACP adapter)",
    state: {
      mode: "carve",
      homeDirs: [".pi"],
      why: "pi keeps its credential (auth.json) beside its session history in ~/.pi; placing the state would place the identity too, and the agent would come up logged out (F26).",
    },
  },
  {
    // The Zed adapter for the Claude Code CLI. Not exercised by this
    // repo's tests — listed because it is the other posture, and F26
    // measured its state placement directly: CLAUDE_CONFIG_DIR moves the
    // whole tree with zero denials, while the credential stays in the login
    // Keychain (reachable here only because the profile is `allow default`).
    name: "claude-code-acp",
    bin: "claude-code-acp",
    args: [],
    title: "Claude Code (ACP adapter)",
    state: {
      mode: "place",
      env: "CLAUDE_CONFIG_DIR",
      why: "the CLI's whole state tree follows CLAUDE_CONFIG_DIR (F26); its credential lives in the login Keychain and is not placeable.",
    },
  },
];

export const agentNames = (agents: AgentEntry[] = AGENTS): string[] => agents.map((a) => a.name);

/** Look up a name from the wire. Returns null for anything not listed —
 *  callers turn that into a spawn failure the page can render. */
export function findAgent(name: unknown, agents: AgentEntry[] = AGENTS): AgentEntry | null {
  if (typeof name !== "string") return null;
  return agents.find((a) => a.name === name) ?? null;
}

/** Resolve `bin` against PATH ourselves rather than relying on the spawn to
 *  fail: a missing agent is an operator condition with an obvious fix, and
 *  it should be reported at helper startup, not inside a sandboxed child
 *  whose stderr the page barely sees. Absolute paths in an entry are used
 *  as-is (tests point entries at a fixture). */
export function resolveBin(entry: AgentEntry): string | null {
  if (entry.bin.includes(path.sep)) return isExec(entry.bin) ? entry.bin : null;
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, entry.bin);
    if (isExec(candidate)) return candidate;
  }
  return null;
}

function isExec(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The $HOME-relative dirs a "carve" posture needs, realpath'd (Seatbelt
 *  matches kernel-real paths). Dirs that do not exist are dropped: an agent
 *  that has never run has nothing to protect, and a `-D` param pointing at
 *  a missing path is a profile that fails to compile. */
export function carveDirs(entry: AgentEntry, home: string = os.homedir()): string[] {
  if (entry.state.mode !== "carve") return [];
  const out: string[] = [];
  for (const rel of entry.state.homeDirs) {
    const abs = path.join(home, rel);
    try {
      out.push(fs.realpathSync(abs));
    } catch {}
  }
  return out;
}
