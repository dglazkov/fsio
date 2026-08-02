# @fsio/confine

The write wall both demos wrote. macOS / Seatbelt only.

A child process gets to read the world and talk to the network, and gets to
**write** exactly one folder — the one the human handed the page — minus the
protocol's own `.fsio` area, plus whatever holes the caller declares and can
account for.

This is a library because it was written twice, not because anyone specified
it. `terminal-demo` and `acp-demo` arrived independently at the same
`sandboxArgv(cfg, file, args)`, the same four-field config, and the same
rule ordering; the duplication is the design document. See
[PROCESS.md](../../PROCESS.md) rule 6.

## What it does not do

**It does not spawn.** That is the one place the two implementations really
disagreed, and the disagreement is about policy, not mechanism:
`terminal-demo` wraps a `PtyModule` and must never throw (throwing would let
`HostServer` fall back to an unconfined pipe spawn), while `acp-demo` spawns
a plain child and must throw (a throw becomes a `1002` refusal in the page).
Both are fail-closed; they are fail-closed differently. So this package says
what the invocation is and whether it can run, and the caller decides what a
failure means.

**It does not know what your child is.** No agent concepts, no shell
concepts. Holes are `Carve`s with a required reason, and the reason is the
caller's.

## API

```ts
import { sandboxProfile, sandboxArgv, assertSandboxUsable, profileSummary } from "@fsio/confine";
```

### `sandboxProfile(inputs): string`

The SBPL text. The skeleton — `allow default` → `deny file-write*` → ROOT,
TMP, `/dev/null` → carves → the final `.fsio` deny — is fixed, because SBPL
is last-match-wins and the sequence *is* the policy. You supply prose and
holes, never order.

```ts
sandboxProfile({
  subject: "terminal-demo shell sandbox (fsio #16).",
  posture: "Read the world, write only the shared folder…",
  carves: [
    { why: "…shells and installers assume a writable /tmp.", dirs: ["/private/tmp"] },
    { why: "…the device an interactive shell is.", patterns: ["^/dev/tty"] },
  ],
});
```

`why` is required. The profile is written into `.fsio/` so a human can read
the policy from inside the folder it bounds — a rule they can see but cannot
account for is worse than no file. A carve with no `dirs` and no `patterns`
emits its comment alone, which is how you say "and nothing else, because…"
in the artifact instead of leaving a silence.

`dirs` are `(subpath …)`: a subtree, escaped. `patterns` are
`(regex #"…")`: a filename shape, and a pattern carrying a quote or
backslash is **refused, not escaped** — a mangled path narrows, a mangled
regex can widen.

### `sandboxArgv(cfg, file, args)`

Pure. Returns `{ file: "/usr/bin/sandbox-exec", args: [...] }` with `ROOT`,
`FSIO` and `TMP` bound from `cfg`. Exported rather than inlined so tests,
preflights and labs run the exact invocation sessions run.

All four `SandboxConfig` paths must be **realpaths**: Seatbelt matches
kernel-real paths, so an unresolved `/var/…` symlink matches nothing.

### `assertSandboxUsable(cfg)`

Profile readable, `sandbox-exec` executable. Throws. Without it a missing
file surfaces as an unexplained child exit.

### `profileSummary(folder, alsoWrites?)`

> writes: my-project/ (not .fsio), a scratch dir, and /Users/x/.claude —
> nothing else. reads: everything you can read. network: on.

The honest line. It names what the wall does *not* bound, because that is
the half a summary drops on its way to sounding reassuring — this is a write
wall (MEASUREMENTS.md), and "the agent is sandboxed" is the sentence the
threat model has a MUST against. `alsoWrites` is spelled out rather than summarised: a
hole outside the granted folder is exactly what a reader needs to see.

## Tests

- `test-profile.ts` — the emitted text, any platform.
- `test-posture.ts` — the wall itself, run through real `sandbox-exec`
  against a real filesystem. Skips off macOS. Includes the three properties
  D29 rests on: confinement is inherited by descendants and survives
  detachment, a confined child cannot re-enter `sandbox-exec` in either
  direction, and setuid binaries do not execute.

## What is measured

`MEASUREMENTS.md` — the wall's shape, priced. What crosses it, what a
deny-default posture costs, and what closing the read wall costs.
