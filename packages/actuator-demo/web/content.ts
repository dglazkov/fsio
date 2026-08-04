// What a tab is showing, as bytes.
//
// A tab holds a reference — a path in the folder, or a file id in this
// browser's storage — and never the contents (src/model.ts). This module is
// the one place that turns either reference into something renderable, and
// keeping both behind one function is deliberate: the viewer must not be
// able to tell where the bytes came from, because the whole claim of the
// second act is that a copy and a window look the same until the folder
// goes away.
//
// Two viewers, text and image, chosen by MIME (`viewerFor`). A third would
// be a case here and a branch in the tab renderer, which is what "we can
// imagine various viewers" has to mean before it means anything.
import { basename, mimeFor, viewerFor, type TabBody } from "../src/model";
import { getBlob } from "./db";
import { readFileAt, watchForChanges } from "./folder";
import { reporter } from "./reporter";
import { app, content, type Loaded } from "./state";

/** Beyond this, a text view shows the head of the file and says so. The
 *  page is a demo viewer, not an editor, and a 40 MB log in a <pre> is a
 *  frozen tab rather than a feature. */
const TEXT_LIMIT = 256 * 1024;

const inFlight = new Set<string>();

export const keyFor = (body: TabBody): string | null =>
  body.kind === "local" ? `local:${body.path}` : body.kind === "held" ? `held:${body.fileId}` : null;

/** The loaded bytes for a tab, if they are loaded, and a load started if
 *  they are not. Safe to call from render: a key already loading is
 *  ignored, and the result arrives as a signal update. */
export function contentFor(body: TabBody): Loaded | null {
  const key = keyFor(body);
  if (!key) return null;
  const have = content.get().get(key) ?? null;
  if (!have && !inFlight.has(key)) void load(body, key);
  return have;
}

/** Load (or reload) one reference. Reloading is the point for local files:
 *  the folder poll calls this when a file under an open tab changes. */
export async function load(body: TabBody, key = keyFor(body)): Promise<void> {
  if (!key || inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const blob =
      body.kind === "local"
        ? await readFileAt(body.path)
        : body.kind === "held"
          ? await getBlob(body.fileId)
          : null;
    // A held file's name and type come from the catalog rather than the
    // blob: the catalog is what the CLI reported and what the page shows,
    // and a blob whose type was lost would otherwise silently lose its
    // viewer.
    const file = body.kind === "held" ? app.get().held.find((h) => h.id === body.fileId) : undefined;
    const name = body.kind === "local" ? basename(body.path) : (file?.name ?? key);
    put(key, blob ? await decode(blob, file?.type || blob.type || mimeFor(name)) : missing());
  } finally {
    inFlight.delete(key);
  }
}

/** Re-read every open window onto the folder.
 *
 *  Called when a folder is granted, and it is not an optimization. A page
 *  that reloads with a local tab active renders before the grant is back,
 *  so the read finds no folder and the tab caches "gone" — truthfully, at
 *  that instant, and then permanently, because a file that never changes
 *  never triggers a reload. Every revisit would open on a wall of tabs
 *  claiming their files had been deleted. */
export function reloadLocalViews(): void {
  for (const key of content.get().keys()) {
    if (key.startsWith("local:")) void load({ kind: "local", path: key.slice("local:".length) }, key);
  }
}

/** Forget one reference — its tab closed, or its file was dropped. Object
 *  URLs are the reason this exists: they are held by the document until
 *  revoked, so a page that never forgets pins every image it ever showed. */
export function forget(key: string): void {
  const map = new Map(content.get());
  const old = map.get(key);
  if (old?.url) URL.revokeObjectURL(old.url);
  map.delete(key);
  content.set(map);
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

/** Local views follow the file. Held copies do not — that is what being a
 *  copy means, and re-flinging is how you take a newer one. */
watchForChanges((paths) => {
  for (const path of paths) {
    const key = `local:${path}`;
    if (content.get().has(key)) void load({ kind: "local", path }, key);
  }
});
