/** One remembered answer. */
export interface Grant {
    /** which question this answers. `shell` is deliberately not one of them. */
    kind: "run" | "agent";
    /** the adapter, on an agent grant. A run has none: a script is named by the
     *  project, not by a roster. */
    adapter?: string;
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
export declare const grantId: (g: GrantKey) => string;
/** One line of English for what a grant covers. The id is precise and `.` is
 *  a directory spelling rather than a word, so this is what a list shows
 *  beside it and what the terminal says at the moment one is recorded. */
export declare function describeGrant(g: GrantKey): string;
//# sourceMappingURL=grants.d.ts.map