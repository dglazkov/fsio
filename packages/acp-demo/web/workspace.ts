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

export function startWatching(handle: FileSystemDirectoryHandle): void {
  root = handle;
  clearInterval(timer);
  timer = setInterval(() => void scan(), POLL_MS);
  void scan();
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
            const changed = !prev || prev.size !== f.size || prev.modified !== f.lastModified;
            const seenChanged = changed && !first ? Date.now() : (prev?.seenChanged ?? 0);
            if (changed && !first) reporter.event("file-changed", { path, size: f.size });
            found.push({ path, size: f.size, modified: f.lastModified, seenChanged });
          } catch {
            // torn/locked read: normal (invariant 3, F11) — try again next poll
          }
        }
      }
    };
    await walk(root, "");
    // Most recently changed first: the demo's whole point is watching a
    // file move to the top while the agent talks about it.
    found.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
    known = new Map(found.map((r) => [r.path, { size: r.size, modified: r.modified, seenChanged: r.seenChanged }]));
    files.set(found);
    workspaceNote.set(truncated ? `first ${MAX_FILES} files` : `${found.length} file${found.length === 1 ? "" : "s"}`);
    first = false;
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
