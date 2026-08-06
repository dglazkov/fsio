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
//   shell  nothing. A shell has no standing grant at all. It is unconfined —
//          "a terminal, unconfined, it can do anything you can" is the line in
//          its own question — so an "always" would mean "always, anything",
//          and there is nothing in the question to scope it with.
//
// **A grant is a comparison and never a source of a path.** Anything that can
// write the folder can write this file (spec/PROTOCOL.md, threat model), so
// the names in it are only ever compared against a plan the host already
// resolved off its own disk. A hand-edited `repo` that is not a project
// matches nothing rather than becoming a directory, which is the same rule the
// adapter roster follows (packages/pewt/src/agents.ts, #6).
/** What a grant is called. Short, stable and typable, because `pewt grants
 *  revoke` takes it and a human reads it off a list.
 *
 *  Derived from the grant rather than generated, so it is also the identity:
 *  the same answer given twice is one row, and a revoke names the thing it
 *  takes back rather than a number that means nothing next week. `.` is the
 *  pewter itself, which no project can be called — a project is one path
 *  segment and cannot start with a dot. */
export const grantId = (g) => [g.kind, ...(g.adapter ? [g.adapter] : []), g.repo ?? "."].join("/");
/** One line of English for what a grant covers. The id is precise and `.` is
 *  a directory spelling rather than a word, so this is what a list shows
 *  beside it and what the terminal says at the moment one is recorded. */
export function describeGrant(g) {
    const where = g.repo ?? "the pewter itself";
    return g.kind === "run" ? `any run in ${where}` : `${g.adapter ?? "any agent"} in ${where}`;
}
//# sourceMappingURL=grants.js.map