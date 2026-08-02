// What the helper tells the page when it opens it (#124): the pure half.
//
// Getting to a first prompt used to cost nine gestures and only three were
// the product. Most of the rest were clerical — relaying facts between two
// surfaces that both already knew them. The helper knows the folder it is
// serving, which agents this machine can run, and that it is up; the page
// learned all of it only *after* a successful connection, so on first run it
// interviewed the human for things the other end could have told it.
//
// So the helper opens the page and puts what it knows in the URL.
//
// **The rule that keeps this honest: these are hints for display and
// verification, never data, and never load-bearing.** P2 says everything
// between the parties rides the folder, and it still does — the handle comes
// from the picker, the connection rides `.fsio`, the roster rides
// `services.json`, and the agent is named to the helper where an allow-list
// judges it again. Nothing here is read for any of that. A page opened by
// hand at the bare URL reaches exactly the same place, one step slower, and
// that is the test to run against anything added to this file: if the page
// would be *wrong* without a param rather than merely wordier, it has
// stopped being a hint.
//
// Two consequences worth stating, because both were live options:
//
//   - **No safety fact rides here.** Whether the agent is sandboxed is not a
//     hint and never will be: the page reads confinement out of the spawn
//     result, where the helper is answering for what it actually did. A URL
//     that claimed "sandboxed" would be a security sentence a stranger can
//     write.
//   - **The agent name is display only.** It says what the grant is about to
//     be for, at the moment of the grant. The instant the folder answers, the
//     roster replaces it — a shared or stale link naming an agent this helper
//     does not serve costs one wrong word before the connection and nothing
//     after it.
//
// The hash is the other half of this URL and belongs to `tabs.ts` (#120):
// `#s=…` carries conversations, which ARE load-bearing and are the human's
// own instruction rather than the helper's hint. Two writers, two halves,
// and the query survives a hash rewrite (`formatHash`'s fallback keeps
// `location.search`).

/** The advisory facts a helper-opened page arrives with. Null means the page
 *  was opened by hand, which is a supported way to arrive. */
export interface Launch {
  /** basename of the folder the helper is serving, so the page can name it
   *  on the pick button and, when a pick fails to find a helper, say which
   *  folder it should have been. */
  dir: string | null;
  /** the agent the helper would drive, when it serves exactly one. */
  agent: string | null;
}

export const NO_LAUNCH: Launch = { dir: null, agent: null };

/** Where the page lives when nobody says otherwise. `--url` overrides it for
 *  a local dev server. */
export const DEFAULT_PAGE = "https://agent-demo.pewter.town/";

/** A directory basename, as loosely as a filesystem allows and as tightly as
 *  a display string should be: no control characters, no separators, and
 *  short enough that a button stays a button.
 *
 *  Spelled out rather than written as one character class because the class
 *  would need a literal control-character range in the source, and a rule
 *  about control characters should not itself be invisible. */
const okDir = (v: string): boolean =>
  v.length > 0 && v.length <= 64 && !/[/\\]/.test(v) && ![...v].some((c) => (c.codePointAt(0) ?? 0) < 0x20);

/** Same shape the roster names are checked against on the wire. */
const okAgent = (v: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v);

/** A hint is a value that passed its shape check, or nothing at all. Both
 *  ends go through here: the helper does not send what the page would drop,
 *  and the page does not render what the helper could not have sent.
 *
 *  Anything malformed becomes null rather than an error — a mangled URL must
 *  leave someone on the ordinary arrival path, which is always correct, never
 *  on a panel about their own address bar (`tabs.ts` takes the same line). */
const hint = (ok: (v: string) => boolean, v: string | null | undefined): string | null =>
  typeof v === "string" && ok(v) ? v : null;

/** Read the hints off a `location.search`. Total: every failure is a null. */
export function parseLaunch(search: string): Launch {
  let p: URLSearchParams;
  try {
    p = new URLSearchParams(search.replace(/^\?/, ""));
  } catch {
    return NO_LAUNCH;
  }
  return { dir: hint(okDir, p.get("dir")), agent: hint(okAgent, p.get("agent")) };
}

/** The URL the helper prints and opens.
 *
 *  Built through `URL` so a `--url` pointing at a dev server keeps its port
 *  and path, and so a folder named `my project & co` survives the trip.
 *  Params that would not parse back are omitted rather than sent: the helper
 *  should not hand the page a hint the page is about to drop. */
export function launchUrl(base: string, l: Launch): string {
  const u = new URL(base);
  const dir = hint(okDir, l.dir);
  const agent = hint(okAgent, l.agent);
  if (dir) u.searchParams.set("dir", dir);
  if (agent) u.searchParams.set("agent", agent);
  return u.toString();
}
