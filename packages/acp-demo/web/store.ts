// What this page remembers between visits (#113, #123, #120), and nothing
// more.
//
// Five kinds of key, five different reasons:
//
//   `root`        — the FileSystemDirectoryHandle. Chrome keeps it alive
//                   across visits; what it does with the *grant* is a
//                   separate question the page has to ask on every load
//                   (F15). Same mechanism, same shape, and deliberately the
//                   same code path as terminal-demo/web/connection.ts (#58),
//                   so the two demos stay legible side by side.
//   `agent`       — the roster name the human chose (#102). Outlives any
//                   single session: the whole point is not being asked again.
//   `session:<id>`— the sticky record (resume.ts), one per conversation.
//                   Dies with the session it describes — but not, any more,
//                   all at once.
//   `open`        — which conversations were open and which was on screen
//                   (#120). The URL carries the same set and outranks this
//                   one; this is what a bare visit comes back to.
//   `past:<id>`   — what is left of a record once its session has gone
//                   (#123): the human's turns and the answers they clicked,
//                   keyed by session id, which is also the transcript
//                   directory's name. `past-index` lists them, newest first,
//                   and is what bounds them.
//
// The session key went plural for #120 and the shape of a *record* did not
// change at all, which is the argument that it was the right migration to
// do late rather than first: `beginRecord`/`reattach` were always indifferent
// to what the record was filed under. What did change is the question this
// file could not answer before — "which conversations are open" — and that
// question only exists once a tab can be closed without ending anything.
//
// What is NOT here: the transcript. The agent's half of it rode the folder
// and is read back from the folder (P2); only the human's half — which rode
// the uplink, and replay is downlink-only — is carried in the record, alive
// or demoted.
import { KEEP_PAST, demote, mergeAnswers, parsePast, parseRecord, prunablePast, type PastRecord, type StickyRecord } from "../src/resume.js";
import { EMPTY, normalizeOpen, parseOpenSet, type OpenSet } from "../src/tabs.js";

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
const keys = async (): Promise<string[]> =>
  ((await idbReq((await store("readonly")).getAllKeys())) as IDBValidKey[]).filter((k): k is string => typeof k === "string");

// ---------------------------------------------------------------- the folder

export const savedHandle = (): Promise<FileSystemDirectoryHandle | null> => get<FileSystemDirectoryHandle>("root");
export const saveHandle = (h: FileSystemDirectoryHandle): Promise<unknown> => put("root", h);
export const forgetHandle = (): Promise<unknown> => del("root");

// ---------------------------------------------------------------- the agent

export const savedAgent = (): Promise<string | null> => get<string>("agent");
export const rememberAgent = (name: string): Promise<unknown> => put("agent", name);
export const forgetAgent = (): Promise<unknown> => del("agent");

// ---------------------------------------------------------------- sessions
//
// A record is written through on every change. Every change is a human-scale
// event — a prompt sent, a card answered, a queue edited — so "write
// through" is a handful of writes per conversation, not a per-token cost.
// That matters more than it looks: the alternative (flush on `pagehide`) is
// a race against document teardown that IndexedDB loses. With N
// conversations it matters more again, since `pagehide` would be racing N
// writes rather than one.
//
// The page holds the live objects (state.ts's `Conv.record`); this file owns
// the key they are filed under and never the identity of the conversation.

const KEY = (id: string): string => `session:${id}`;
const LEGACY_KEY = "session";

/** One in-flight write per session, chained. Two answers clicked a moment
 *  apart used to be two `put`s racing through two transactions, and this
 *  file opens a fresh one per call — so the order they committed in was the
 *  order two independent `indexedDB.open()` calls happened to settle. */
const writing = new Map<string, Promise<void>>();

/** Persist a record under its session's own key, MERGING what is already
 *  there rather than overwriting it.
 *
 *  A record is not this page's private state any more (#120). The URL
 *  carries a conversation, so two windows of one origin can hold the same
 *  one, each with its own copy in memory and both writing through to this
 *  key. Last-writer-wins loses whichever window's clicks came second — and
 *  what it loses is the human's answers to the agent's consent questions,
 *  which exist NOWHERE else: they rode the uplink, and the folder never saw
 *  them (D18, #113). Measured, not theorised: three permission cards
 *  answered `allow` on the wire came back as two open questions on the next
 *  load, because a second window wrote its pre-answer copy over them.
 *
 *  `answers` merges as a union, and that is sound rather than a guess: a
 *  question once answered is never un-answered, so the two copies can only
 *  differ by what each one has seen. Nothing else merges — every other field
 *  describes the session as the *writer* sees it, and only one page writes a
 *  session at a time (D18/F8). Which is also why the caller must not persist
 *  a fenced conversation at all; this is the second line of defence. */
export function saveRecord(rec: StickyRecord): void {
  const key = rec.sessionId;
  const next = (writing.get(key) ?? Promise.resolve()).then(() => mergePut(rec)).catch(() => {});
  writing.set(key, next);
}

