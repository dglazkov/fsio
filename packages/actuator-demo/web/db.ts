// Where the application lives: IndexedDB, in the browser, owned by the page.
//
// This is the half of the demo the folder never sees. A command arrives,
// the page applies it here, and what travelled was the *asking* — the state
// itself has never been anywhere else (P1). The same store holds the
// directory handle, so a revisit skips the picker (F20).
//
// Three stores, and the split between the first two is the point of the
// second act:
//
//   app     — the state: tabs, which is active, and the catalog of files
//             this page has custody of. Small, and JSON all the way down.
//   blobs   — the bytes behind the catalog. A flung file lands here and
//             stops needing the folder, the helper, or the machine's
//             filesystem; this is the store that survives a revoked grant.
//   handles — the granted directory handle, so a revisit skips the picker.
import { apply, AppError, initialState, type AppState, type Operation, type Tab } from "../src/model";
import { fromBase64 } from "../src/bytes";
import { app } from "./state";

const DB_NAME = "fsio-actuator-demo";
const DB_VERSION = 2; // 2 added `blobs` — the flung files' bytes
const STATE_STORE = "app";
const HANDLE_STORE = "handles";
const BLOB_STORE = "blobs";
const STATE_KEY = "state";
const HANDLE_KEY = "root";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function open(): Promise<IDBDatabase> {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    // Runs both for a first-run page and for one upgrading from v1, so
    // every store is created only if it is missing.
    const db = request.result;
    for (const name of [STATE_STORE, HANDLE_STORE, BLOB_STORE]) {
      if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    }
  };
  return req(request);
}

async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await open()).transaction(name, mode).objectStore(name);
}

/** A tab from an older build of this page, brought forward. v1 tabs were
 *  `{ id, title, message }`; a tab is now showing one of three things, and
 *  what those tabs were showing was a message. Cheaper than making everyone
 *  who has run this demo clear their storage, and it is nine lines. */
function migrateTab(tab: Tab & { message?: string }): Tab {
  if (tab.body) return tab;
  return { id: tab.id, title: tab.title, body: { kind: "message", message: tab.message ?? "" } };
}

/** Load the app into the `app` signal, seeding a first-run state. */
export async function loadApp(): Promise<AppState> {
  let state: AppState;
  try {
    const stored = (await req((await store(STATE_STORE, "readonly")).get(STATE_KEY))) as AppState | undefined;
    state = stored
      ? { tabs: (stored.tabs ?? []).map(migrateTab), activeId: stored.activeId ?? null, held: stored.held ?? [] }
      : initialState();
  } catch {
    state = initialState(); // IndexedDB unavailable (private mode) — run in memory
  }
  app.set(state);
  return state;
}

async function persist(state: AppState): Promise<void> {
  try {
    await req((await store(STATE_STORE, "readwrite")).put(state, STATE_KEY));
  } catch {
    // A page that cannot persist can still be driven; losing the write is
    // worth less than refusing the command in front of an audience.
  }
}

/** Apply one operation and persist the result.
 *
 *  Read-modify-write across two transactions rather than one: the page is
 *  the only writer, and commands are applied one at a time as they arrive
 *  off a single session. What this does NOT survive is the page dying
 *  between applying and answering — the CLI times out, the change stands,
 *  and a retry duplicates it. Stated rather than solved: a dedup ledger is
 *  real machinery, and the pattern has not yet asked for one.
 *
 *  The two file operations that move bytes do their store work *before* the
 *  state is committed, so the catalog and the blobs cannot disagree in the
 *  direction that shows: an entry with no bytes behind it. The other
 *  direction — bytes with no entry — is a leak of one blob, and the drop
 *  path sweeps those on load. */
export async function applyToApp(op: Operation): Promise<Record<string, unknown>> {
  const next = apply(app.get(), op);

  if (op.method === "files.fling") {
    const fileId = String(next.result["fileId"]);
    const blob = new Blob([fromBase64(op.params.data)], { type: op.params.type });
    try {
      await req((await store(BLOB_STORE, "readwrite")).put(blob, fileId));
    } catch (e) {
      // Out of quota is the realistic one, and it is the page's own answer
      // to give: nothing is committed, and the CLI hears a refusal rather
      // than a success it cannot see.
      throw new AppError(
        "store_failed",
        `this browser would not store ${op.params.name}: ${e instanceof Error ? e.message : String(e)}`,
        "the page holds flung files in IndexedDB — `actuator files drop <id>` frees some"
      );
    }
    const superseded = next.result["superseded"];
    if (typeof superseded === "string") await dropBlob(superseded);
  }

  if (op.method === "files.drop") await dropBlob(op.params.id);

  app.set(next.state);
  void persist(next.state);
  return next.result;
}

export async function getBlob(fileId: string): Promise<Blob | null> {
  try {
    return ((await req((await store(BLOB_STORE, "readonly")).get(fileId))) as Blob | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Losing the bytes is not a reason to keep the entry: the catalog is what
 *  the page shows, and a delete that failed leaves a blob nobody can name. */
async function dropBlob(fileId: string): Promise<void> {
  try {
    await req((await store(BLOB_STORE, "readwrite")).delete(fileId));
  } catch {}
}

/** Blobs no catalog entry names — the leak the ordering above allows. Runs
 *  once on load, where it costs nothing and cannot race a command. */
export async function sweepBlobs(state: AppState): Promise<void> {
  try {
    const s = await store(BLOB_STORE, "readwrite");
    const keys = (await req(s.getAllKeys())) as IDBValidKey[];
    const named = new Set(state.held.map((h) => h.id));
    for (const key of keys) {
      if (typeof key === "string" && !named.has(key)) s.delete(key);
    }
  } catch {}
}

export async function savedHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await req((await store(HANDLE_STORE, "readonly")).get(HANDLE_KEY))) ?? null;
  } catch {
    return null;
  }
}

export async function saveHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    await req((await store(HANDLE_STORE, "readwrite")).put(handle, HANDLE_KEY));
  } catch {}
}

export async function forgetHandle(): Promise<void> {
  try {
    await req((await store(HANDLE_STORE, "readwrite")).delete(HANDLE_KEY));
  } catch {}
}
