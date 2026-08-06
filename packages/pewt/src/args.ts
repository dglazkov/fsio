// argv → what to do. Separate from cli.ts so it is testable without a
// folder, a host, or a process to exit.
import { byArgv, COMMAND_LIST } from "./ops.js";

export type Parsed =
  | { kind: "help"; text: string }
  | { kind: "error"; message: string }
  | { kind: "serve"; dir: string | null; url: string | null; open: boolean; allowRuns: boolean; allowShells: boolean; allowAgents: boolean }
  | { kind: "op"; dir: string | null; json: boolean; method: string; params: unknown }
  | { kind: "process"; dir: string | null; json: boolean; dryRun: boolean; method: string; spec: Record<string, unknown> };

// `serve` is not an operation — it is the host rather than a call on one —
// so it is written here, and everything else comes off the table. One column
// width for all of them, computed rather than typed, because a hand-aligned
// column is wrong the first time an operation with a longer name arrives.
const COMMANDS: [string, string][] = [
  ["serve", "run the host for this pewter"],
  ...COMMAND_LIST.map((c): [string, string] => [[...c.cli, c.usage].filter(Boolean).join(" "), c.summary]),
];
const WIDTH = Math.max(...COMMANDS.map(([spelling]) => spelling.length)) + 2;

const USAGE = `pewt — the command line for a pewter

${COMMANDS.map(([spelling, summary]) => `  pewt ${spelling.padEnd(WIDTH)}${summary}`).join("\n")}

Anywhere:
  --dir <path>   act on the pewter at <path> instead of the one containing
                 the working directory (a development convenience)
  --json         print the result as JSON instead of prose
  --help         this

run, shell, agent:
  --repo <name>  a project under repos/ (default: the pewter itself)
  --dry-run      print what would start, and start nothing

serve:
  --url <base>   where the shell is served from
  --no-open      print the URL and open nothing
  --allow-runs   allow every \`run\` without asking on this terminal
  --allow-shells allow every \`shell\` without asking on this terminal
  --allow-agents allow every \`agent\` without asking on this terminal

The allow flags are separate because these are separate capabilities:
something that was told it could build is not thereby something that can do
anything, or something that can run a coding agent on your projects.

\`pewt agent\` is a pipe, not a conversation: one ACP message per line in on
stdin, the agent's own messages out on stdout. Whatever is on the other end
is the ACP client — a tab is the one Pewter ships toward.

Exit codes: 0 done · 1 refused · 2 usage · 3 no host is running.
\`pewt run\` exits with the script's own code instead, the way \`npm run\` does —
so a script that exits 3 and a pewter with no host look alike, and the message
on stderr is what tells them apart.`;

export function parseArgs(argv: string[]): Parsed {
  let dir: string | null = null;
  let url: string | null = null;
  let repo: string | null = null;
  let json = false;
  let open = true;
  let dryRun = false;
  let allowRuns = false;
  let allowShells = false;
  let allowAgents = false;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h" || a === "help") return { kind: "help", text: USAGE };
    else if (a === "--json") json = true;
    else if (a === "--no-open") open = false;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--allow-runs") allowRuns = true;
    else if (a === "--allow-shells") allowShells = true;
    else if (a === "--allow-agents") allowAgents = true;
    else if (a === "--dir" || a === "--url" || a === "--repo") {
      const value = argv[++i];
      if (!value) return { kind: "error", message: `${a} needs a value` };
      if (a === "--dir") dir = value;
      else if (a === "--url") url = value;
      else repo = value;
    } else if (a.startsWith("--dir=")) dir = a.slice("--dir=".length);
    else if (a.startsWith("--url=")) url = a.slice("--url=".length);
    else if (a.startsWith("--repo=")) repo = a.slice("--repo=".length);
    else if (a.startsWith("-")) return { kind: "error", message: `unknown flag ${a}` };
    else rest.push(a);
  }

  if (rest.length === 0) return { kind: "help", text: USAGE };
  if (rest[0] === "serve") {
    if (rest.length > 1) return { kind: "error", message: `serve takes no arguments (got ${rest.slice(1).join(" ")})` };
    return { kind: "serve", dir, url, open, allowRuns, allowShells, allowAgents };
  }

  const found = byArgv(rest);
  if (!found) return { kind: "error", message: `unknown command ${JSON.stringify(rest.join(" "))}` };
  try {
    if ("process" in found) {
      if (repo !== null && !found.process.repo) return { kind: "error", message: `${found.process.cli.join(" ")} takes no --repo` };
      return {
        kind: "process",
        dir,
        json,
        dryRun,
        method: found.process.method,
        // Through `parse`, not around it: what the command line typed and
        // what an extension passed become one spec in one place, and a
        // front end that skipped it would be inventing a second wire format.
        spec: found.process.parse({ ...found.process.fromArgv(found.rest), ...(repo !== null ? { repo } : {}) }),
      };
    }
    // A flag that means nothing here is a typo, not a preference: `pewt repos
    // --repo site` is somebody expecting a filter that does not exist, and
    // ignoring it would answer a different question than the one asked.
    if (repo !== null) return { kind: "error", message: `${found.op.cli.join(" ")} takes no --repo` };
    if (dryRun) return { kind: "error", message: `${found.op.cli.join(" ")} starts nothing, so --dry-run has nothing to describe` };
    return { kind: "op", dir, json, method: found.op.method, params: found.op.fromArgv(found.rest) };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
