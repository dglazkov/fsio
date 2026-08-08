// A standing grant — the host's memory of one answer.
//
// The host asks before it starts a process (NARRATIVE.md, "What pewt serve
// does"), and "allow always" is the answer it writes down. This file is what
// it wrote and how that reads, in the one package the host and the page both
// import — so `pewt grants` in a terminal and `pewt.grants.list()` in an
// extension say the same words about the same row.
//
// **What a grant matches is the whole design**, and it is narrow on purpose
// (P3 — fight prompt fatigue with scope and durability, never breadth):
//
//   run    the project. "Any run in fsio" — you trust a project, not one
//          script, because a script is a line in that project's package.json
//          and the next one is a line away.
//   agent  the adapter *and* the project. "pi-acp in fsio", never "any agent
//          in fsio": what you read before answering was whether that adapter
//          asks before it edits, and a grant covering an adapter you never
//          read that line about answers a question nobody asked.
//   exec   the program *and* the project. "git in fsio". This is the one an
//          argv buys: a command has a name, so what you allowed can be
//          written down and read back.
//   shell  the project. "A shell in fsio" — and the sentence says out loud
//          that a shell is unconfined, so this is broad by nature.
//
// **`shell` used to have no grant, and that was reversed on purpose**
// (2026-08-07, with the owner). The argument against it was sound and is
// worth keeping: a shell is unconfined, so "always" really does mean
// "always, anything", and there is nothing in the question to scope it with.
// What changed is not the argument but its timing — nothing here has users
// yet, the first screen to need facts about a project was asking a human at a
// terminal on every single reading, and the owner's call was that locking the
// model down before anybody has lived in it is the wrong order. Make it
// possible, watch how it gets used, tighten it then. The honesty stays in the
// wording: what a shell grant covers is described as what it is rather than
// as something narrower.
//
// **A grant is a comparison and never a source of a path.** Anything that can
// write the folder can write this file (spec/PROTOCOL.md, threat model), so
// the names in it are only ever compared against a plan the host already
// resolved off its own disk. A hand-edited `repo` that is not a project
// matches nothing rather than becoming a directory, which is the same rule the
// adapter roster follows (packages/pewt/src/agents.ts, #6).

/** One remembered answer. */
export interface Grant {
  /** which question this answers. */
  kind: "run" | "agent" | "exec" | "shell";
  /** the adapter, on an agent grant. A run has none: a script is named by the
   *  project, not by a roster. */
  adapter?: string;
  /** the program, on an exec grant — `git`. The whole reason an exec can be
   *  remembered when a shell can only be remembered broadly: an argv names
   *  what runs, and a name is something a person can be shown. */
  cmd?: string;
  /** the project under `repos/`, or absent for the pewter itself. */
  repo?: string;
  /** when it was answered, ISO 8601. */
  granted: string;
}

/** A grant minus when it was answered: what a question asks for, and the
 *  whole of what matching compares. */
export type GrantKey = Omit<Grant, "granted">;

/** What a grant is called. Short, stable and typable, because `pewt grants
 *  revoke` takes it and a human reads it off a list.
 *
 *  Derived from the grant rather than generated, so it is also the identity:
 *  the same answer given twice is one row, and a revoke names the thing it
 *  takes back rather than a number that means nothing next week. `.` is the
 *  pewter itself, which no project can be called — a project is one path
 *  segment and cannot start with a dot. */
export const grantId = (g: GrantKey): string => [g.kind, ...(g.adapter ? [g.adapter] : []), ...(g.cmd ? [g.cmd] : []), g.repo ?? "."].join("/");

/** One line of English for what a grant covers. The id is precise and `.` is
 *  a directory spelling rather than a word, so this is what a list shows
 *  beside it and what the terminal says at the moment one is recorded. */
export function describeGrant(g: GrantKey): string {
  const where = g.repo ?? "the pewter itself";
  // "npm install included" since #193: an install question records this same
  // grant, so the sentence a human reads must say what it covers.
  if (g.kind === "run") return `any run in ${where}, npm install included`;
  if (g.kind === "agent") return `${g.adapter ?? "any agent"} in ${where}`;
  // Named, which is the point of it: what was allowed is one program.
  if (g.kind === "exec") return `${g.cmd ?? "any program"} in ${where}`;
  // Said plainly rather than scoped down to sound safer than it is: a shell
  // is unconfined, and a grant on one is broad however it is worded.
  return `a shell in ${where} — unconfined, so this covers anything you can do`;
}
