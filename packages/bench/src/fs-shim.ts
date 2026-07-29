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

/** Fault injection (#37): arm a counter and the next N atomic commits
 *  abort the way Chrome for Testing's Safe Browsing was observed to
 *  ("AbortError: Aborted due to security policy"). Shared by reference
 *  down the whole handle tree so tests can arm it mid-session. */
export interface ShimFaults {
  /** next N writable close() commits throw (file lane) */
  closeAborts?: number;
  /** next N directory creations throw (dirname lane) */
  dirCreateAborts?: number;
  /** every directory creation stalls this long (#4: simulates Chrome
   *  starting to scan directory creation — the F10 asymmetry closing) */
  dirCreateDelayMs?: number;
}

const abortError = () => new NamedError("AbortError", "Aborted due to security policy.");

export class ShimDirectory implements FsDirectory {
  constructor(
    readonly dirPath: string,
    readonly faults: ShimFaults = {}
  ) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsDirectory> {
    const p = path.join(this.dirPath, name);
    if (options?.create) {
      if (this.faults.dirCreateAborts) {
        this.faults.dirCreateAborts--;
        throw abortError();
      }
      if (this.faults.dirCreateDelayMs) await new Promise((r) => setTimeout(r, this.faults.dirCreateDelayMs));
      await fs.mkdir(p, { recursive: true });
    } else {
      const st = await fs.stat(p).catch(() => null);
      if (!st?.isDirectory()) throw new NamedError("NotFoundError", `no directory ${name}`);
    }
    return new ShimDirectory(p, this.faults);
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFile> {
    const p = path.join(this.dirPath, name);
    const st = await fs.stat(p).catch(() => null);
    if (!st?.isFile()) {
      if (!options?.create) throw new NamedError("NotFoundError", `no file ${name}`);
      await (await fs.open(p, "a")).close(); // touch, like Chrome's create:true
    }
    return new ShimFile(p, name, this.faults);
  }

  async *keys(): AsyncIterableIterator<string> {
    yield* await fs.readdir(this.dirPath);
  }
}

class ShimFile implements FsFile {
  constructor(
    private readonly filePath: string,
    private readonly name: string,
    private readonly faults: ShimFaults = {}
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
    const faults = this.faults;
    return {
      async write(data: Uint8Array<ArrayBuffer>): Promise<void> {
        await fh.write(data);
      },
      async close(): Promise<void> {
        if (faults.closeAborts) {
          // Truthful abort emulation: the swap file is abandoned, nothing
          // becomes visible at the target name (#37).
          faults.closeAborts--;
          await fh.close();
          await fs.unlink(tmp).catch(() => {});
          throw abortError();
        }
        await fh.close();
        await fs.rename(tmp, target);
      },
    };
  }
}
