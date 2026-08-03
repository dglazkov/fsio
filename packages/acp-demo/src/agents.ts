// The agent allow-list (#18, #6): the page names an agent, never a path.
//
// A spawn spec carries `{kind: "acp", agent: "pi-acp"}` — a *name*, looked
// up here. Nothing a page sends becomes argv. That is the whole point of an
// allow-list, and it is the first entry #6's allow-list thinking asked for:
// the browser can start the agents this helper knows about, in the folder
// the human granted, and nothing else.
//
// Each entry also declares its **state posture**, which is not decoration.
// MEASUREMENTS.md found that a child's state and its *identity* are
// different things and may live in different places, so the posture is a
// per-agent fact, not a policy this helper can guess:
//
//   - "place" — the agent honors an env var pointing at its state dir, so
//     the helper hands it one.
//   - "own"   — the agent's state dir is also where its credential lives, so
//     placing it into an empty slot would log the child out
//     (MEASUREMENTS.md, second instance). Leave it where it is.
//
// Nothing here is vendored, and that has not changed
// ([#100](https://github.com/dglazkov/fsio/issues/100)): shipping an adapter
// was measured at +118 MB and +115 transitive packages against a 164 MB
// tree, for a demo that exists to show a small protocol. So this file stays
// a list of *names and npm coordinates*, never a dependency set, and an
// agent arrives on the machine only because somebody asked for it.
//
// What did change is who does the typing (#124). This file used to say the
// install was "installed by the human, never by us — installing software is
// their gesture to make (P3/P5)", and the second half of that sentence was
// doing work the first half did not need. The gesture is still theirs: the
// helper finds nothing installed, says what it would install and what it
// costs, and waits for a `y` on a terminal. What it no longer does is make
// them carry a command to a second terminal to prove it. The enforcer is the
// person at the keyboard — who predates this software and gains nothing from
// it, which is the whole of P5 — and the rung stays distinct and revocable
// in P3's sense, because the install has an address (`~/.fsio/agents/<name>`)
// rather than disappearing into PATH. `install.ts` holds the argument; the
// only thing this file owes it is the coordinates.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { managedBin } from "./install.js";

/** Where an agent's state (transcripts, session index, credentials) goes. */
export type StatePosture =
  | {
      mode: "place";
      /** env var → subdirectory name inside the helper's state area. */
      env: string;
      /** one honest line, shown in the page and the banner: a posture has
       *  to be describable to a third party in a sentence. */
      why: string;
    }
  | {
      /** Leave the agent's state where the agent already puts it.
       *
       *  Named for what it does rather than for what it used to require: it
       *  was "carve", because a Seatbelt profile had to open a hole for
       *  those dirs. The demo no longer confines anything, and a mode named
       *  after a mechanism that is gone is a false lead for whoever reads it
       *  next. What survives is the reason the posture exists at all, which
       *  never was about the wall: placing an agent's state can move its
       *  *identity* with it and log it out (MEASUREMENTS.md). */
      mode: "own";
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
  /** Where this agent comes from, pinned.
   *
   *  The reason changed when the sandbox went. It used to be a correctness
   *  requirement: the profile was built out of measurements against one
   *  release (F30), so "latest" would have made the wall a set of claims
   *  about software nobody guaranteed the user had. There is no profile now,
   *  and that argument is spent — recorded here rather than quietly left
   *  standing, because a stale reason reads exactly like a live one.
   *
   *  What is left is reproducibility, which is weaker and still worth it:
   *  everyone who takes the helper's offer gets the same agent, `asks` stays
   *  a measured claim about a known build rather than about whatever shipped
   *  this morning, and a bug report names a version. The cost is that a
   *  pinned copy ages until somebody bumps it, with nothing here to notice.
   *
   *  Absent for entries that are not npm packages — the puppet is built with
   *  this repo. */
  pkg?: { name: string; version: string };
  /** How to get it by hand, printed verbatim when this machine does not have
   *  it. Derived from `pkg` when absent (see `installLine`) — the two must
   *  not be able to drift, or the line we print and the install we run stop
   *  being the same software. */
  install?: string;
  /** Does this agent send `session/request_permission` before it edits?
   *
   *  Measured, never assumed — and the reason the roster exists at all
   *  (#102). This demo's headline is that the agent's consent question
   *  becomes page UI, and **the default agent does not ask**: #100
   *  counted 0 permission requests and 0 `fs/*` calls from pi-acp across a
   *  driven session, because it reads and edits with its own hands. F30
   *  counted them from the Claude adapter, which does ask. A human choosing
   *  between the two is choosing whether the demo's own argument fires, so
   *  the page says so before they pick. */
  asks: boolean;
  state: StatePosture;
  /** extra env this agent needs beyond the measured floor (env.ts). */
  env?: Record<string, string>;
  /** The entry the helper offers to install when this machine has none
   *  (#124). At most one; the reason is on the entry that sets it. */
  recommended?: boolean;
}

