// Which conversations a page is holding, and which one is on screen (#120):
// the pure half.
//
// /acp drove exactly one conversation. It now drives N, and the set of them
// is written down twice, for two different jobs:
//
//   the URL     — `#s=<id>,<id>&a=<id>`, replaceState'd on every change.
//                 This is the P1 statement the demo did not have: the URL
//                 travels and the data stays, so handing someone the link
//                 hands them these conversations. They bring their own
//                 folder grant; the agents are already running on the
//                 machine the folder is on. The terminal demo has carried
//                 shells this way since #34 — same hash shape on purpose,
//                 so the two demos stay legible side by side.
//
//   IndexedDB   — the same set, as this browser's own last state. The URL
//                 is what you *hand* someone; the store is what a bare
//                 visit to /acp comes back to, which is the promise #113
//                 made and the hash alone would quietly drop the first time
//                 someone opened a bookmark.
//
// The URL wins when it has anything in it. A pasted link is an explicit
// instruction about which conversations to be in, and a stored set is only
// ever a memory of the last one.
//
// Ids are `s-<ts36>-<rand>` (client/index.ts mints them), so the hash is
// hand-built rather than URLSearchParams-encoded — `%2C` soup for a
// separator that can never appear in the thing being separated.

/** The conversations this page holds, in tab order, and which is on screen.
 *  `active` is always one of `ids`, or null when there are none. */
export interface OpenSet {
  ids: string[];
  active: string | null;
}

export const EMPTY: OpenSet = { ids: [], active: null };

/** What may appear in the hash. Deliberately narrower than "a session id":
 *  everything here ends up in `attachSession()` and in a directory lookup,
 *  and the URL is the one input to this page a stranger writes. The host
 *  judges the id again — this is just the cheap refusal that keeps a
 *  path-shaped string from ever reaching it. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Dedupe, drop anything that isn't id-shaped, and put `active` back inside
 *  the set it names. Every constructor of an OpenSet goes through here — the
 *  three sources (the URL, IndexedDB, the page's own tab list) have three
 *  different ways of being wrong and one right answer. */
export function normalizeOpen(ids: readonly unknown[], active: unknown): OpenSet {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  const a = typeof active === "string" && seen.has(active) ? active : (out[0] ?? null);
  return { ids: out, active: a };
}

/** Read `location.hash`. Anything unparseable is an empty set rather than an
 *  error: a mangled URL should land someone on the ordinary arrival path,
 *  which is always correct, never on a panel about their address bar. */
export function parseHash(hash: string): OpenSet {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  return normalizeOpen((p.get("s") ?? "").split(","), p.get("a"));
}

/** The hash for a set, `#`-prefixed, or "" when there is nothing to carry —
 *  which the caller turns into a bare path, so an emptied page does not
 *  leave a `#` behind. */
export function formatHash(open: OpenSet): string {
  const { ids, active } = normalizeOpen(open.ids, open.active);
  if (!ids.length) return "";
  return `#s=${ids.join(",")}${active ? `&a=${active}` : ""}`;
}

/** The same read for a set that has been sitting in IndexedDB across a
 *  browser upgrade, a schema change of ours, or a half-written write. */
export function parseOpenSet(raw: unknown): OpenSet {
  if (!raw || typeof raw !== "object") return EMPTY;
  const r = raw as Record<string, unknown>;
  return normalizeOpen(Array.isArray(r["ids"]) ? r["ids"] : [], r["active"]);
}

/** Which set a load should act on. The URL is an instruction and the store
 *  is a memory, so a URL that names anything wins outright — including the
 *  case where it names *fewer* conversations than the store remembers, which
 *  is what someone sharing one of their three tabs means to say. */
export function wantedOpen(fromUrl: OpenSet, fromStore: OpenSet): OpenSet {
  return fromUrl.ids.length ? fromUrl : fromStore;
}
