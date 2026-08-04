// The folder, as @fsio/client wants to see it, on Node.
//
// The CLI is a real fsio client (D11: the client's FS dependency is a
// structural type, so anything shaped like the browser's handles works).
// This is that shape over `node:fs` — temp-file + rename standing in for
// the File System Access API's atomic commit on close() (D2).
//
// This is the second copy in the repo: packages/bench/src/fs-shim.ts is the
// first, and it carries a fault-injection surface that only tests want.
// Two copies is the signal a library gets extracted from, not the
// extraction (PROCESS.md rule 6) — and where it would go is a question
// about @fsio/client's surface rather than about this demo, so it is filed
// rather than answered here.
import fs from "node:fs/promises";
import path from "node:path";
import type { FsDirectory, FsFile, FsSnapshot, FsWritable } from "@fsio/client";

/** DOMException stand-in: the client labels errors by `.name`. */
class NamedError extends Error {
  constructor(name: string, msg: string) {
    super(msg);
    this.name = name;
  }
}

export class NodeDirectory implements FsDirectory {
  constructor(readonly dirPath: string) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsDirectory> {
    const p = path.join(this.dirPath, name);
    if (options?.create) {
      await fs.mkdir(p, { recursive: true });
    } else {
      const st = await fs.stat(p).catch(() => null);
      if (!st?.isDirectory()) throw new NamedError("NotFoundError", `no directory ${name}`);
    }
    return new NodeDirectory(p);
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFile> {
    const p = path.join(this.dirPath, name);
    const st = await fs.stat(p).catch(() => null);
    if (!st?.isFile()) {
      if (!options?.create) throw new NamedError("NotFoundError", `no file ${name}`);
      await (await fs.open(p, "a")).close(); // touch, like Chrome's create: true
    }
    return new NodeFile(p, name);
  }

  async *keys(): AsyncIterableIterator<string> {
    yield* await fs.readdir(this.dirPath);
  }
}

class NodeFile implements FsFile {
  constructor(
    private readonly filePath: string,
    private readonly name: string
  ) {}

  async getFile(): Promise<FsSnapshot> {
    const [st, buf] = await Promise.all([fs.stat(this.filePath), fs.readFile(this.filePath)]);
    return new File([buf], this.name, { lastModified: Math.round(st.mtimeMs) });
  }

  async createWritable(): Promise<FsWritable> {
    // `.crswap` plays Chrome's swap file: the host's chunk-name regexes
    // ignore it in `in/`, and rename() is the commit.
    const tmp = `${this.filePath}.${Math.random().toString(36).slice(2, 8)}.crswap`;
    const fh = await fs.open(tmp, "w");
    const target = this.filePath;
    return {
      async write(data: Uint8Array<ArrayBuffer>): Promise<void> {
        await fh.write(data);
      },
      async close(): Promise<void> {
        await fh.close();
        await fs.rename(tmp, target);
      },
    };
  }
}
