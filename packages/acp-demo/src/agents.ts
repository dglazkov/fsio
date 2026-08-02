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
//   - "place"  — the agent honors an env var pointing at its state dir, so
//     the profile needs no carve at all (placement, not carve-out).
//   - "carve"  — the agent's state dir is also where its credential lives,
//     so placing it into an empty slot would log the child out
//     (MEASUREMENTS.md, second instance). The profile opens exactly those
//     dirs.
//
// Measured for pi-acp, 2026-08-01, under this demo's profile: with no carve,
// `initialize` succeeds and **`session/new` fails** with a JSON-RPC -32603
// whose message is "Cannot call write after a stream was destroyed" — a
// denial that is legible — the agent can relay it — and wrong about its
// cause. With
// `~/.pi` carved, the same run completes.
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
  /** Where this agent comes from, pinned.
   *
   *  The pin is not caution, it is a correctness requirement: this file
   *  builds `claude-agent-acp`'s sandbox profile out of measurements against
   *  one specific release — the `~/.claude` carve, the
   *  `/tmp/claude-{uid}/{cwdSlug}` scratch dir, the random-hex `-cwd` marker
   *  regex (F30). Installing whatever npm calls latest would make the
   *  profile a set of claims about software nobody guaranteed the user has,
   *  and the skew would present as a sandbox bug.
   *
   *  It cuts both ways and the banner says so: a pinned copy will eventually
   *  be older than what npm would hand you today, with nothing here to
   *  notice. The version is printed at install so the number is at least
   *  never a secret.
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
  /** Absolute dirs **outside $HOME** the agent must be able to write, beyond
   *  its own state. `StatePosture` deliberately cannot express these — it is
   *  $HOME-relative on purpose — and the reason this exists anyway is F30:
   *  the Claude adapter's Bash tool creates a per-workspace scratch dir at
   *  `/tmp/claude-<uid>/<cwd-with-slashes-as-dashes>/` and **does not read
   *  TMPDIR**, so a profile that denies `/private/tmp` breaks every Bash
   *  call at setup — which also takes out Glob and Grep.
   *
   *  Templates, resolved by `scratchDirs()`: `{uid}` and `{cwdSlug}`. Note
   *  the slug is required: `/tmp/claude-<uid>` holds one entry per workspace
   *  on the machine, so granting the root would let a confined agent write
   *  into unrelated sessions' scratch state.
   *
   *  Measured, never guessed. An entry here is a hole in the wall and has to
   *  earn it by naming the run that proved it necessary. */
  scratch?: string[];
  /** SBPL regexes for individual scratch *files* whose names the agent picks
   *  at random, so no subpath template can name them (F30). Static, ours,
   *  never from the wire — a page contributes nothing here, same rule as
   *  `bin` and `args`.
   *
   *  Measured for claude-agent-acp: every Bash call writes a cwd marker at
   *  `/tmp/claude-<random hex>-cwd`, directly in /tmp rather than under the
   *  workspace dir. Denying it does not stop the command — stdout arrives
   *  intact — but zsh exits 1, so the agent is told every command it ran
   *  failed. A tool that lies about its own success is worse than one that
   *  is blocked outright — a denial that names the wrong cause. */
  scratchPatterns?: string[];
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
    pkg: { name: "pi-acp", version: "0.0.33" },
    // The demo's default subject: one small package, and model-agnostic —
    // which keeps the page an *ACP* client rather than a client of any one
    // vendor's agent. Caveat worth knowing before you drive it: pi reads and
    // edits with its own hands, so it never sends `session/request_permission`
    // or `fs/*` (#100). What it exercises is the transport, the framing, the
    // confinement facts and the live workspace — not the consent surface.
    // #100: 0 `session/request_permission`, 0 `fs/*` across a driven session.
    asks: false,
    state: {
      mode: "carve",
      homeDirs: [".pi"],
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
    // 0.64.2, checked 2026-08-02. Install measured the same day: 111
    // packages, 293 MB (260 MB of it the bundled Claude Code CLI), ~3 s,
    // and `--ignore-scripts` produces a byte-identical tree (install.ts).
    pkg: { name: "@agentclientprotocol/claude-agent-acp", version: "0.64.2" },
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
    // out of two now keep identity and state inseparable (pi in subject 2,
    // claude here),
    // so a placed host-owned slot is the nicer design for a kind of agent
    // neither of ours is. Carve, and say why.
    //
    // Note the carve does NOT cover `~/.claude.json` — that is a file beside
    // the dir, not in it. Auth works anyway because it only needs to *read*
    // it, and reads were never bounded. The write wall is exactly what makes
    // this posture viable; the read wall priced in @fsio/confine's
    // MEASUREMENTS.md would break it.
    state: {
      mode: "carve",
      homeDirs: [".claude"],
      why: "the CLI's token is in the login Keychain but its account binding is in ~/.claude.json, so a placed config dir authenticates as nobody (F30); ~/.claude is carved for its state, and the account file is only ever read.",
    },
    // F30: its Bash tool mkdirs this and ignores TMPDIR. One workspace's
    // slug, not the `/tmp/claude-<uid>` root — that root holds an entry per
    // workspace on the machine.
    scratch: ["/tmp/claude-{uid}/{cwdSlug}"],
    // Per-Bash-call cwd marker, random name, straight in /tmp (F30). Scoped
    // to that exact filename shape: this is a file rule, not a subtree.
    scratchPatterns: ["^/private/tmp/claude-[0-9A-Fa-f]+-cwd$"],
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

/** The $HOME-relative dirs a "carve" posture needs, realpath'd (Seatbelt
 *  matches kernel-real paths). Dirs that do not exist are dropped: an agent
 *  that has never run has nothing to protect, and a `-D` param pointing at
 *  a missing path is a profile that fails to compile. */
/** Resolve an entry's `scratch` templates against this run's uid and shared
 *  folder. Unlike `carveDirs`, missing dirs are **created** rather than
 *  dropped: the agent expects to `mkdir` inside them, and a `subpath` rule
 *  naming a path that does not exist yet would let it create the leaf but
 *  not reach it. Realpath'd last, because Seatbelt matches kernel-real paths
 *  and `/tmp` is a symlink to `/private/tmp` on macOS. */
export function scratchDirs(entry: AgentEntry, cwd: string, uid: number = process.getuid?.() ?? 0): string[] {
  const out: string[] = [];
  for (const tpl of entry.scratch ?? []) {
    const abs = tpl.replaceAll("{uid}", String(uid)).replaceAll("{cwdSlug}", cwd.replaceAll("/", "-"));
    if (!path.isAbsolute(abs)) continue; // a template that resolved to nonsense opens nothing
    try {
      fs.mkdirSync(abs, { recursive: true, mode: 0o700 });
      out.push(fs.realpathSync(abs));
    } catch {}
  }
  return out;
}

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
