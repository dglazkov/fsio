// Opening a file: the tab, and the bytes behind it.
//
// The pane on the right has always been able to SEE the folder — same handle
// as the transport, read directly by the page, no server (P1: the URL
// travels, the data stays). What it could not do was let you look inside one,
// so the demo's best moment stopped one step short: the agent says it edited
// `src/state.ts`, the row lights up, and to read what it wrote you went to
// another window.
//
// Now the row opens. A tab is a path and nothing else — no bytes in page
// state, no copy anywhere — so what you are reading is the file on your disk
// as it is right now, and it follows the file: the folder walk reports a
// change and the open view re-reads itself, which is how you watch the agent
// write a file while it is telling you it did.
//
// The other side of that bargain, said out loud because a demo about custody
// has to: nothing here survives the grant. Revoke the folder and every tab in
// here is an empty window. The actuator demo is where the opposite is argued
// — a flung copy the page owns — and the two demos are the two answers to the
// same question rather than one being the better version.
import { activeFile, fileContent, fileTabs, type FileTab, type Loaded, type Viewer } from "./state";
import { reporter } from "./reporter";
import { readFileAt, watchForChanges } from "./workspace";

/** Beyond this, the text view shows the head of the file and says so. This is
 *  a reader, not an editor, and a 40 MB log in a <pre> is a frozen tab rather
 *  than a feature. */
const TEXT_LIMIT = 256 * 1024;

/** A guess from the extension, which is all a viewer choice needs: it is not
 *  a security boundary, and sniffing the bytes would be a bigger lie than the
 *  name is. */
const TYPES: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", markdown: "text/markdown",
  json: "application/json", jsonl: "application/json",
  js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript",
  ts: "text/typescript", tsx: "text/typescript", jsx: "text/javascript",
  css: "text/css", html: "text/html", xml: "text/xml", yml: "text/yaml", yaml: "text/yaml",
  csv: "text/csv", log: "text/plain", sh: "text/plain", toml: "text/plain",
  py: "text/plain", rs: "text/plain", go: "text/plain", c: "text/plain", h: "text/plain",
  gitignore: "text/plain",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon",
};

export const basename = (path: string): string => path.split("/").pop() || path;

function mimeFor(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return TYPES[ext] ?? "application/octet-stream";
}

/** Which viewer a type gets. Two of them, and everything else says so rather
 *  than rendering a megabyte of mojibake. A third viewer is a case here and a
 *  branch in the viewer component, which is all "we could show more kinds"
 *  ever has to mean. */
function viewerFor(type: string): Viewer {
  if (type === "image/svg+xml" || type === "application/json") return "text";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("text/")) return "text";
  return "none";
}

export const fileTabId = (path: string): string => `file:${path}`;
export const isFileTab = (id: string): boolean => id.startsWith("file:");

/** Put a file on screen. Opening one that is already open is a request to
 *  look at it, not to collect tabs — the window that exists comes forward. */
export function openFile(path: string): void {
  const id = fileTabId(path);
  const had = fileTabs.get().some((t) => t.id === id);
  if (!had) fileTabs.set([...fileTabs.get(), { id, path }]);
  activeFile.set(id);
  reporter.event("file-open", { path, reused: had });
}

/** Bring an already-open file forward. What the strip calls when its chip is
 *  a file rather than a conversation. */
export function showFile(id: string): void {
  if (!fileTabs.get().some((t) => t.id === id)) return;
  activeFile.set(id);
}

/** Close a window. The file is untouched — the page never had it — so this
 *  costs nothing and asks nothing, which is why the strip's confirm has
 *  nothing to say about a file chip.
 *
 *  What you land on afterwards is the conversation you were in, because
 *  `activeId` never stopped pointing at it. */
export function closeFile(id: string): void {
  const rest = fileTabs.get().filter((t) => t.id !== id);
  const gone = fileTabs.get().find((t) => t.id === id);
  fileTabs.set(rest);
  if (gone) forget(gone.path);
  if (activeFile.get() !== id) return;
  // Sideways to the next file if there is one, otherwise back to the
  // conversation. A page that jumped to the chat every time you closed one of
  // four open files would make reading two files a chore.
  activeFile.set(rest.length ? rest[rest.length - 1]!.id : null);
}

/** Every open window shut, e.g. when the folder goes. */
export function closeAllFiles(): void {
  for (const t of fileTabs.get()) forget(t.path);
  fileTabs.set([]);
  activeFile.set(null);
}

export const fileTabFor = (id: string | null): FileTab | null =>
  fileTabs.get().find((t) => t.id === id) ?? null;

const inFlight = new Set<string>();

/** The bytes for a path, if they are loaded, and a load started if they are
 *  not. Safe to call from render: a path already loading is ignored and the
 *  result arrives as a signal update. */
export function contentFor(path: string): Loaded | null {
  const have = fileContent.get().get(path) ?? null;
  if (!have && !inFlight.has(path)) void load(path);
  return have;
}

/** Read (or re-read) one path. Re-reading is the point: the folder walk calls
 *  this when a file under an open tab moves. */
export async function load(path: string): Promise<void> {
  if (inFlight.has(path)) return;
  inFlight.add(path);
  try {
    const file = await readFileAt(path);
    put(path, file ? await decode(path, file) : missing(path));
  } finally {
    inFlight.delete(path);
  }
}

function put(path: string, next: Loaded): void {
  const map = new Map(fileContent.get());
  const old = map.get(path);
  // Every read and every re-read, in the report — this is the only way the
  // native side of the verification loop can see that an opened file is a
  // live window rather than a one-time read: touch the file, and a second
  // `view` event lands for the same path (TESTING.md).
  reporter.event("view", { path, viewer: next.viewer, size: next.size, missing: next.missing, reload: old !== undefined });
  // Object URLs are held by the document until revoked, so a page that never
  // forgets pins every version of every image it ever showed.
  if (old?.url && old.url !== next.url) URL.revokeObjectURL(old.url);
  map.set(path, next);
  fileContent.set(map);
}

function forget(path: string): void {
  const map = new Map(fileContent.get());
  const old = map.get(path);
  if (old?.url) URL.revokeObjectURL(old.url);
  map.delete(path);
  fileContent.set(map);
}

const missing = (path: string): Loaded => ({
  path,
  viewer: "none",
  type: "",
  size: 0,
  text: null,
  url: null,
  truncated: false,
  missing: true,
  loadedAt: Date.now(),
});

async function decode(path: string, file: File): Promise<Loaded> {
  const type = file.type || mimeFor(basename(path));
  const viewer = viewerFor(type);
  const base = { path, viewer, type, size: file.size, truncated: false, missing: false, loadedAt: Date.now() };
  if (viewer === "text") {
    const head = file.size > TEXT_LIMIT ? file.slice(0, TEXT_LIMIT) : file;
    return { ...base, text: await head.text(), url: null, truncated: file.size > TEXT_LIMIT };
  }
  if (viewer === "image") return { ...base, text: null, url: URL.createObjectURL(file) };
  return { ...base, text: null, url: null };
}

// An open window follows its file. Registered once, at module load, because
// there is exactly one folder walk and exactly one thing to do with what it
// saw change.
watchForChanges((paths) => {
  const open = new Set(fileTabs.get().map((t) => t.path));
  for (const path of paths) if (open.has(path)) void load(path);
});
