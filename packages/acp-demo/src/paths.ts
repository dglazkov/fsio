// Path containment for the page's `fs/*` handlers.
//
// It lives in `src/` (with the helper) rather than beside the page code
// because it is the one piece of browser-side logic with a security
// sentence attached — "the agent can only reach what the human granted" —
// and a claim like that should be tested in Node per push, not only in a
// cooperative browser loop. The page imports it directly (`../src/paths.js`).
//
// The rule: ACP sends absolute paths; the page holds a handle to exactly
// one directory. Anything that does not resolve inside that directory is
// refused *by name* rather than left to fail as a NotFoundError, so the
// agent gets a sentence it can relay to its user. `.fsio` is refused
// too: it is the host's (D6), and it is the channel this very conversation
// is riding on.

export type Contained = { ok: true; rel: string } | { ok: false; reason: string };

/** Resolve `.`/`..`/duplicate slashes without touching the filesystem. */
export function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

/** Absolute path → path relative to `cwd`, or a refusal with a reason. */
export function containedRelative(cwd: string, abs: string): Contained {
  if (!abs.startsWith("/")) return { ok: false, reason: `path must be absolute: ${abs}` };
  const root = normalize(cwd);
  const norm = normalize(abs);
  if (norm === root) return { ok: false, reason: "refused: that path is the folder itself, not a file" };
  if (!norm.startsWith(root === "/" ? "/" : root + "/")) {
    return { ok: false, reason: `refused: ${abs} is outside the folder this page was granted (${root})` };
  }
  const rel = norm.slice(root === "/" ? 1 : root.length + 1);
  if (rel === ".fsio" || rel.startsWith(".fsio/")) {
    return { ok: false, reason: "refused: .fsio is the transport's own directory, owned by the helper" };
  }
  return { ok: true, rel };
}
