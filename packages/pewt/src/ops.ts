// The operations, in one table.
//
// This file is the claim in NARRATIVE.md's "One API, two ways in" made
// structural rather than asserted: an operation declares how a terminal
// spells it, how the wire spells it, how to check what arrived, what it
// does, and what a terminal prints. The CLI reads the table, the session
// kind reads the table, and adding an operation adds both front ends because
// there is nowhere to add one to.
//
// The spellings differ where each side has its own conventions — `pewt
// repos` against `repos.list` — and the operation does not.
//
// There are two families in this file and they split by *shape*: a request
// has one answer, and a process has a stream that ends in an exit code. Both
// are answered by the host.
//
// Pewter has a third family that only the page can answer (`tabs`, `open`,
// `fling`: that state lives in the browser and never touches disk), and the
// router serving both directions is deliberately not built yet — see
// https://github.com/dglazkov/fsio/issues/164.
import { shellSpec } from "pewter";
import { roster, type RosterEntry } from "./agents.js";
import { bundleExtension, BundleError, type Bundle } from "./bundle.js";
import { listRepos, type Project } from "./repos.js";
import type { Pewter } from "./pewter.js";

/** An operation said no. Distinct from a transport failure: the request
 *  arrived, was understood, and the answer was no.
 *
 *  `hint` is what to do instead, and it is not decoration — an agent reading
 *  stderr can act on a hint and cannot act on a tone. */
export class OpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "OpError";
  }
}

/** One operation, with its type erased so the table can hold all of them.
 *  Each definition below keeps its own parameter and result types; `define`
 *  is the one place the erasure happens. */
export interface Operation {
  /** the wire name, and the RPC method a session carries. */
  method: string;
  /** how a terminal spells it: the words before the arguments. */
  cli: string[];
  /** one line, for `pewt help`. */
  summary: string;
  /** the argument shape, for `pewt help`. Empty when it takes none. */
  usage: string;
  /** argv after the command words → params, as the wire would carry them. */
  fromArgv(argv: string[]): unknown;
  /** what arrived → what this operation will accept. Both front ends land
   *  here, because anything that can write the folder can write anything
   *  (spec/PROTOCOL.md, threat model) and the CLI is not a trusted caller
   *  either — it is just another client. */
  parse(params: unknown): unknown;
  run(p: Pewter, params: unknown): Promise<unknown>;
  /** what a terminal prints. `--json` prints the result instead. */
  render(result: unknown): string;
}

interface Def<P, R> {
  method: string;
  cli: string[];
  summary: string;
  usage?: string;
  fromArgv(argv: string[]): P;
  parse(params: unknown): P;
  run(p: Pewter, params: P): Promise<R>;
  render(result: R): string;
}

const define = <P, R>(d: Def<P, R>): Operation => ({
  method: d.method,
  cli: d.cli,
  summary: d.summary,
  usage: d.usage ?? "",
  fromArgv: (argv) => d.fromArgv(argv),
  parse: (params) => d.parse(params),
  run: (p, params) => d.run(p, params as P),
  render: (result) => d.render(result as R),
});

const noParams = (): Record<string, never> => ({});

/** A string field, or the refusal that names it. */
function str(params: unknown, key: string): string {
  const value = (params as Record<string, unknown> | null)?.[key];
  if (typeof value !== "string" || value === "") {
    throw new OpError("bad_params", `${key} is required and must be a string`);
  }
  return value;
}

const size = (n: number): string =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

export const reposList = define<Record<string, never>, { repos: Project[] }>({
  method: "repos.list",
  cli: ["repos"],
  summary: "the projects in this pewter",
  fromArgv: noParams,
  parse: noParams,
  run: async (p) => ({ repos: await listRepos(p) }),
  render: ({ repos }) => {
    // An empty pewter is the normal first state and the normal state after a
    // clone, so it gets a sentence rather than a blank line — `repos/` is
    // git-ignored, which is the whole point and also the surprise.
    if (repos.length === 0) {
      return "no projects yet — repos/ is empty.\n  A cloned pewter starts this way: your extensions come back, your work does not.";
    }
    const width = Math.max(...repos.map((r) => r.name.length));
    return repos.map((r) => `  ${r.name.padEnd(width)}  ${r.git ? "git" : "(not a git repository)"}`).join("\n");
  },
});

