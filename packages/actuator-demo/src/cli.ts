#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import type { ActuatorOperation, Command } from "./model.js";
import { cancel, enqueue, getStatus, listStatuses, type StatusRecord } from "./queue.js";

const HELP = `actuator — queue commands for a stateful web application

USAGE
  actuator [--dir <workspace>] [--json] <command>

COMMANDS
  tabs add       Add a tab with a title and message
  tabs remove    Remove a tab by ID
  tabs activate  Activate a tab by ID
  tabs update    Change a tab's title or message
  tabs list      Ask the page for its current tabs
  commands get   Show one durable command's status
  commands list  List durable command statuses
  commands wait  Wait for a page-authored result
  commands cancel  Cancel a pending command
  capabilities  Print the command vocabulary and format version

Commands remain pending while the page is closed. Use --wait on a tabs
command to wait for application; a wait timeout never cancels the command.
Run actuator help <command...> for command-specific help.`;

const HELP_ADD = `actuator tabs add — queue a request to add a tab

USAGE
  actuator tabs add --title <text> (--message <text> | --message-file <path> | --message-stdin) [options]

OPTIONS
  --no-activate         Keep the current tab active
  --wait                Wait for the page to apply or reject the command
  --timeout <duration>  Stop waiting; does not cancel (default: 5s)
  --expires-in <dur>    Prevent application after this duration
  --json                Print one JSON value to stdout

EXAMPLES
  actuator tabs add --title Build --message "CI is running"
  actuator tabs add --title Review --message-file notes.md --wait --json`;

const HELP_PAGES: Record<string, string> = {
  "tabs add": HELP_ADD,
  "tabs remove": `actuator tabs remove — queue removal of a tab

USAGE
  actuator tabs remove <tab-id> [--wait] [--timeout <duration>] [--expires-in <duration>] [--json]

Success means the page removed the tab from its browser-owned state. Use
\`actuator tabs list --wait\` to discover IDs. A closed page leaves the
command pending.

EXAMPLE
  actuator tabs remove tab-8f2a --wait --json`,
  "tabs activate": `actuator tabs activate — queue activation of a tab

USAGE
  actuator tabs activate <tab-id> [--wait] [--timeout <duration>] [--expires-in <duration>] [--json]

Success means the page made this its active tab. A closed page leaves the
command pending.

EXAMPLE
  actuator tabs activate tab-8f2a --wait`,
  "tabs update": `actuator tabs update — queue changes to an existing tab

USAGE
  actuator tabs update <tab-id> [--title <text>] [--message <text>] [--wait] [--json]

At least one field is required. Success means the page committed the change
to its browser-owned state.

EXAMPLE
  actuator tabs update tab-8f2a --message "CI passed" --wait --json`,
  "tabs list": `actuator tabs list — ask the page for its current tab state

USAGE
  actuator tabs list [--wait] [--timeout <duration>] [--expires-in <duration>] [--json]

This is a page query, not local queue inspection. It remains pending while
the page is closed. Use \`actuator commands list\` for offline status discovery.

EXAMPLE
  actuator tabs list --wait --json`,
  "commands get": `actuator commands get — inspect one command without contacting the page

USAGE
  actuator commands get <command-id> [--json]

Reports pending, applied, failed, expired, or cancelled from durable folder
records. This works while the page is closed.`,
  "commands list": `actuator commands list — inspect durable command statuses

USAGE
  actuator commands list [--status <status>] [--json]

This reads the local queue and works while the page is closed.

EXAMPLE
  actuator commands list --status pending --json`,
  "commands wait": `actuator commands wait — wait for a page-authored result

USAGE
  actuator commands wait <command-id> [--timeout <duration>] [--json]

A timeout exits 3 and does not cancel the command. The default is 5s.

EXAMPLE
  actuator commands wait cmd-01JABC --timeout 30s --json`,
  "commands cancel": `actuator commands cancel — prevent a pending command from applying

USAGE
  actuator commands cancel <command-id> [--json]

Only pending commands can be cancelled. Cancellation is durable and works
while the page is closed.`,
  "capabilities": `actuator capabilities — print the installed command vocabulary

USAGE
  actuator capabilities [--json]

Reports the channel format, methods, and status vocabulary without requiring
a workspace or running page.`,
};

const fail = (message: string, code = 2): never => { console.error(`actuator: ${message}`); process.exit(code); };
const duration = (value: string): number => {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value);
  if (!match) fail(`invalid duration ${JSON.stringify(value)}; use 500ms, 5s, 2m, or 1h`);
  const parsed = match!;
  return Number(parsed[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[parsed[2] ?? "ms"]!);
};

