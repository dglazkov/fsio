// The granted folder, as the page sees it.
//
// Nothing here goes through fsio. It is the same directory handle the
// transport rides on, read directly by the page — one grant, two uses. That
// is what makes `open` a different thing from `fling`: the page can already
// *look* at everything in this folder, so opening a file moves nothing and
// costs nothing, and the tab it produces is a window rather than a copy.
//
// Polling, not FileSystemObserver: F19 has observe() stalling without
// rejecting in the wild (0-for-11), and F9 has it dying outright under temp
// dirs. A 2 s walk of a working folder is cheap and never lies. If the
// observer story improves, this is the one place that changes.
//
// This is the second copy of this walk in the repo — acp-demo's
// web/workspace.ts is the first, and the two disagree about enough (this
// one is a picker, that one is a feed) that merging them is a question
// about what a shared pane would be, not a mechanical extraction. Filed
// rather than answered here (PROCESS.md rule 6).
import { safeRelPath } from "../src/model";
import { folderFiles, folderNote, type FileRow } from "./state";
import { reporter } from "./reporter";

const POLL_MS = 2000;
/** Enough to show a working folder; a repo checkout is not a file browser. */
const MAX_FILES = 300;
const SKIP = new Set([".fsio", ".git", "node_modules", "dist", ".next", "target", ".venv"]);

let root: FileSystemDirectoryHandle | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let scanning = false;
let known = new Map<string, { size: number; modified: number; seenChanged: number }>();
let first = true;
/** Called after every scan that saw something change, so open views of
 *  changed files re-read themselves. Set by content.ts. */
let onChange: ((paths: string[]) => void) | null = null;

export function startWatching(handle: FileSystemDirectoryHandle): void {
  root = handle;
  clearInterval(timer);
  timer = setInterval(() => void scan(), POLL_MS);
  void scan();
}

export function stopWatching(): void {
  clearInterval(timer);
  root = null;
  known = new Map();
  first = true;
  folderFiles.set([]);
  folderNote.set("no folder");
}

export function watchForChanges(fn: (paths: string[]) => void): void {
  onChange = fn;
}

export const watching = (): boolean => root !== null;

/** The file handle at a folder-relative path, or null. The path is
 *  re-validated here even though the reducer already did it: this is the
 *  function that turns a string into filesystem reach, and it is the last
 *  place that can refuse. */
export async function fileAt(path: string): Promise<FileSystemFileHandle | null> {
  const safe = root && safeRelPath(path);
  if (!root || !safe) return null;
  const parts = safe.split("/");
  const name = parts.pop()!;
  let dir: FileSystemDirectoryHandle = root;
  try {
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    return await dir.getFileHandle(name);
  } catch {
    return null;
  }
}

/** The bytes at a folder-relative path, right now. Null means the file is
 *  not there — which is a normal answer, not an error: the folder is a live
 *  thing and the page is one of several parties looking at it. */
export async function readFileAt(path: string): Promise<File | null> {
  const handle = await fileAt(path);
  if (!handle) return null;
  try {
    return await handle.getFile();
  } catch {
    return null; // torn/locked read: normal (invariant 3, F11)
  }
}

async function scan(): Promise<void> {
  if (!root || scanning) return;
  scanning = true;
  try {
    const found: FileRow[] = [];
    const changed: string[] = [];
    let truncated = false;
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      if (found.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      for await (const [name, handle] of dir.entries()) {
        if (found.length >= MAX_FILES) {
          truncated = true;
          return;
        }
        if (name.startsWith(".") && name !== ".gitignore") continue;
        if (SKIP.has(name)) continue;
        const path = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === "directory") {
          await walk(handle as FileSystemDirectoryHandle, path);
        } else {
          try {
            const f = await (handle as FileSystemFileHandle).getFile();
            const prev = known.get(path);
            const moved = !prev || prev.size !== f.size || prev.modified !== f.lastModified;
            const seenChanged = moved && !first ? Date.now() : (prev?.seenChanged ?? 0);
            if (moved && !first) {
              changed.push(path);
              reporter.event("file-changed", { path, size: f.size });
            }
            found.push({ path, size: f.size, modified: f.lastModified, seenChanged });
          } catch {
            // torn/locked read: normal (invariant 3, F11) — try again next poll
          }
        }
      }
    };
    await walk(root, "");
    // A file that vanished is news too, and it is the news this demo most
    // needs to deliver: an opened file is a window onto someone else's
    // disk, so the tab has to go dark when the file does. Only trustworthy
    // when the walk saw everything — under truncation, "not in `found`"
    // means "past the cap" as often as it means "gone".
    if (!truncated) {
      const here = new Set(found.map((r) => r.path));
      for (const path of known.keys()) if (!here.has(path)) changed.push(path);
    }
    // Most recently changed first: a file you just touched is the one you
    // are about to open.
    found.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
    known = new Map(found.map((r) => [r.path, { size: r.size, modified: r.modified, seenChanged: r.seenChanged }]));
    folderFiles.set(found);
    folderNote.set(truncated ? `first ${MAX_FILES}` : `${found.length} file${found.length === 1 ? "" : "s"}`);
    first = false;
    // An open view of a file that just changed is stale the moment we know
    // it changed. This is what makes `open` a live window rather than a
    // read: edit the file in your editor and the tab follows.
    if (changed.length && onChange) onChange(changed);
  } finally {
    scanning = false;
  }
}
