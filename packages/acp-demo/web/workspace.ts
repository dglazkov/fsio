// The right-hand pane: the folder, as the page sees it.
//
// This is the half of the demo that has nothing to do with ACP and is the
// reason the demo is a page rather than a terminal. The same directory
// handle that carries the transport also lets the page *look* at the files
// — so when the agent edits something, you watch it change next to the
// sentence where it said it would. One grant, two uses (P1: the URL
// travels, the data stays).
//
// Polling, not FileSystemObserver: F19 has observe() stalling without
// rejecting in the wild (0-for-11), and F9 has it dying outright under
// temp dirs. A 2 s walk of a working folder is cheap and never lies. If
// the observer story improves, this is the one place that changes.
//
// The same walk also answers the other question the pane now gets asked:
// show me this one. `readFileAt` is the whole of it — one grant, and the page
// can read anything under it without asking anybody, which is why opening a
// file here moves nothing and costs nothing (files.ts).
import { files, workspaceNote, type FileRow } from "./state";
import { reporter } from "./reporter";

const POLL_MS = 2000;
/** Enough to show a working folder; a repo checkout is not a file browser. */
const MAX_FILES = 400;
const SKIP = new Set([".fsio", ".git", "node_modules", "dist", ".next", "target", ".venv"]);

let root: FileSystemDirectoryHandle | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let scanning = false;
let known = new Map<string, { size: number; modified: number; seenChanged: number }>();
let first = true;
/** Called after every scan that saw something move, so open views of changed
 *  files re-read themselves. Set by files.ts. */
let onChange: ((paths: string[]) => void) | null = null;

export function startWatching(handle: FileSystemDirectoryHandle): void {
  root = handle;
  clearInterval(timer);
  timer = setInterval(() => void scan(), POLL_MS);
  void scan();
}

export function watchForChanges(fn: (paths: string[]) => void): void {
  onChange = fn;
}

/** A folder-relative path, or null if it is not one this page may read. The
 *  page's reach is exactly the folder it was granted, so a path that climbs
 *  out of it, starts at the root or names a drive is refused here rather than
 *  handed to Chrome to refuse. */
function safeRelPath(input: string): string | null {
  if (typeof input !== "string" || input === "") return null;
  if (input.startsWith("/") || /^[a-zA-Z]:/.test(input)) return null;
  if (input.includes("\0") || input.includes("\\")) return null;
  const parts = input.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

/** The bytes at a folder-relative path, right now. Null means the file is not
 *  there — a normal answer, not an error: the folder is a live thing and this
 *  page is one of several parties looking at it, the agent being the busiest. */
export async function readFileAt(path: string): Promise<File | null> {
  const safe = root && safeRelPath(path);
  if (!root || !safe) return null;
  const parts = safe.split("/");
  const name = parts.pop()!;
  let dir: FileSystemDirectoryHandle = root;
  try {
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return null; // gone, or a torn/locked read: normal (invariant 3, F11)
  }
}

/** Rescan now — called when the agent reports an edit, so the pane reacts
 *  at the speed of the conversation instead of the poll. */
export async function touched(): Promise<void> {
  await scan();
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
    // A file that vanished is news too, and it is the news an open tab most
    // needs: a window onto someone else's disk has to go dark when the file
    // does. Only trustworthy when the walk saw everything — under truncation
    // "not in `found`" means "past the cap" as often as it means "gone".
    if (!truncated) {
      const here = new Set(found.map((r) => r.path));
      for (const path of known.keys()) if (!here.has(path)) changed.push(path);
    }
    // Most recently changed first. The pane draws a tree now and sorts its own
    // rows by name, so this ordering is no longer what anybody looks at — it
    // is kept because `files` is a list of what is in the folder and a stable,
    // meaningful order costs one comparison.
    found.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
    known = new Map(found.map((r) => [r.path, { size: r.size, modified: r.modified, seenChanged: r.seenChanged }]));
    files.set(found);
    workspaceNote.set(truncated ? `first ${MAX_FILES} files` : `${found.length} file${found.length === 1 ? "" : "s"}`);
    first = false;
    // An open view of a file that just changed is stale the moment we know it
    // changed — this is what makes an opened file a live window rather than a
    // read. The agent edits it, and the tab you are looking at follows.
    if (changed.length && onChange) onChange(changed);
  } finally {
    scanning = false;
  }
}

export function stopWatching(): void {
  clearInterval(timer);
  root = null;
  known = new Map();
  first = true;
}