export const extBundle = define<{ name: string }, Bundle>({
  method: "ext.bundle",
  cli: ["ext", "bundle"],
  summary: "build one extension into a single HTML file",
  usage: "<name>",
  fromArgv: (argv) => {
    if (argv.length !== 1 || !argv[0]) throw new OpError("usage", "ext bundle takes one extension name");
    return { name: argv[0] };
  },
  parse: (params) => ({ name: str(params, "name") }),
  run: async (p, { name }) => {
    try {
      return await bundleExtension(p, name);
    } catch (e) {
      // esbuild's diagnostics are the useful half of a compile failure, so
      // they travel as the message rather than being summarized into one.
      if (e instanceof BundleError) throw new OpError(e.code, e.message, e.hint);
      throw new OpError("build_failed", e instanceof Error ? e.message : String(e));
    }
  },
  render: (b) =>
    `${b.name} → ${b.path}  (${size(b.bytes)}, ${b.hash})` +
    (b.rebuilt ? `\n  rebuilt in ${b.ms} ms` : "\n  already newer than its sources — nothing to do"),
});

export const agentsList = define<Record<string, never>, { agents: RosterEntry[] }>({
  method: "agents.list",
  cli: ["agents"],
  summary: "the ACP adapters this pewter depends on",
  fromArgv: noParams,
  parse: noParams,
  run: async (p) => ({ agents: roster(p) }),
  render: ({ agents }) => {
    const here = agents.filter((a) => a.installed);
    if (here.length === 0) {
      return [
        "no agents in this pewter — an adapter is an ordinary dependency, so add one:",
        ...agents.map((a) => `  ${a.install.padEnd(44)}${a.asks ? "asks before it edits" : "edits with its own hands"}`),
        "",
        "It is pinned in your lockfile, `npm rm` removes it, and `git clone && npm i`",
        "brings it back on another machine.",
      ].join("\n");
    }
    const width = Math.max(...here.map((a) => a.name.length));
    return here
      .map((a) => {
        // Whether it asks before it edits is the reason this list exists, so
        // it is the column, and a version nobody measured says so in the same
        // breath rather than in a footnote somebody has to go and find.
        const asks = a.asks ? "asks before it edits" : "edits with its own hands — nothing will ask you";
        const doubt = a.unmeasured ? ` (measured at ${a.measured}, this is ${a.version ?? "unknown"})` : "";
        return `  ${a.name.padEnd(width)}  ${a.version ?? "?"}  ${asks}${doubt}`;
      })
      .join("\n");
  },
});

export const OPERATIONS: Operation[] = [reposList, extBundle, agentsList];

export const byMethod = (method: string): Operation | undefined =>
  OPERATIONS.find((o) => o.method === method);

// ---- the second family: operations that start a process
//
// A request has one answer; a run has a stream that ends in an exit code, so
// it cannot be an `Operation` and is not pretending to be one. What it shares
// with the table above is everything that keeps the two front ends from
// drifting: one entry, one spelling on each side, one place to add the next
// one (`agent` lands here).
//
// The two in it are not built the same way, and the difference is worth
// knowing before reading further. `run` is a session kind this project wrote,
// so its spec is its own and the host resolves it. `shell` is @fsio/host's
// kind — the library has the pty, the resize plumbing and the flow control —
// so its spec is the library's, and the translation from `--repo site` to a
// working directory happens on the client (packages/pewter/src/shell.ts).

/** One process operation. `method` is what an extension calls and what the
 *  session's kind is named — the same word, because the session IS the call. */
export interface ProcessOperation {
  method: string;
  cli: string[];
  summary: string;
  usage: string;
  /** whether `--repo` means anything here. */
  repo: boolean;
  /** argv after the command words → what was asked for, minus the repo. */
  fromArgv(argv: string[]): Record<string, unknown>;
  /** what was asked for → the spec a session carries. The command line lands
   *  here (args.ts); an extension is in a browser and lands on the same
   *  translation in the `pewter` package instead. */
  parse(params: unknown): Record<string, unknown>;
}

