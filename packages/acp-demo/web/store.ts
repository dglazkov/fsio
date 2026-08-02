// What this page remembers between visits (#113, #123), and nothing more.
//
// Four keys, four different reasons:
//
//   `root`     — the FileSystemDirectoryHandle. Chrome keeps it alive across
//                visits; what it does with the *grant* is a separate question
//                the page has to ask on every load (F15). Same mechanism, same
//                shape, and deliberately the same code path as
//                terminal-demo/web/connection.ts (#58), so the two demos stay
//                legible side by side.
//   `agent`    — the roster name the human chose (#102). Outlives any single
//                session: the whole point is not being asked again.
//   `session`  — the sticky record (resume.ts). Dies with the session it
//                describes — but not, any more, all at once.
//   `past:<id>`— what is left of it once it has (#123): the human's turns and
//                the answers they clicked, keyed by session id, which is also
//                the transcript directory's name. `past-index` lists them,
//                newest first, and is what bounds them.
//
// What is NOT here: the transcript. The agent's half of it rode the folder
// and is read back from the folder (P2); only the human's half — which rode
// the uplink, and replay is downlink-only — is carried in the record, alive
// or demoted.
import { KEEP_PAST, demote, parsePast, parseRecord, prunablePast, type PastRecord, type StickyRecord } from "../src/resume.js";

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

/** The session is over — demote the record rather than deleting it (#123).
 *
 *  Called when the human ends the session, when the agent exits, and when a
 *  revisit finds the session already gone. All three are correct reasons to
 *  stop treating the record as *state*: it names a session that is not
 *  there, and a page that acted on it would attach to nothing. None of them
 *  is a reason to throw away the human's own words, which exist nowhere else
 *  — the folder has the agent's half and never had this one (D18, D32 rule
 *  2). So what is dropped is everything that pointed at the live session,
 *  and what is kept is the half that is now simply history.
 *
 *  Reads the record back from storage when the page is not holding one: the
 *  commonest path here is a revisit that loaded a record, found the session
 *  gone, and never began driving it. */
export async function clearRecord(): Promise<void> {
  const rec = record ?? (await loadRecord().catch(() => null));
  record = null;
  await del("session").catch(() => {});
  if (rec) await keepPast(rec).catch(() => {});
}

// ------------------------------------------------------------ what is left
//
// The bound is the folder's (D26 rule 4's newest-N), enforced twice for the
// two ways it can be exceeded: the count, here, on every demotion; and the
// folder's own verdict, in `prunePast`, whenever the page reads what the
// folder kept. The second is what makes this a satellite rather than a
// second archive — a transcript that has rotated out of `.fsio/` takes the
// browser's annotation of it with it.

const PAST_KEY = (id: string): string => `past:${id}`;
const PAST_INDEX = "past-index";

/** The demoted records this origin holds, newest first, each tagged with
 *  the folder its conversation happened in. The tag is what keeps one
 *  folder from answering for another (`prunablePast`); it is duplicated
 *  from the record itself so that pruning costs one read rather than N. */
type PastIndexEntry = { id: string; folder: string };

const pastIndex = async (): Promise<PastIndexEntry[]> => {
  const raw = (await get<unknown>(PAST_INDEX)) as unknown[] | null;
  if (!Array.isArray(raw)) return [];
  const out: PastIndexEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (typeof r["id"] === "string" && r["id"]) out.push({ id: r["id"], folder: typeof r["folder"] === "string" ? r["folder"] : "" });
  }
  return out;
};

async function keepPast(rec: StickyRecord): Promise<void> {
  const p = demote(rec);
  // Nothing typed and nothing clicked: there is no half to keep, and an
  // empty record would only make the reader's banner claim one exists.
  if (!p.prompts.length && !Object.keys(p.answers).length) return;
  const next = [{ id: p.sessionId, folder: p.folder }, ...(await pastIndex()).filter((e) => e.id !== p.sessionId)];
  await put(PAST_KEY(p.sessionId), p);
  await put(PAST_INDEX, next.slice(0, KEEP_PAST));
  for (const e of next.slice(KEEP_PAST)) await del(PAST_KEY(e.id)).catch(() => {});
}

/** The human's half of a conversation that ended, or null — which is the
 *  normal answer for a transcript this browser did not drive, and the one
 *  the read-only view has always had to render. */
export async function pastRecord(sessionId: string): Promise<PastRecord | null> {
  try {
    return parsePast(await get(PAST_KEY(sessionId)));
  } catch {
    return null; // IndexedDB unavailable — the agent's half still reads
  }
}

/** Drop the records the open folder has moved past. `kept` is the transcript
 *  ids that folder holds right now; the rule for reading that — why absence
 *  alone is not enough, and why only this folder gets a say — is
 *  `prunablePast`. */
export async function prunePast(folder: string, kept: readonly string[]): Promise<void> {
  try {
    const index = await pastIndex();
    const drop = new Set(prunablePast(index, kept, folder));
    if (!drop.size) return;
    await put(
      PAST_INDEX,
      index.filter((e) => !drop.has(e.id))
    );
    for (const id of drop) await del(PAST_KEY(id)).catch(() => {});
  } catch {
    // IndexedDB unavailable: nothing was written, so nothing needs pruning.
  }
}