/** What to type to get this agent by hand. Pinned to the same version the
 *  helper would install, so the two paths land on the same software — an
 *  unpinned printed line and a pinned automatic one is a support question
 *  waiting to happen. */
export const installLine = (a: AgentEntry): string =>
  a.install ?? (a.pkg ? `npm i -g ${a.pkg.name}@${a.pkg.version}` : "");

export const AGENTS: AgentEntry[] = [
  {
    name: "pi-acp",
    bin: "pi-acp",
    args: [],
    title: "pi coding agent (ACP adapter)",
    // 0.0.32: the version MEASUREMENTS.md measured, for the same reason the
    // entry below pins F30's. Not latest.
    pkg: { name: "pi-acp", version: "0.0.32" },
    // The demo's default subject: one small package, and model-agnostic —
    // which keeps the page an *ACP* client rather than a client of any one
    // vendor's agent. Caveat worth knowing before you drive it: pi reads and
    // edits with its own hands, so it never sends `session/request_permission`
    // or `fs/*` (#100). What it exercises is the transport, the framing, the
    // confinement facts and the live workspace — not the consent surface.
    // #100: 0 `session/request_permission`, 0 `fs/*` across a driven session.
    asks: false,
    state: {
      mode: "own",
      why: "pi keeps its credential (auth.json) beside its session history in ~/.pi; placing the state would place the identity too, and the agent would come up logged out (MEASUREMENTS.md).",
    },
  },
  {
    // The Claude Code ACP adapter. Not exercised by this repo's tests —
    // listed because it is the other posture, and MEASUREMENTS.md measured
    // its state placement directly: CLAUDE_CONFIG_DIR moves the whole tree
    // with zero denials, while the credential stays in the login Keychain
    // (reachable here only because the profile is `allow default`).
    //
    // Renamed since that was measured (checked 2026-08-01): the package
    // `@zed-industries/claude-code-acp` (0.16.2, bin `claude-code-acp`) is
    // deprecated in favour of `@agentclientprotocol/claude-agent-acp`
    // (0.64.0, bin `claude-agent-acp`). The name here is the new one; an
    // entry pointing at a deprecated package is an entry that will quietly
    // stop matching what people install.
    //
    // Unlike pi-acp this one *does* send `session/request_permission`, which
    // is why it is the standing answer to #100 for anyone who wants to see
    // the consent question fire against a real agent — and why it is the one
    // the helper offers to install when a machine has none (`recommended`
    // below). It needs its own Claude credential either way.
    name: "claude-agent-acp",
    bin: "claude-agent-acp",
    args: [],
    title: "Claude Code (ACP adapter)",
    // **0.64.0 because that is the version F30 measured**, not because it is
    // the newest — npm was already offering 0.64.2 when this was written,
    // and taking it would have been "install whatever is current" wearing a
    // pin's clothing. The profile below is a set of claims about one
    // release; the pin's whole job is to make those claims true of the copy
    // that actually runs. Bumping it means re-measuring F30 first.
    //
    // Install measured 2026-08-02 against this exact version: 111 packages,
    // 293 MB (260 MB of it the bundled Claude Code CLI), ~3 s, and
    // `--ignore-scripts` produces a byte-identical tree (install.ts).
    pkg: { name: "@agentclientprotocol/claude-agent-acp", version: "0.64.0" },
    /** The one a machine with no agent is offered. It asks before it edits,
     *  and the consent card is what this demo is *for* — offering the other
     *  one would install an agent that never fires the surface the human came
     *  to look at (#100, F30). */
    recommended: true,
    // F30: it asks, and the page renders the card with the file named and
    // three options. Caveat the roster cannot carry and the page copy must:
    // only in manual permission mode, which is inherited from the
    // operator's own Claude Code config.
    asks: true,
    // Was "place" until it was actually run (F30, 2026-08-01). Placement
    // moves the state tree perfectly — fresh config, `sessions/`,
    // `projects/`, zero denials — and the agent still cannot log in, because
    // login is *two* pieces in two places: the token in the login Keychain
    // (reachable; the profile is `allow default`) and the account binding
    // `oauthAccount` inside `~/.claude.json`. Placement replaces that file
    // with an empty one, so the child holds a key and does not know which
    // lock it fits: `session/prompt` fails "Authentication required".
    //
    // That is MEASUREMENTS.md's headline reaching its conclusion. Two agents
    // out of two keep identity and state inseparable (pi in subject 2, claude
    // here), so a placed host-owned slot is the nicer design for a kind of
    // agent neither of ours is. Leave both alone, and say why.
    state: {
      mode: "own",
      why: "the CLI's token is in the login Keychain but its account binding is in ~/.claude.json, so a placed config dir authenticates as nobody (F30); its state stays in ~/.claude where it puts it.",
    },
  },
];

