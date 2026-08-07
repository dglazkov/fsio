// `.pewter/grants.json` — where an "allow always" goes, and how it comes back.
//
// The shape of a grant and what it covers are in the `pewter` package, because
// the page has to spell them too. What is here is the file: reading it,
// writing it, and matching a question against it.
//
// **Read at every question, never cached.** A standing grant is a handful of
// bytes and a spawn is a process, so there is nothing to save by holding it in
// memory — and holding it would mean `pewt grants revoke` took effect on the
// next host rather than on the next question, which is not what "take it back"
// means to whoever typed it.
//
// **One writer among the programs.** The host asks the question, so the host
// owns the answer: both `pewt grants` and `pewt grants revoke` are operations
// on this host (ops.ts) rather than the command line editing the file behind
// its back. The same rule the channel follows for a different reason (D6).
//
// A person editing it by hand is not covered by that rule, and the host now
// sends them here to do it: every message about a grant that prints on the
// host's terminal names this file instead of `pewt grants revoke` (ask.ts,
// serve.ts). `pewt` is on `PATH` for the scripts and agents that call back in
// (run.ts's `childEnv`, agent.ts's `agentEnv`), not at the terminal
// `pewt serve` prints to — so pointing a human at a command they cannot run
// was the alternative, and it was worse.
//
// Nothing enforces the rule and nothing has to. The list is re-read at every
// question, so a hand-edit lands on the next one; `writeGrants` renames over
// the file, so a reader never sees half of either version. What is unhandled
// is the lost update — a hand-edit and a recorded `a` in the same instant,
// where one silently wins. That is #164's "just a file in your pewter" and
// "ask the host" disagreeing about the same bytes, and it is now leaned on
// rather than merely noted.
//
// **A file this cannot read is a refusal, not an empty list.** Silently
// forgetting every answer would make the host ask about things it was told
// about, which is merely annoying; the same silence in the other direction is
// how you get a host that allows something nobody remembers allowing. So an
// unreadable file stops the question and names itself, and the fix — delete it
// and answer again — is in the message.
import fs from "node:fs";
import { grantId, type Grant, type GrantKey } from "pewter";
import type { Pewter } from "./pewter.js";

/** How the file is spelled in every message about it. Folder-relative,
 *  because that is where a human will go looking for it. */
export const GRANTS_FILE = ".pewter/grants.json";

const FIX = `delete ${GRANTS_FILE} and answer the questions again — the host asks about everything it does not remember`;

/** The grants file cannot be used, and this is the sentence saying why. */
export class GrantsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "GrantsError";
  }
}

/** What this pewter remembers. An empty list for a pewter where nobody has
 *  answered "always" yet, which is every new one. */
export function readGrants(p: Pewter): Grant[] {
  let raw: string;
  try {
    raw = fs.readFileSync(p.grants, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new GrantsError("unreadable", `cannot read ${GRANTS_FILE}: ${e instanceof Error ? e.message : String(e)}`, FIX);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GrantsError("unreadable", `${GRANTS_FILE} is not JSON`, FIX);
  }
  const list = (parsed as { grants?: unknown } | null)?.grants;
  if (!Array.isArray(list)) throw new GrantsError("unreadable", `${GRANTS_FILE} has no "grants" array in it`, FIX);
  return list.map(asGrant);
}

/** One row → a grant, or the refusal that stops the whole file. Strict on
 *  purpose: a row this does not understand is a row whose meaning nobody
 *  knows, and guessing at one is guessing at what somebody allowed. */
function asGrant(row: unknown): Grant {
  const bad = (why: string): never => {
    throw new GrantsError("unreadable", `${GRANTS_FILE} has a grant ${why}`, FIX);
  };
  if (!row || typeof row !== "object") return bad("that is not an object");
  const { kind, adapter, repo, granted } = row as Record<string, unknown>;
  if (kind !== "run" && kind !== "agent") return bad(`with kind ${JSON.stringify(kind)} — a grant is for a run or an agent`);
  if (kind === "agent" && typeof adapter !== "string") return bad("for an agent with no adapter named");
  if (kind === "run" && adapter !== undefined) return bad("for a run with an adapter on it");
  if (repo !== undefined && typeof repo !== "string") return bad("whose repo is not a name");
  if (typeof granted !== "string") return bad("with no date on it");
  return {
    kind,
    ...(typeof adapter === "string" ? { adapter } : {}),
    ...(typeof repo === "string" ? { repo } : {}),
    granted,
  };
}

/** Replace the file. Written beside and renamed over, so a host asking a
 *  question at the same moment reads the old list or the new one and never
 *  half of either. */
export function writeGrants(p: Pewter, grants: Grant[]): void {
  fs.mkdirSync(p.state, { recursive: true });
  const tmp = `${p.grants}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ grants }, null, 2)}\n`);
  fs.renameSync(tmp, p.grants);
}

/** The grant covering this question, or null. Identity is the id, which is
 *  everything about a grant except when it was answered. */
export function standingGrant(grants: Grant[], want: GrantKey): Grant | null {
  const id = grantId(want);
  return grants.find((g) => grantId(g) === id) ?? null;
}

/** Write down an answer. Answering "always" twice is one row rather than two,
 *  because the id is the answer and not the occasion. */
export function recordGrant(p: Pewter, want: GrantKey, now = new Date().toISOString()): { grant: Grant; already: boolean } {
  const grants = readGrants(p);
  const found = standingGrant(grants, want);
  if (found) return { grant: found, already: true };
  const grant: Grant = { ...want, granted: now };
  writeGrants(p, [...grants, grant]);
  return { grant, already: false };
}

/** Take one back. The next question of that shape is asked again. */
export function revokeGrant(p: Pewter, id: string): Grant {
  const grants = readGrants(p);
  const found = grants.find((g) => grantId(g) === id);
  if (!found) {
    throw new GrantsError("no_grant", `no standing grant called ${JSON.stringify(id)}`, "`pewt grants` lists them, and the id is the first column");
  }
  writeGrants(
    p,
    grants.filter((g) => g !== found)
  );
  return found;
}