async function mergePut(rec: StickyRecord): Promise<void> {
  const stored = await loadRecord(rec.sessionId).catch(() => null);
  // Into the live object, not a copy: this page's own replay guard reads the
  // same map to tell a card it already answered from one the agent is still
  // waiting on, and it should learn what the other window knows too.
  if (stored) mergeAnswers(rec.answers, stored.answers);
  await put(KEY(rec.sessionId), rec);
}

/** Read one back. */
export async function loadRecord(sessionId: string): Promise<StickyRecord | null> {
  try {
    return parseRecord(await get(KEY(sessionId)));
  } catch {
    return null; // IndexedDB unavailable — the wizard path still works
  }
}

/** The session is over — demote its record rather than deleting it (#123).
 *
 *  Called when the human ends a conversation, when an agent exits, and when
 *  a restore finds the session already gone. All three are correct reasons
 *  to stop treating the record as *state*: it names a session that is not
 *  there, and a page that acted on it would attach to nothing. None of them
 *  is a reason to throw away the human's own words, which exist nowhere else
 *  — the folder has the agent's half and never had this one (D18, #113).
 *  So what is dropped is everything that pointed at the live session,
 *  and what is kept is the half that is now simply history.
 *
 *  `held` is the live record when the page is driving that conversation;
 *  without one it is read back from storage, which is the path a restore
 *  takes when it finds the session gone before it ever began driving it. */
export async function clearRecord(sessionId: string, held: StickyRecord | null = null): Promise<void> {
  const rec = held ?? (await loadRecord(sessionId).catch(() => null));
  await del(KEY(sessionId)).catch(() => {});
  if (rec) await keepPast(rec).catch(() => {});
}

/** Every record this origin holds. Used for two things and nothing else:
 *  the one-time migration below, and sweeping records whose sessions died
 *  while no page was watching. */
async function allRecords(): Promise<StickyRecord[]> {
  const out: StickyRecord[] = [];
  for (const k of await keys()) {
    if (!k.startsWith("session:")) continue;
    const rec = parseRecord(await get(k).catch(() => null));
    if (rec) out.push(rec);
  }
  return out;
}

/** Demote the records of conversations in this folder that are no longer
 *  running (#120).
 *
 *  With one record per page there was nothing to sweep — the next session
 *  overwrote it. With one per conversation, a session that ended while no
 *  page was open leaves a record naming something that is not there, forever,
 *  and the "+" menu would go on offering conversations the folder has
 *  forgotten. `live` is what `listSessions()` just answered, and this is only
 *  ever called when that call SUCCEEDED: a torn listing reads as "nothing is
 *  running", and acting on it would demote every live conversation on the
 *  page. A folder speaks only for its own records, for the same reason
 *  `prunablePast` says so — one origin can hold conversations from several. */
export async function sweepRecords(folder: string, live: ReadonlySet<string>): Promise<string[]> {
  const swept: string[] = [];
  try {
    for (const rec of await allRecords()) {
      if (rec.folder !== folder || live.has(rec.sessionId)) continue;
      await clearRecord(rec.sessionId, rec);
      swept.push(rec.sessionId);
    }
  } catch {
    // IndexedDB unavailable: nothing was written, so nothing needs sweeping.
  }
  return swept;
}

// ------------------------------------------------------------ the open set
//
// Which conversations this page had open, and which was on screen. The URL
// carries the same thing and outranks it (src/tabs.ts) — this is the memory
// a bare visit to /acp comes back to, which is the promise #113 made before
// there was a hash to make it with.

const OPEN_KEY = "open";

export function saveOpen(open: OpenSet): void {
  void put(OPEN_KEY, { ids: [...open.ids], active: open.active }).catch(() => {});
}

/** The stored set, after folding in the one record a pre-#120 page could
 *  have left behind.
 *
 *  The migration is a read, not a rewrite: an older `session` record is
 *  re-filed under its own key and the singular key dropped, so a page that
 *  had one conversation open comes back to exactly that conversation. Doing
 *  it here rather than at first write means it happens once, on the load
 *  that needs it, and a browser that never comes back is never touched. */
export async function loadOpen(): Promise<OpenSet> {
  try {
    const legacy = parseRecord(await get(LEGACY_KEY));
    if (legacy) {
      await put(KEY(legacy.sessionId), legacy);
      await del(LEGACY_KEY).catch(() => {});
      const stored = parseOpenSet(await get(OPEN_KEY));
      // Ahead of whatever else is stored: it is the conversation this browser
      // was in the last time it was here.
      return normalizeOpen([legacy.sessionId, ...stored.ids], legacy.sessionId);
    }
    return parseOpenSet(await get(OPEN_KEY));
  } catch {
    return EMPTY; // IndexedDB unavailable — the wizard path still works
  }
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