export const runProcess: ProcessOperation = {
  method: "run",
  cli: ["run"],
  summary: "run a script the project declares",
  usage: "<script>",
  repo: true,
  fromArgv: (argv) => {
    if (argv.length !== 1 || !argv[0]) throw new OpError("usage", "run takes one script name");
    return { script: argv[0] };
  },
  // The script is checked against the project's package.json when the run is
  // planned (run.ts), which is the only check that means anything: a name
  // that is not in that file is not runnable however well-formed it looks.
  parse: (params) => ({ script: str(params, "script"), ...repoOf(params) }),
};

/** The optional project name, in the one shape every operation reads it. */
function repoOf(params: unknown): { repo?: string } {
  const value = (params as Record<string, unknown> | null)?.["repo"];
  if (value === undefined || value === null) return {};
  if (typeof value !== "string" || value === "") throw new OpError("bad_params", "repo must be a project name");
  return { repo: value };
}

export const shellProcess: ProcessOperation = {
  method: "shell",
  cli: ["shell"],
  summary: "open a shell on your machine",
  usage: "",
  repo: true,
  fromArgv: (argv) => {
    if (argv.length > 0) throw new OpError("usage", "shell takes no arguments — `--repo <name>` picks the project");
    return {};
  },
  // The spec that goes on the wire is @fsio/host's, not this table's, so this
  // reads `--repo` and hands it to the one function both front ends translate
  // with (packages/pewter/src/shell.ts). What the host checks is the resolved
  // directory, which is the only check that means anything.
  parse: (params) => shellSpec(repoOf(params)),
};

export const agentProcess: ProcessOperation = {
  method: "agent",
  cli: ["agent"],
  summary: "start an ACP agent on a project",
  usage: "[name]",
  repo: true,
  fromArgv: (argv) => {
    if (argv.length > 1) throw new OpError("usage", "agent takes at most one adapter name — `pewt agents` lists them");
    return argv[0] ? { agent: argv[0] } : {};
  },
  // The name is checked against the roster when the agent is planned
  // (agent.ts), which is the only check that means anything: a name nobody
  // lists is not runnable however well-formed it looks.
  parse: (params) => {
    const agent = (params as Record<string, unknown> | null)?.["agent"];
    if (agent !== undefined && (typeof agent !== "string" || agent === "")) {
      throw new OpError("bad_params", "agent must be an adapter name");
    }
    return { ...(agent !== undefined ? { agent } : {}), ...repoOf(params) };
  },
};

export const PROCESSES: ProcessOperation[] = [runProcess, shellProcess, agentProcess];

export const processByMethod = (method: string): ProcessOperation | undefined =>
  PROCESSES.find((o) => o.method === method);

/** Every operation's command-line spelling, both families, for `pewt help`. */
export const COMMAND_LIST: { cli: string[]; usage: string; summary: string; repo: boolean }[] = [
  ...OPERATIONS.map((o) => ({ cli: o.cli, usage: o.usage, summary: o.summary, repo: false })),
  ...PROCESSES.map((o) => ({ cli: o.cli, usage: o.usage, summary: o.summary, repo: o.repo })),
];

/** The operation a command line names, and what is left over as arguments.
 *  Longest match wins, so `ext bundle` is found before a future `ext`. */
export function byArgv(argv: string[]): { op: Operation; rest: string[] } | { process: ProcessOperation; rest: string[] } | null {
  const words = (cli: string[]): boolean => cli.every((word, i) => argv[i] === word);
  const op = OPERATIONS.filter((o) => words(o.cli)).sort((a, b) => b.cli.length - a.cli.length)[0];
  const proc = PROCESSES.filter((o) => words(o.cli)).sort((a, b) => b.cli.length - a.cli.length)[0];
  if (op && (!proc || op.cli.length >= proc.cli.length)) return { op, rest: argv.slice(op.cli.length) };
  if (proc) return { process: proc, rest: argv.slice(proc.cli.length) };
  return null;
}
