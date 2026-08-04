// A file on this machine, turned into a command.
//
// Its own module for the same reason actuate.ts is: cli.ts is a script that
// reads argv and exits, so anything living in it is untestable by
// construction — and this is the one place in the demo where a file is read
// off the local filesystem and put on a wire.
//
// It is deliberately *this* process that reads it. The terminal already has
// your authority; the helper has exactly one folder and no business
// acquiring a "read any path" power to serve a demo. So a fling is the
// terminal handing over a copy of something it can already see, and a file
// this process cannot read never becomes a command at all.
import fs from "node:fs/promises";
import { toBase64 } from "./bytes.js";
import { basename, MAX_FLING_BYTES, mimeFor, type Operation } from "./model.js";

/** Why a file could not be flung, before anything was sent. Every one of
 *  these is the caller's to fix, which is why they exit 2 rather than 3. */
export class FlingError extends Error {
  constructor(
    readonly reason: "missing" | "directory" | "too_big" | "unreadable",
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "FlingError";
  }
}

const size = (n: number): string =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

export async function flingOp(file: string, open = true): Promise<Operation> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) {
    throw new FlingError(
      "missing",
      `cannot read ${file}`,
      "this side reads the file, so this side is where a typo shows up"
    );
  }
  if (stat.isDirectory()) throw new FlingError("directory", `${file} is a folder`, "fling one file at a time");
  if (stat.size > MAX_FLING_BYTES) {
    throw new FlingError(
      "too_big",
      `${basename(file)} is ${size(stat.size)}; this demo carries at most ${size(MAX_FLING_BYTES)}`,
      "a bigger file inside the granted folder can be shown in place: actuator open <path>"
    );
  }
  const bytes = await fs.readFile(file).catch((e: unknown) => {
    throw new FlingError("unreadable", `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  });
  const name = basename(file);
  return {
    method: "files.fling",
    params: {
      name,
      // The absolute path, because provenance is the only thing about the
      // original that survives the trip — and it is what a re-fling of the
      // same file supersedes on.
      from: file,
      type: mimeFor(name),
      size: bytes.byteLength,
      data: toBase64(new Uint8Array(bytes)),
      open,
    },
  };
}
