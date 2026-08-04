import fs from "node:fs";
import path from "node:path";
import type { Command, CommandResult } from "./model.js";

export type CommandStatus = "pending" | "applied" | "failed" | "expired" | "cancelled";
export interface StatusRecord { command: Command; status: CommandStatus; result?: CommandResult }

export const channelDir = (root: string) => path.join(path.resolve(root), ".fsio", "actuator", "default");

export function ensureChannel(root: string): string {
  const base = channelDir(root);
  for (const name of ["commands", "results", "cancellations"]) fs.mkdirSync(path.join(base, name), { recursive: true });
  const descriptor = path.join(base, "channel.json");
  if (!fs.existsSync(descriptor)) atomicJson(descriptor, { format: 1, name: "default", experimental: true });
  return base;
}

export function atomicJson(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(temp, file);
}

export function enqueue(root: string, command: Command): void {
  const base = ensureChannel(root);
  atomicJson(path.join(base, "commands", `${command.id}.json`), command);
}

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;

export function getStatus(root: string, id: string): StatusRecord | null {
  const base = channelDir(root);
  const commandFile = path.join(base, "commands", `${id}.json`);
  if (!fs.existsSync(commandFile)) return null;
  const command = readJson<Command>(commandFile);
  const resultFile = path.join(base, "results", `${id}.json`);
  if (fs.existsSync(resultFile)) {
    const result = readJson<CommandResult>(resultFile);
    return { command, status: result.status, result };
  }
  if (fs.existsSync(path.join(base, "cancellations", `${id}.json`))) return { command, status: "cancelled" };
  if (command.expiresAt && Date.parse(command.expiresAt) <= Date.now()) return { command, status: "expired" };
  return { command, status: "pending" };
}

export function listStatuses(root: string): StatusRecord[] {
  const dir = path.join(channelDir(root), "commands");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => getStatus(root, name.slice(0, -5))).filter((x): x is StatusRecord => x !== null).sort((a, b) => a.command.createdAt.localeCompare(b.command.createdAt));
}

export function cancel(root: string, id: string): StatusRecord {
  const current = getStatus(root, id);
  if (!current) throw new Error(`unknown command: ${id}`);
  if (current.status !== "pending") throw new Error(`command ${id} is already ${current.status}`);
  atomicJson(path.join(ensureChannel(root), "cancellations", `${id}.json`), { commandId: id, cancelledAt: new Date().toISOString() });
  return getStatus(root, id)!;
}
