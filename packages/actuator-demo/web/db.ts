// Where the application lives: IndexedDB, in the browser, owned by the page.
//
// This is the half of the demo the folder never sees. A command arrives,
// the page applies it here, and what travelled was the *asking* — the state
// itself has never been anywhere else (P1). The same store holds the
// directory handle, so a revisit skips the picker (F20).
import { apply, initialState, type AppState, type Operation } from "../src/model";
import { app } from "./state";

const DB_NAME = "fsio-actuator-demo";
const STATE_STORE = "app";
const HANDLE_STORE = "handles";
const STATE_KEY = "state";
const HANDLE_KEY = "root";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function open(): Promise<IDBDatabase> {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore(STATE_STORE);
    request.result.createObjectStore(HANDLE_STORE);
  };
  return req(request);
}

async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await open()).transaction(name, mode).objectStore(name);
}

/** Load the app into the `app` signal, seeding a first-run state. */
export async function loadApp(): Promise<AppState> {
  let state: AppState;
  try {
    state = (await req((await store(STATE_STORE, "readonly")).get(STATE_KEY))) ?? initialState();
  } catch {
    state = initialState(); // IndexedDB unavailable (private mode) — run in memory
  }
  app.set(state);
  return state;
}

/** Apply one operation and persist the result.
 *
 *  Read-modify-write across two transactions rather than one: the page is
 *  the only writer, and commands are applied one at a time as they arrive
 *  off a single session. What this does NOT survive is the page dying
 *  between applying and answering — the CLI times out, the change stands,
 *  and a retry duplicates it. Stated rather than solved: a dedup ledger is
 *  real machinery, and the pattern has not yet asked for one. */
export async function applyToApp(op: Operation): Promise<Record<string, unknown>> {
  const next = apply(app.get(), op);
  app.set(next.state);
  try {
    await req((await store(STATE_STORE, "readwrite")).put(next.state, STATE_KEY));
  } catch {
    // A page that cannot persist can still be driven; losing the write is
    // worth less than refusing the command in front of an audience.
  }
  return next.result;
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