export const agentNames = (agents: AgentEntry[] = AGENTS): string[] => agents.map((a) => a.name);

/** One roster line as the page sees it (#102).
 *
 *  Prose and names only. This rides `services.json`, which one file serves
 *  every granted origin (D24), so **no paths** — not the resolved binary,
 *  not a state dir. The page needs to know *that* an agent is here and what
 *  it will do, never where it lives. */
export interface RosterEntry {
  name: string;
  title: string;
  /** printed verbatim when `installed` is false: the other way to get it,
   *  for anyone who would rather type it themselves or put it on PATH. */
  install: string;
  installed: boolean;
  asks: boolean;
  /** Which copy the page would be driving (#124). Two can exist at once —
   *  someone with a global install who also answered `y` here — and a demo
   *  that silently ran the other one is a debugging trap. A word, never a
   *  path: this rides `services.json`, which one file serves every granted
   *  origin (D24). */
  via: "PATH" | "fsio" | null;
}

/** What this machine can actually serve, right now.
 *
 *  Discovery is exactly this: **enumerate the allow-list and check whether
 *  each entry is present.** It never scans PATH for unknown executables and
 *  offers them — the allow-list is the boundary (#6, P3), and a chooser
 *  full of things that merely look like agents is a remote-controlled exec
 *  surface with a friendly face.
 *
 *  Cheap enough to call on a timer: one `access()` per entry per directory
 *  on PATH. That is what lets an agent installed while the helper is
 *  running appear in the page without a restart — the service directory
 *  only republishes when the content actually changes (D24). */
export function roster(agents: AgentEntry[] = AGENTS): RosterEntry[] {
  return agents.map((a) => {
    const found = resolve(a);
    return {
      name: a.name,
      title: a.title,
      install: installLine(a),
      installed: found !== null,
      asks: a.asks,
      via: found?.via ?? null,
    };
  });
}

/** Look up a name from the wire. Returns null for anything not listed —
 *  callers turn that into a spawn failure the page can render. */
export function findAgent(name: unknown, agents: AgentEntry[] = AGENTS): AgentEntry | null {
  if (typeof name !== "string") return null;
  return agents.find((a) => a.name === name) ?? null;
}

/** Resolve `bin` ourselves rather than relying on the spawn to fail: a
 *  missing agent is an operator condition with an obvious fix, and it should
 *  be reported at helper startup, not inside a sandboxed child whose stderr
 *  the page barely sees. Absolute paths in an entry are used as-is (tests
 *  point entries at a fixture).
 *
 *  **PATH wins over `~/.fsio/agents`** (#124), and the order is the whole
 *  rule, so it is worth its reason. Two copies can only coexist when someone
 *  installed one globally *after* answering `y` here — this helper never
 *  offers to install what it can already find. In that situation the global
 *  one is the deliberate, later act, usually made precisely to get a
 *  different version; ours is the fallback we created when the machine had
 *  nothing. A fallback that outranked a human's own install would make the
 *  fix look broken. The roster reports which copy won either way, because
 *  running the one nobody expected is worse than either choice. */
export function resolve(entry: AgentEntry): { bin: string; via: "PATH" | "fsio" } | null {
  if (entry.bin.includes(path.sep)) return isExec(entry.bin) ? { bin: entry.bin, via: "PATH" } : null;
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, entry.bin);
    if (isExec(candidate)) return { bin: candidate, via: "PATH" };
  }
  const managed = managedBin(entry);
  if (managed && isExec(managed)) return { bin: managed, via: "fsio" };
  return null;
}

/** Just the path, for the callers that only need to spawn it. */
export const resolveBin = (entry: AgentEntry): string | null => resolve(entry)?.bin ?? null;

function isExec(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