const argv = process.argv.slice(2);
let root = process.cwd();
let json = false;
for (let i = 0; i < argv.length;) {
  if (argv[i] === "--json") { json = true; argv.splice(i, 1); }
  else if (argv[i] === "--dir") { const value = argv[i + 1]; if (!value) fail("--dir needs a workspace path"); root = path.resolve(value!); argv.splice(i, 2); }
  else i++;
}
const flag = (name: string): string | undefined => { const i = argv.indexOf(name); if (i < 0) return undefined; const value = argv[i + 1]; if (!value || value.startsWith("--")) fail(`${name} needs a value`); argv.splice(i, 2); return value; };
const booleanFlag = (name: string): boolean => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const present = (name: string): boolean => argv.includes(name);
const output = (value: unknown, human: string): void => console.log(json ? JSON.stringify(value, null, 2) : human);
const render = (record: StatusRecord): string => {
  const suffix = record.result?.result ? `\nResult: ${JSON.stringify(record.result.result)}` : record.result?.error ? `\nError: ${record.result.error.message}${record.result.error.hint ? `\nHint: ${record.result.error.hint}` : ""}` : "";
  return `Command: ${record.command.id}\nStatus: ${record.status}${suffix}`;
};
const waitFor = async (id: string, timeoutMs: number): Promise<StatusRecord> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const record = getStatus(root, id);
    if (!record) fail(`unknown command: ${id}`);
    if (record!.status !== "pending") return record!;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const record = getStatus(root, id)!;
  output(record, `${render(record)}\nWait timed out after ${timeoutMs}ms; the command remains pending.`);
  process.exit(3);
};

const helpPath = argv[0] === "help" ? argv.slice(1).join(" ") : "";
if (argv.length === 0 || argv[0] === "--help" || argv[0] === "help") {
  console.log(HELP_PAGES[helpPath] ?? HELP);
  process.exit(0);
}
if (argv[0] === "capabilities") {
  const value = { format: 1, channel: "default", methods: ["tabs.add", "tabs.remove", "tabs.activate", "tabs.update", "tabs.list"], statuses: ["pending", "applied", "failed", "expired", "cancelled"] };
  output(value, `format 1\nmethods: ${value.methods.join(", ")}\nstatuses: ${value.statuses.join(", ")}`);
  process.exit(0);
}
if (argv[0] === "commands") {
  const action = argv[1];
  if (action === "list") {
    const wanted = flag("--status");
    const rows = listStatuses(root).filter((row) => !wanted || row.status === wanted);
    output(rows, rows.length ? rows.map((row) => `${row.command.id}  ${row.status.padEnd(9)} ${row.command.method}`).join("\n") : "No commands.");
  } else {
    const id = argv[2] ?? fail(`commands ${action ?? ""} needs a command ID`);
    if (action === "get") { const row = getStatus(root, id); if (!row) fail(`unknown command: ${id}`); output(row, render(row!)); }
    else if (action === "cancel") { try { const row = cancel(root, id); output(row, render(row)); } catch (error) { fail((error as Error).message, 1); } }
    else if (action === "wait") { const row = await waitFor(id, duration(flag("--timeout") ?? "5s")); output(row, render(row)); if (row.status === "failed") process.exit(1); }
    else fail(`unknown commands action: ${action ?? "(missing)"}`);
  }
  process.exit(0);
}

let op: ActuatorOperation | null = null;
if (argv[0] !== "tabs") fail(`unknown command: ${argv[0]}`);
const action = argv[1];
if (action === "add") {
  const title = flag("--title") ?? fail("tabs add requires --title");
  const inline = flag("--message"); const file = flag("--message-file"); const stdin = booleanFlag("--message-stdin");
  if ([inline !== undefined, file !== undefined, stdin].filter(Boolean).length !== 1) fail("tabs add needs exactly one of --message, --message-file, or --message-stdin");
  const message = inline ?? (file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8"));
  op = { method: "tabs.add", params: { title, message, activate: !booleanFlag("--no-activate") } };
} else if (action === "remove") op = { method: "tabs.remove", params: { id: argv[2] ?? fail("tabs remove needs a tab ID") } };
else if (action === "activate") op = { method: "tabs.activate", params: { id: argv[2] ?? fail("tabs activate needs a tab ID") } };
else if (action === "update") {
  const id = argv[2] ?? fail("tabs update needs a tab ID"); const title = flag("--title"); const message = flag("--message");
  if (title === undefined && message === undefined) fail("tabs update needs --title or --message");
  op = { method: "tabs.update", params: { id, ...(title !== undefined ? { title } : {}), ...(message !== undefined ? { message } : {}) } };
} else if (action === "list") op = { method: "tabs.list", params: {} };
else fail(`unknown tabs action: ${action ?? "(missing)"}`);

const doWait = booleanFlag("--wait");
const timeoutMs = duration(flag("--timeout") ?? "5s");
const expires = flag("--expires-in");
if (argv.some((item) => item.startsWith("--"))) fail(`unknown option: ${argv.find((item) => item.startsWith("--"))}`);
if (!op) fail("missing tab operation");
const command: Command = { ...op!, id: `cmd-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString(), ...(expires ? { expiresAt: new Date(Date.now() + duration(expires)).toISOString() } : {}) };
enqueue(root, command);
if (doWait) { const row = await waitFor(command.id, timeoutMs); output(row, render(row)); if (row.status === "failed") process.exit(1); }
else output({ commandId: command.id, status: "pending" }, `Queued command ${command.id}\nStatus: pending\nInspect: actuator commands get ${command.id}\nWait:    actuator commands wait ${command.id}`);
