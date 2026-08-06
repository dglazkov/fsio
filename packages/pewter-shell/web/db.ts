// Where a flung copy lives: IndexedDB, in the browser, owned by the page.
//
// This is the half of a pewter the folder never sees. `pewt fling report.html`
// asks the page to read a file it can already read and *keep* it; what
// travelled was the asking, and the bytes went from the granted folder into
// this store without touching a session (P1, P2). That is what makes the tab
// outlive the file, the host, and the grant.
//
// It is also the first thing in Pewter that survives a page load. Tabs do not
// — a tab exists because a browser is open — so a copy and the tab that was
// showing it have different lifetimes on purpose, and `pewt files` is how you
// find one again.
//
// **Keyed by the pewter's name.** One origin serves every pewter anybody
// opens, so a single bucket would show one folder's copies in another folder's
// page. The name is the folder's basename, which is not unique on a machine:
// two pewters called `site` share a catalog. Stated rather than solved — the
// shell holds no stronger identity for a folder today, and inventing one is a
// question about what a pewter *is* rather than about storage.
import type { HeldFile } from "pewter";

const DB_NAME = "pewter-shell";
const DB_VERSION = 1;
const CATALOG_STORE = "catalog";
const BLOB_STORE = "blobs";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function open(): Promise<IDBDatabase> {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    for (const name of [CATALOG_STORE, BLOB_STORE]) {
      if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    }
  };
  return req(request);
}

async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await open()).transaction(name, mode).objectStore(name);
}

/** A blob's key. Prefixed with the pewter so a sweep can tell one folder's
 *  bytes from another's without opening either. */
const blobKey = (pewter: string, fileId: string): string => `${pewter}/${fileId}`;

/** The copies this pewter's page holds, from the last time it held any.
 *
 *  A store that will not open — private browsing, a browser with IndexedDB
 *  disabled — is an empty catalog rather than a broken page: `pewt fling` will
 *  refuse with the store's own words when it is tried, which is a better place
 *  to learn it than a shell that would not start. */
export async function loadCatalog(pewter: string): Promise<HeldFile[]> {
  try {
    const files = (await req((await store(CATALOG_STORE, "readonly")).get(pewter))) as HeldFile[] | undefined;
    return files ?? [];
  } catch {
    return [];
  }
}

export async function saveCatalog(pewter: string, files: HeldFile[]): Promise<void> {
  try {
    await req((await store(CATALOG_STORE, "readwrite")).put(files, pewter));
  } catch {
    // A page that cannot persist can still be driven, and the copy it just
    // took is in the blob store either way. Losing the catalog write costs a
    // reload's worth of memory, not the command.
  }
}

/** Take custody of some bytes. Throws with the browser's own words, because
 *  the realistic failure is a quota and that is the page's answer to give:
 *  nothing is committed, and whoever asked hears a refusal rather than a
 *  success they cannot see. */
export async function keepBlob(pewter: string, fileId: string, blob: Blob): Promise<void> {
  await req((await store(BLOB_STORE, "readwrite")).put(blob, blobKey(pewter, fileId)));
}

export async function blobFor(pewter: string, fileId: string): Promise<Blob | null> {
  try {
    return ((await req((await store(BLOB_STORE, "readonly")).get(blobKey(pewter, fileId)))) as Blob | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Losing the bytes is not a reason to keep the entry: the catalog is what the
 *  page shows, and a delete that failed leaves a blob nobody can name. */
export async function dropBlob(pewter: string, fileId: string): Promise<void> {
  try {
    await req((await store(BLOB_STORE, "readwrite")).delete(blobKey(pewter, fileId)));
  } catch {}
}

/** Bytes this pewter's catalog does not name.
 *
 *  A fling stores the blob *before* it commits the catalog, so the two can
 *  only disagree in the harmless direction — bytes with no entry, never an
 *  entry with no bytes. This is the sweep for the harmless one, run once on
 *  load where it costs nothing and cannot race a command. */
export async function sweepBlobs(pewter: string, files: HeldFile[]): Promise<void> {
  try {
    const s = await store(BLOB_STORE, "readwrite");
    const keys = (await req(s.getAllKeys())) as IDBValidKey[];
    const named = new Set(files.map((f) => blobKey(pewter, f.id)));
    for (const key of keys) {
      if (typeof key === "string" && key.startsWith(`${pewter}/`) && !named.has(key)) s.delete(key);
    }
  } catch {}
}
