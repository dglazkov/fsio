#!/usr/bin/env node
// `actuator` — the local half of the actuator demo.
//
// It is an fsio *client*, the same as the page is: it opens a session in
// the granted folder, says one thing, reads the answer, and closes. There
// is no socket, no port, and no state of its own — if the page is not
// there, the command does not exist anywhere.
//
// Exit codes, because this tool exists to be scripted (by a person or an
// agent):
//   0  the page applied it
//   1  the page refused it (no such tab, say) — the command arrived
//   2  usage error — nothing left this process
//   3  nobody home: no helper, no page, or no answer in time
import path from "node:path";
import type { Tab } from "./model.js";
import { actuate, CliError } from "./actuate.js";
import { parseArgs } from "./args.js";
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

const { op, json } = parsed;
const dir = path.resolve(parsed.dir);

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
          const first = t.message.split("\n")[0] ?? "";
          const message = first.length > 48 ? `${first.slice(0, 47)}…` : first;
          return `${mark} ${t.id.padEnd(width)}  ${t.title}${message ? `  —  ${message}` : ""}`;
        })
        .join("\n");
    }
  }
}

try {
  const answer = await actuate(new NodeDirectory(dir), op);
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
