// The Seatbelt (SBPL) profile both demos wrote: a write wall around the
// folder the human granted, with named holes in it.
//
// The skeleton below is not a default anyone may reorder. SBPL is
// last-match-wins, so the sequence is the policy: broad allow, the write
// clampdown, the re-allows, then a final `.fsio` deny that must override the
// ROOT allow. A caller supplies prose and holes; it does not supply order,
// and it cannot open ROOT's protocol area no matter what it passes.
//
// What a caller supplies is `Carve`s — a hole plus the reason for it, in the
// caller's own words. The reason is required, and that is the one opinion
// this module holds. The profile is written into `.fsio/` precisely so a
// human can read the policy from inside the folder it bounds; a rule they
// can see but cannot account for is a worse artifact than no file at all.
// Both demos hand-wrote a `;;` comment above every allow before there was
// anything making them.
//
// Parameters, bound by `sandboxArgv` and all realpath'd:
//   ROOT — the shared directory (the folder the browser picked)
//   FSIO — ROOT/.fsio (the protocol area; host-owned, D6)
//   TMP  — the scratch dir the child gets as TMPDIR
//
// Scope: macOS. `sandbox-exec` is deprecated-but-shipping and this is the
// only confinement fsio has measured. A second substrate is a second
// backend, not a second copy of this file.

/** SBPL string-literal escaping for embedded paths. Paths that vary per run
 *  cannot be `-D` parameters (their count varies), so they are written into
 *  the profile text — which is strictly more inspectable anyway: the file in
 *  `.fsio/` is then the whole policy, with nothing hiding in the argv. */
const sbplString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** A regex literal. Unlike a path, a pattern that lost a character to
 *  escaping would silently widen the wall, so a pattern carrying a quote or
 *  backslash is refused outright rather than mangled into something that
 *  compiles and means something else. Patterns are static, in-repo values,
 *  so this can only ever fire on a developer's own typo. */
const sbplRegex = (s: string): string => {
  if (/["\\]/.test(s)) throw new Error(`confine: refusing a pattern containing a quote or backslash: ${s}`);
  return `#"${s}"`;
};

/** Prose → SBPL comment lines. */
const comment = (text: string): string =>
  text
    .trim()
    .split("\n")
    .map((l) => (l.trim() ? `;; ${l.trim()}` : ";;"))
    .join("\n");

/** One hole in the wall, and the reason it is there.
 *
 *  A carve with neither `dirs` nor `patterns` emits its comment and no rule
 *  — which is how you say "and nothing else, because …" in the file itself
 *  rather than by leaving a gap a reader has to interpret. */
export interface Carve {
  /** why this hole exists, in the caller's words. Becomes the comment
   *  directly above the rules, in the file the human reads. Required. */
  why: string;
  /** absolute, realpath'd dirs, emitted as `(subpath …)` — a subtree. */
  dirs?: readonly string[];
  /** SBPL regexes, emitted as `(regex #"…")` — a filename shape, not a
   *  subtree. Anchor them (`^…$`) unless you mean a prefix. */
  patterns?: readonly string[];
}

export interface ProfileInputs {
  /** one line naming what this profile confines, for the header. */
  subject: string;
  /** the posture paragraph: what this caller is holding, and why. Goes
   *  under the subject, where a human reads it before any rule. */
  posture: string;
  /** the holes, in the order they should be read. */
  carves?: readonly Carve[];
}

export function sandboxProfile(inputs: ProfileInputs): string {
  const carves = (inputs.carves ?? [])
    .map((c) =>
      [
        comment(c.why),
        ...(c.dirs ?? []).map((d) => `(allow file-write* (subpath ${sbplString(d)}))`),
        ...(c.patterns ?? []).map((p) => `(allow file-write* (regex ${sbplRegex(p)}))`),
      ].join("\n")
    )
    .join("\n\n");

  return `(version 1)

${comment(inputs.subject)}
;;
${comment(inputs.posture)}

;; Everything that is not a file write: allowed (process-exec, network,
;; file-read*, signals, ...). The wall held here is what the child may
;; MODIFY — not what it can see, and not who it can talk to.
(allow default)

;; The wall: no file writes anywhere...
(deny file-write*)

;; ...except the shared folder — the one the human granted the page, now
;; granted to the child the page drives. That symmetry is the point.
(allow file-write* (subpath (param "ROOT")))

;; ...the scratch dir the child is handed as TMPDIR,
(allow file-write* (subpath (param "TMP")))

;; ...and the bit bucket.
(allow file-write* (literal "/dev/null"))
${carves ? "\n" + carves + "\n" : ""}
;; Final word (last match wins): the protocol area inside ROOT stays
;; host-owned even though ROOT is writable. A child that could edit .fsio
;; could corrupt or spoof its own transport (D6) — including the frames
;; carrying the permission prompts the human is answering.
(deny file-write* (subpath (param "FSIO")))
`;
}

/** The one honest line, for a banner or a session header.
 *
 *  It says what the wall does NOT bound, because that is the half a summary
 *  drops on its way to sounding reassuring. "The child is sandboxed" is the
 *  dishonest version: this is a *write* wall (F24). Reads are unbounded and
 *  the network is open, and a human deciding whether to hand over their
 *  folder needs both facts in the same sentence as the good news.
 *
 *  `alsoWrites` is spelled out rather than summarised: a hole outside the
 *  granted folder is exactly the thing a reader needs to see, and "plus some
 *  scratch space" is how it stops being visible. */
export function profileSummary(folder: string, alsoWrites: readonly string[] = []): string {
  const also = alsoWrites.length ? `, and ${alsoWrites.join(", ")}` : "";
  return `writes: ${folder}/ (not .fsio), a scratch dir${also} — nothing else. reads: everything you can read. network: on.`;
}
