import type { Command, CommandResult } from "../src/model";

const text = new TextEncoder();
const readJson = async <T>(handle: FileSystemFileHandle): Promise<T> => JSON.parse(await (await handle.getFile()).text()) as T;
const writeJson = async (dir: FileSystemDirectoryHandle, name: string, value: unknown): Promise<void> => {
  const handle = await dir.getFileHandle(name, { create: true });
  const writer = await handle.createWritable();
  await writer.write(text.encode(`${JSON.stringify(value, null, 2)}\n`));
  await writer.close();
};

export interface Channel { fsio: FileSystemDirectoryHandle; commands: FileSystemDirectoryHandle; results: FileSystemDirectoryHandle; cancellations: FileSystemDirectoryHandle }

export async function openChannel(root: FileSystemDirectoryHandle): Promise<Channel> {
  const fsio = await root.getDirectoryHandle(".fsio");
  const actuator = await fsio.getDirectoryHandle("actuator");
  const channel = await actuator.getDirectoryHandle("default");
  return {
    fsio,
    commands: await channel.getDirectoryHandle("commands"),
    results: await channel.getDirectoryHandle("results"),
    cancellations: await channel.getDirectoryHandle("cancellations"),
  };
}

export async function scan(channel: Channel, apply: (command: Command) => Promise<CommandResult>): Promise<number> {
  let count = 0;
  for await (const [name, handle] of channel.commands.entries()) {
    if (handle.kind !== "file" || !name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    try { await channel.results.getFileHandle(name); continue; } catch {}
    try { await channel.cancellations.getFileHandle(name); continue; } catch {}
    const command = await readJson<Command>(handle as FileSystemFileHandle);
    if (command.id !== id || (command.expiresAt && Date.parse(command.expiresAt) <= Date.now())) continue;
    const result = await apply(command);
    await writeJson(channel.results, name, result);
    count++;
  }
  return count;
}
