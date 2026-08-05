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
// Every operation here is answered by the host. Pewter has a second family
// that only the page can answer (`tabs`, `open`, `fling`: that state lives
// in the browser and never touches disk), and the router serving both is
// deliberately not built yet — see
// https://github.com/dglazkov/fsio/issues/165.
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

export const OPERATIONS: Operation[] = [reposList, extBundle];

export const byMethod = (method: string): Operation | undefined =>
  OPERATIONS.find((o) => o.method === method);

/** The operation a command line names, and what is left over as arguments.
 *  Longest match wins, so `ext bundle` is found before a future `ext`. */
export function byArgv(argv: string[]): { op: Operation; rest: string[] } | null {
  const matches = OPERATIONS.filter((o) => o.cli.every((word, i) => argv[i] === word)).sort(
    (a, b) => b.cli.length - a.cli.length
  );
  const op = matches[0];
  return op ? { op, rest: argv.slice(op.cli.length) } : null;
}
