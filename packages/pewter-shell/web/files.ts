// What a file tab is showing, as bytes.
//
// A tab holds a reference — a path in the pewter, or the id of a copy in this
// browser's storage — and never the contents. This module is the one place
// that turns either reference into something renderable, and keeping both
// behind one function is deliberate: the viewer must not be able to tell where
// the bytes came from, because "a copy and a window look the same until the
// folder goes away" is the claim `pewt open` and `pewt fling` exist to make.
//
// Two viewers, text and image, chosen by MIME (`viewerFor`, in the `pewter`
// package). A third would be a case there and a branch in the viewer
// component, which is what "various viewers" has to mean before it means
// anything.
//
// Harvested from `actuator-demo/web/content.ts`, which had the same two tab
// kinds. What did not come across is that demo's folder walk: it needed a file
// *listing* for its picker pane, and the shell needs no listing at all — so
// what is watched here is the handful of paths tabs are open on, not the
// folder. A repo checkout is not a file browser.
import { basename, mimeFor, viewerFor, type TabBody } from "pewter";
import { blobFor } from "./db";
import { reporter } from "./reporter";
import { fileAt } from "./session";
import { content, pewterName, tabs, type Loaded } from "./state";

/** Beyond this, a text view shows the head of the file and says so. The shell
 *  is a viewer, not an editor, and a 40 MB log in a `<pre>` is a frozen tab
 *  rather than a feature. */
const TEXT_LIMIT = 256 * 1024;

/** How often an open window re-checks the file under it. The same 2 s the
 *  other pages walk their folders at, and for the same reason: polling rather
 *  than FileSystemObserver, which stalls without rejecting in the wild (F19)
 *  and dies outright under temp directories (F9). */
const POLL_MS = 2000;

const inFlight = new Set<string>();

export const keyFor = (body: TabBody): string | null =>
  body.kind === "file" ? `file:${body.path}` : body.kind === "held" ? `held:${body.fileId}` : null;

/** The loaded bytes for a tab, if they are loaded, and a load started if they
 *  are not. Safe to call from render: a key already loading is ignored, and
 *  the result arrives as a signal update. */
export function contentFor(body: TabBody): Loaded | null {
  const key = keyFor(body);
  if (!key) return null;
  const have = content.get().get(key) ?? null;
  if (!have && !inFlight.has(key)) void load(body, key);
  return have;
}

/** Load (or reload) one reference. Reloading is the point for a window: the
 *  poll below calls this when the file under an open tab changes. */
export async function load(body: TabBody, key = keyFor(body)): Promise<void> {
  if (!key || inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const blob = body.kind === "file" ? await fileAt(body.path) : body.kind === "held" ? await blobFor(pewterName.get(), body.fileId) : null;
    // A held copy's name and type come from the catalog rather than the blob:
    // the catalog is what `pewt files` reported and what the page shows, and a
    // blob whose type was lost would otherwise silently lose its viewer.
    const file = body.kind === "held" ? tabs.get().held.find((h) => h.id === body.fileId) : undefined;
    const name = body.kind === "file" ? basename(body.path) : (file?.name ?? key);
    put(key, blob ? await decode(blob, file?.type || blob.type || mimeFor(name)) : missing());
  } finally {
    inFlight.delete(key);
  }
}

/** Forget one reference — its tab closed, or its copy was dropped. Object URLs
 *  are the reason this exists: they are held by the document until revoked. */
export function forget(key: string): void {
  const map = new Map(content.get());
  const old = map.get(key);
  if (old?.url) URL.revokeObjectURL(old.url);
  map.delete(key);
  content.set(map);
}

/** Re-read every open window.
 *
 *  Called when the folder is granted, and it is not an optimization. A window
 *  loaded before the grant is back reads nothing, caches "gone" — truthfully,
 *  at that instant — and then stays that way, because a file that never
 *  changes never triggers a reload. */
export function reloadFileViews(): void {
  for (const key of content.get().keys()) {
    if (key.startsWith("file:")) void load({ kind: "file", path: key.slice("file:".length) }, key);
  }
}

let timer: ReturnType<typeof setInterval> | undefined;

/** Windows follow their files.
 *
 *  Every open `file:` tab is re-stat'ed on a timer and re-read when its size or
 *  mtime moved, or when it stopped being there. That last one is the news this
 *  costs a poll to deliver: an opened file is a window onto a disk somebody
 *  else is also using, so the tab has to go dark when the file does — and that
 *  is exactly what a flung copy does not do. */
export function watchOpenFiles(): void {
  clearInterval(timer);
  timer = setInterval(() => void sweep(), POLL_MS);
}

async function sweep(): Promise<void> {
  const paths = new Set<string>();
  for (const tab of tabs.get().tabs) if (tab.body.kind === "file") paths.add(tab.body.path);
  for (const path of paths) {
    const key = `file:${path}`;
    const have = content.get().get(key);
    if (!have || inFlight.has(key)) continue;
    const file = await fileAt(path);
    // Nothing there any more, or something different there now. Both are a
    // reload; the difference between them is what the reload finds.
    const moved = file ? file.size !== have.size || file.lastModified > have.loadedAt : !have.missing;
    if (moved) void load({ kind: "file", path }, key);
  }
}

function put(key: string, next: Omit<Loaded, "key">): void {
  const map = new Map(content.get());
  const old = map.get(key);
  // Every load and every reload, in the report — this is the only place the
  // native side can see that an opened file is a live window rather than a
  // one-time read: touch the file, and a second `view` event lands for the
  // same key (TESTING.md).
  reporter.event("view", { key, viewer: next.viewer, size: next.size, missing: next.missing, reload: old !== undefined });
  if (old?.url && old.url !== next.url) URL.revokeObjectURL(old.url);
  map.set(key, { key, ...next });
  content.set(map);
}

const missing = (): Omit<Loaded, "key"> => ({
  viewer: "none",
  type: "",
  size: 0,
  text: null,
  url: null,
  truncated: false,
  missing: true,
  loadedAt: Date.now(),
});

async function decode(blob: Blob, type: string): Promise<Omit<Loaded, "key">> {
  const viewer = viewerFor(type);
  const base = { viewer, type, size: blob.size, truncated: false, missing: false, loadedAt: Date.now() };
  if (viewer === "text") {
    const head = blob.size > TEXT_LIMIT ? blob.slice(0, TEXT_LIMIT) : blob;
    return { ...base, text: await head.text(), url: null, truncated: blob.size > TEXT_LIMIT };
  }
  if (viewer === "image") return { ...base, text: null, url: URL.createObjectURL(blob) };
  return { ...base, text: null, url: null };
}
