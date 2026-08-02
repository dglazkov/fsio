// The sandbox-exec (Seatbelt/SBPL) profile for terminal-demo shells.
//
// The wall itself is @fsio/confine's: read the world, write only the shared
// folder minus `.fsio`, plus a scratch dir. What is here is the two holes a
// *shell* needs and an agent does not — which is the whole of what this demo
// adds to the library, and it is worth seeing at that size.
//
// This composition IS the security posture of the demo (#16 decision
// ledger): review it like protocol code. The helper writes the result to
// `<shared-dir>/.fsio/sandbox.sb` at startup, so a user can inspect exactly
// what their shell can do from inside the folder they granted.
import { sandboxProfile } from "@fsio/confine";

export const SHELL_PROFILE = sandboxProfile({
  subject: "terminal-demo shell sandbox (fsio #16).",
  posture: `Posture: read the world, write only the shared folder — minus
the protocol's own .fsio area — plus the scratch space a shell needs to
be usable. Network is deliberately allowed (working-folder use: git
pull, npm install). The threat model is "a remote page drives a local
shell".`,
  carves: [
    {
      why: `...and /tmp as well as TMPDIR: shells, git, editors and
installers assume a writable temp dir, and enough of them hardcode
/tmp rather than reading the variable that denying it makes the
shell feel broken in ways nobody would connect to a sandbox.`,
      dirs: ["/private/tmp"],
    },
    {
      why: `...and the device an interactive shell IS: its own pty. A
child on a pipe gets no such rule — this one is here because a human
is sitting at this one, watching its output.`,
      patterns: ["^/dev/tty"],
    },
  ],
});
