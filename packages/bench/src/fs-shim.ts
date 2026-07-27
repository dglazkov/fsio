// Node shim for @fsio/client's FS surface (TESTING.md B1): real `fs`
// underneath, temp-file + rename emulating the File System Access API's
// atomic close() commit (D2). This runs the REAL FsioSession against the
// REAL host without a browser.
//
// Deliberately NOT emulated: snapshot staleness (NotReadableError under
// concurrent appends, F11) and the after-write safety scan (F7). Platform
// truth stays in the workbench/labs; this shim proves client *logic*.

import fs from "node:fs/promises";
import path from "node:path";
import type { FsDirectory, FsFile, FsSnapshot, FsWritable } from "@fsio/client";

/** DOMException stand-in: the client's error labeling reads `.name`. */
class NamedError extends Error {
  constructor(name: string, msg: string) {
    super(msg);
    this.name = name;
  }
}

export class ShimDirectory implements FsDirectory {
  constructor(readonly dirPath: string) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsDirectory> {
    const p = path.join(this.dirPath, name);
    if (options?.create) {
      await fs.mkdir(p, { recursive: true });
    } else {
      const st = await fs.stat(p).catch(() => null);
      if (!st?.isDirectory()) throw new NamedError("NotFoundError", `no directory ${name}`);
    }
    return new ShimDirectory(p);
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFile> {
    const p = path.join(this.dirPath, name);
    const st = await fs.stat(p).catch(() => null);
    if (!st?.isFile()) {
      if (!options?.create) throw new NamedError("NotFoundError", `no file ${name}`);
      await (await fs.open(p, "a")).close(); // touch, like Chrome's create:true
    }
    return new ShimFile(p, name);
  }

  async *keys(): AsyncIterableIterator<string> {
    yield* await fs.readdir(this.dirPath);
  }
}

class ShimFile implements FsFile {
  constructor(
    private readonly filePath: string,
    private readonly name: string
  ) {}

  async getFile(): Promise<FsSnapshot> {
    const [st, buf] = await Promise.all([fs.stat(this.filePath), fs.readFile(this.filePath)]);
    // A real point-in-time snapshot: File over the buffered bytes.
    return new File([buf], this.name, { lastModified: Math.round(st.mtimeMs) });
  }

  async createWritable(): Promise<FsWritable> {
    // .crswap plays the role of Chrome's swap file: the host's chunk-name
    // regexes ignore it in in/ (an empty/absent target file is the F11
    // torn-state path the host already retries); rename() is the commit.
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
