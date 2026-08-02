// What this page remembers between visits (#113), and nothing more.
//
// Three keys, three different reasons:
//
//   `root`    — the FileSystemDirectoryHandle. Chrome keeps it alive across
//               visits; what it does with the *grant* is a separate question
//               the page has to ask on every load (F15). Same mechanism, same
//               shape, and deliberately the same code path as
//               terminal-demo/web/connection.ts (#58), so the two demos stay
//               legible side by side.
//   `agent`   — the roster name the human chose (#102). Outlives any single
//               session: the whole point is not being asked again.
//   `session` — the sticky record (resume.ts). Dies with the session it
//               describes.
//
// What is NOT here: the transcript. The agent's half of it rode the folder
// and is read back from the folder (P2); only the human's half — which rode
// the uplink, and replay is downlink-only — is carried in the record.
import { parseRecord, type StickyRecord } from "../src/resume.js";

const IDB_NAME = "fsio-acp-demo";
const STORE = "keep";

function idbReq<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const open = indexedDB.open(IDB_NAME, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(STORE);
  const db = await idbReq(open);
  return db.transaction(STORE, mode).objectStore(STORE);
}

const get = async <T>(key: string): Promise<T | null> => ((await idbReq((await store("readonly")).get(key))) as T | undefined) ?? null;
const put = async (key: string, value: unknown): Promise<unknown> => idbReq((await store("readwrite")).put(value, key));
const del = async (key: string): Promise<unknown> => idbReq((await store("readwrite")).delete(key));

// ---------------------------------------------------------------- the folder

export const savedHandle = (): Promise<FileSystemDirectoryHandle | null> => get<FileSystemDirectoryHandle>("root");
export const saveHandle = (h: FileSystemDirectoryHandle): Promise<unknown> => put("root", h);
export const forgetHandle = (): Promise<unknown> => del("root");

// ---------------------------------------------------------------- the agent

export const savedAgent = (): Promise<string | null> => get<string>("agent");
export const rememberAgent = (name: string): Promise<unknown> => put("agent", name);
export const forgetAgent = (): Promise<unknown> => del("agent");

// ---------------------------------------------------------------- the session
//
// The record is held in memory and written through on every change. Every
// change is a human-scale event — a prompt sent, a card answered, a queue
// edited — so "write through" is a handful of writes per conversation, not a
// per-token cost. That matters more than it looks: the alternative (flush on
// `pagehide`) is a race against document teardown that IndexedDB loses.

let record: StickyRecord | null = null;

/** The record for the session this page is driving, or null. */
export const currentRecord = (): StickyRecord | null => record;

/** Start remembering a session. */
export function beginRecord(rec: StickyRecord): void {
  record = rec;
  void put("session", rec).catch(() => {});
}

/** Edit and persist. A no-op when there is no record — which is the normal
 *  state of a page whose IndexedDB is unavailable (private mode), and the
 *  reason none of the callers check. */
export function updateRecord(fn: (r: StickyRecord) => void): void {
  if (!record) return;
  fn(record);
  void put("session", record).catch(() => {});
}

/** Read the record left by a previous visit. */
export async function loadRecord(): Promise<StickyRecord | null> {
  try {
    return parseRecord(await get("session"));
  } catch {
    return null; // IndexedDB unavailable — the wizard path still works
  }
}

/** Forget the session. Called when the human ends it, and when a revisit
 *  finds it is already gone (a helper restart wipes `.fsio`, deliberately). */
export async function clearRecord(): Promise<void> {
  record = null;
  await del("session").catch(() => {});
}
