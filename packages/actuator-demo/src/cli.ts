#!/usr/bin/env node
// `actuator` — the local half of the actuator demo.
//
// It is an fsio *client*, the same as the page is: it opens a session in
// the granted folder, says one thing, reads the answer, and closes. There
// is no socket, no port, and no state of its own — if the page is not
// there, the command does not exist anywhere.
//
// One command carries more than a sentence. `fling` reads a file here and
// puts the bytes on the wire, which is the only thing in this demo that
// travels in quantity — and it is deliberately this process that reads it,
// not the helper. The terminal already has your authority; the helper has
// exactly one folder. Handing the page a copy of something outside that
// folder is this process's to do, or nobody's.
//
// Exit codes, because this tool exists to be scripted (by a person or an
// agent):
//   0  the page applied it
//   1  the page refused it (no such tab, say) — the command arrived
//   2  usage error, or a file this process could not read — nothing left here
//   3  nobody home: no helper, no page, or no answer in time
import path from "node:path";
import type { HeldFile, Operation, Tab } from "./model.js";
import { actuate, CliError } from "./actuate.js";
import { parseArgs } from "./args.js";
import { flingOp, FlingError } from "./fling.js";
import { NodeDirectory } from "./node-fs.js";

const parsed = parseArgs(process.argv.slice(2), process.cwd());

if (parsed.kind === "help") {
  console.log(parsed.text);
  process.exit(0);
}
if (parsed.kind === "error") {
  console.error(`actuator: ${parsed.message}\n\nRun \`actuator help\` for usage.`);
  process.exit(2);
}

const { json } = parsed;
const dir = path.resolve(parsed.dir);

const size = (n: number): string =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

/** `fling` still has a file to read (fling.ts). A file this process cannot
 *  read never becomes a command — the page is not the right place to learn
 *  that a path was wrong. */
async function resolveOp(file: string, open: boolean): Promise<Operation> {
  try {
    return await flingOp(file, open);
  } catch (e) {
    if (!(e instanceof FlingError)) throw e;
    console.error(`actuator: ${e.message}`);
    if (e.hint) console.error(`  ${e.hint}`);
    process.exit(2);
  }
}

const op: Operation = parsed.kind === "fling" ? await resolveOp(parsed.path, parsed.open) : parsed.op;

/** What the page said, in a sentence. `--json` prints the raw answer
 *  instead — one JSON value on stdout, nothing else, so a caller can pipe
 *  it without parsing prose. */
function render(result: Record<string, unknown>): string {
  switch (op.method) {
    case "tabs.add":
      return `added ${String(result["id"])} — ${JSON.stringify(result["title"])}${result["active"] ? " (now active)" : ""}`;
    case "tabs.remove":
      return `removed ${String(result["id"])}${result["activeId"] ? `, ${String(result["activeId"])} is now active` : ", the page is empty"}`;
    case "tabs.activate":
      return `activated ${String(result["id"])} — ${JSON.stringify(result["title"])}`;
    case "tabs.update":
      return `updated ${String(result["id"])} — ${JSON.stringify(result["title"])}`;
    case "tabs.list": {
      const tabs = (result["tabs"] ?? []) as Tab[];
      if (tabs.length === 0) return "the page holds no tabs";
      const width = Math.max(...tabs.map((t) => t.id.length));
      return tabs
        .map((t) => {
          const mark = t.id === result["activeId"] ? "*" : " ";
          // What each tab is showing, in the same column, so the two ways a
          // file can be in this page are one glance apart.
          const what =
            t.body.kind === "message"
              ? (t.body.message.split("\n")[0] ?? "")
              : t.body.kind === "local"
                ? `↗ ${t.body.path} (in the folder)`
                : `⬒ ${t.body.fileId} (held here)`;
          const trimmed = what.length > 48 ? `${what.slice(0, 47)}…` : what;
          return `${mark} ${t.id.padEnd(width)}  ${t.title}${trimmed ? `  —  ${trimmed}` : ""}`;
        })
        .join("\n");
    }
    case "files.open":
      return result["reused"]
        ? `${String(result["path"])} was already open — ${String(result["id"])}`
        : `opened ${String(result["path"])} — ${String(result["id"])}. The page is reading it where it lies.`;
    case "files.fling": {
      const lines = [
        `flung ${String(result["name"])} — ${size(Number(result["size"] ?? 0))} now held by the page as ${String(result["fileId"])}`,
      ];
      if (result["superseded"]) lines.push(`  it replaced the earlier copy (${String(result["superseded"])})`);
      if (result["opened"]) lines.push(`  showing in ${String(result["id"])}`);
      lines.push("  that copy stays when the helper stops and the folder grant goes.");
      return lines.join("\n");
    }
    case "files.list": {
      const files = (result["files"] ?? []) as HeldFile[];
      if (files.length === 0) return "the page holds no files";
      const width = Math.max(...files.map((f) => f.id.length));
      return files
        .map((f) => `  ${f.id.padEnd(width)}  ${size(f.size).padStart(7)}  ${f.name}  —  from ${f.from}`)
        .join("\n");
    }
    case "files.show":
      return result["reused"]
        ? `${String(result["name"])} was already open — ${String(result["id"])}`
        : `showing ${String(result["name"])} — ${String(result["id"])}`;
    case "files.drop": {
      const closed = Number(result["closedTabs"] ?? 0);
      return `dropped ${String(result["name"])} (${String(result["id"])})${closed ? `, and closed ${closed} tab${closed === 1 ? "" : "s"} showing it` : ""}`;
    }
  }
}

try {
  // A fling is a megabyte through a folder rather than a sentence, and a
  // background tab beats once a minute (F16) — so it gets the helper's
  // patience rather than the default.
  const answer = await actuate(new NodeDirectory(dir), op, op.method === "files.fling" ? { timeoutMs: 30_000 } : {});
  if (answer.ok) {
    console.log(json ? JSON.stringify(answer.result, null, 2) : render(answer.result));
    process.exit(0);
  }
  if (json) {
    console.log(JSON.stringify(answer.error, null, 2));
  } else {
    console.error(`actuator: ${answer.error.message}`);
    if (answer.error.hint) console.error(`  ${answer.error.hint}`);
  }
  // A channel failure that reached us as an outcome (the page vanished
  // mid-command) is still "nobody home"; only the page's own refusal is a 1.
  process.exit(answer.error.kind === "app" ? 1 : 3);
} catch (e) {
  const err = e instanceof CliError ? e : null;
  const message = err ? err.message : e instanceof Error ? e.message : String(e);
  if (json) {
    console.log(JSON.stringify({ kind: "channel", code: err?.reason ?? "internal", message, ...(err?.hint ? { hint: err.hint } : {}) }, null, 2));
  } else {
    console.error(`actuator: ${message}`);
    if (err?.hint) console.error(`  ${err.hint}`);
  }
  process.exit(3);
}
