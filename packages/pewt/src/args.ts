// argv → what to do. Separate from cli.ts so it is testable without a
// folder, a host, or a process to exit.
import { byArgv, OPERATIONS } from "./ops.js";

export type Parsed =
  | { kind: "help"; text: string }
  | { kind: "error"; message: string }
  | { kind: "serve"; dir: string | null; url: string | null; open: boolean }
  | { kind: "op"; dir: string | null; json: boolean; method: string; params: unknown };

const USAGE = `pewt — the command line for a pewter

  pewt serve                    run the host for this pewter
${OPERATIONS.map((o) => `  pewt ${[...o.cli, o.usage].filter(Boolean).join(" ").padEnd(26)}${o.summary}`).join("\n")}

Anywhere:
  --dir <path>   act on the pewter at <path> instead of the one containing
                 the working directory (a development convenience)
  --json         print the result as JSON instead of prose
  --help         this

serve:
  --url <base>   where the shell is served from
  --no-open      print the URL and open nothing

Exit codes: 0 done · 1 refused · 2 usage · 3 no host is running`;

export function parseArgs(argv: string[]): Parsed {
  let dir: string | null = null;
  let url: string | null = null;
  let json = false;
  let open = true;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h" || a === "help") return { kind: "help", text: USAGE };
    else if (a === "--json") json = true;
    else if (a === "--no-open") open = false;
    else if (a === "--dir" || a === "--url") {
      const value = argv[++i];
      if (!value) return { kind: "error", message: `${a} needs a value` };
      if (a === "--dir") dir = value;
      else url = value;
    } else if (a.startsWith("--dir=")) dir = a.slice("--dir=".length);
    else if (a.startsWith("--url=")) url = a.slice("--url=".length);
    else if (a.startsWith("-")) return { kind: "error", message: `unknown flag ${a}` };
    else rest.push(a);
  }

  if (rest.length === 0) return { kind: "help", text: USAGE };
  if (rest[0] === "serve") {
    if (rest.length > 1) return { kind: "error", message: `serve takes no arguments (got ${rest.slice(1).join(" ")})` };
    return { kind: "serve", dir, url, open };
  }

  const found = byArgv(rest);
  if (!found) return { kind: "error", message: `unknown command ${JSON.stringify(rest.join(" "))}` };
  try {
    return { kind: "op", dir, json, method: found.op.method, params: found.op.fromArgv(found.rest) };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
