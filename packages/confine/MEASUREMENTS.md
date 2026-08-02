# What the wall actually does

Measured, not asserted. These four sat in `spec/FINDINGS.md` as F23, F24,
F25 and F27 until [#132](https://github.com/dglazkov/fsio/issues/132) moved
them here: a finding is ground *the protocol* stands on, and the protocol
does not stand on Seatbelt. This library does. The numbers are spent and
are not reused; what a reader needs is the measurement, and it is here
beside the code it constrains.

Every one is reproducible with the labs in `scripts/`, on macOS/arm64.
Where a measurement has a method trap, the trap is written next to the
number — an instrument is worth exactly what its method is worth.

The requirement numbers these entries used to cite were never defined in a
file; they live in [#86](https://github.com/dglazkov/fsio/issues/86)'s body
and comments, and are named here by what they say rather than by number.

---

## The wall is transitive to any depth, cannot be re-entered in either direction, and setuid binaries do not execute

Measured 2026-07-31 (macOS 26.5/arm64;
`node scripts/confinement-lab.mjs --launchd`;
[#86](https://github.com/dglazkov/fsio/issues/86) open question 6 —
"transitive confinement, or a stated limit?"). Method: the shipped profile
and the shipped argv shape — the invocation sessions really use, D12's
no-drift discipline — a scratch ROOT, and a canary directory named in **no**
`-D` parameter. Every case asks one question: did a file appear at the
canary path? **8 escape attempts, 0 escapes.**

| attempt | result |
|---|---|
| direct child writes outside ROOT (baseline) | confined — EPERM |
| grandchild (`sh -c` inside `sh -c`) | confined |
| depth 4 through another interpreter (perl → sh → sh → touch) | confined |
| detached child, parent exits before the write | confined |
| re-enter `sandbox-exec` with `(allow default)` | `sandbox_apply: Operation not permitted` |
| re-enter `sandbox-exec`, same profile, `ROOT=/` | `sandbox_apply: Operation not permitted` |
| `launchctl submit` (launchd spawns for the child) | rc=1, no canary |
| `launchctl bootstrap` of a plist written *inside* ROOT | `Bootstrap failed: 5`, no canary |

- **Transitive by inheritance, at every depth and across detachment.** The
  policy rides the process, so `fork`/`exec` carries it and an orphan keeps
  it. An fsio peer spawning a coding agent as its subagent inherits
  confinement by construction — #86 asked for transitivity *or a written
  limit*, and the answer is that it is a property, not a gap to document.
- **One-shot: `sandbox_apply` fails in the *safe* direction too.** A
  confined process cannot re-enter `sandbox-exec` even to **narrow** itself
  (`(deny default)` → same EPERM). This is the load-bearing result: a
  profile must be composed into **one** policy and applied by the spawner,
  because no layering is available afterwards, and a nested fsio host
  cannot confine its own children below its own reach — it can only pass
  its confinement down.
- **launchd is not a spawn proxy out.** Both routes an unprivileged child
  has to ask launchd to spawn on its behalf failed under the profile,
  including the realistic one (write the plist into ROOT — which the child
  *may* write — then bootstrap it into `gui/$UID`).
- **setuid/setgid binaries are unexecutable under any Seatbelt profile.**
  `/bin/ps` (4755), `/usr/bin/top` (4555), `/usr/bin/crontab` (4755),
  `/usr/bin/sudo` (4511) all fail exec with EPERM; non-setuid tools
  (`id`, `whoami`, `ssh`, `lsof`) run. The control isolates it to Seatbelt
  rather than to fsio's posture: `/bin/ps` fails identically under
  `-p '(version 1)(allow default)'` and runs unsandboxed. A privilege-
  escalation route is closed for free, and the cost lands on ordinary
  usability — `ps` in a demo shell reports "Operation not permitted", and
  no environment fix reaches it (the fix-it-in-the-child's-environment
  lever does not apply here; only dropping the sandbox would).

The three properties this entry rests on are asserted on every push in
`src/test-posture.ts`, against real `sandbox-exec`.

---

## It is a *write* wall: the child inherits the host's entire environment, ssh-agent socket included, and reads every file the user can read

Measured 2026-07-31, same lab and run as the entry above
([#86](https://github.com/dglazkov/fsio/issues/86) open question 4 — "does
the read wall exist, and what does it cost?" — plus the env-policy baseline
#86 asked for as a falsifiable test: not "we intended to scrub", but the
bytes the child got). Canary secrets were exported into the parent and the
child's real `env` was diffed against them.

| what crosses | measured |
|---|---|
| environment variables | **47 of 48** reached the child |
| canary secrets (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, one control) | **4 of 4** reached the child |
| `SSH_AUTH_SOCK` | inherited; `ssh-add -l` inside the sandbox reaches the agent and gets a protocol answer |
| `HOME`, `SHELL`, `TMPDIR`, 21 `PATH` entries | inherited verbatim, including a PATH entry under `~` |
| `~/.ssh/id_ed25519` | readable (411 B) |
| `~/.gitconfig`, `~/.config/gh/hosts.yml`, `/etc/passwd`, every sibling project under `~/Documents` | readable |
| `~/Library/Messages` | denied — **by TCC, not by Seatbelt** |
| network egress (`curl https://example.com`) | HTTP 200, deliberate (the demos allow it: `git pull`, `npm install`) |

- **The honest consent sentence is about writes.** "Sandboxed to this
  folder" is true of modification and false of disclosure: a private key,
  every credential the environment carries, and every sibling repo are all
  in reach, and network egress is on, so read reach *is* exfiltration
  reach. #86's success criterion is "the sentence consent can honestly
  say" — this measurement is what makes that sentence checkable, and it is
  why `profileSummary()` names what the wall does not bound.
- **Env policy has no baseline to improve on — it is pass-everything.**
  Both halves of #86's placement-then-scrub program start from zero here;
  `SSH_AUTH_SOCK` is the sharpest single item, because agent forwarding is
  a *signing capability*, not a configuration value.
- **Part of the read wall is already held by someone else.** The
  TCC-protected set (Messages, Photos, Calendar, …) is denied to the child
  without fsio doing anything — the same "do not duplicate a wall another
  party enforces" shape #86 states for the browser's edit boundary, with
  the OS as the other party.
- **Unmeasured, deliberately:** what a read wall would *cost* in practice —
  that needs the act-2/act-4 field-test re-runs #86 lists, not this lab.
  Priced separately below.

---

## A stdio MCP server runs deny-default in 15 rules, 5 of which are the service's own reach

Measured 2026-07-31 (macOS 26.5/arm64, node v24.11.0;
`node scripts/service-reach-lab.mjs`;
[#90](https://github.com/dglazkov/fsio/issues/90) act-4 leg, testing
[#77](https://github.com/dglazkov/fsio/issues/77)'s claim that "an MCP
server is narrower than a shell"). Subject:
`@modelcontextprotocol/server-filesystem`, a real stdio MCP server,
deliberately credential-free. Method: build the deny-default profile the
way a profile author would have to — start from nothing, add only rules a
*measured* denial demands (denials read from the unified log; SBPL
`(trace)` no longer produces a file on current macOS). Three rounds of
`deny default` → run → read denials → add.

| | P1 — shell posture (`allow default` + write wall) | P2 — service posture (`deny default`) |
|---|---|---|
| MCP handshake, `tools/list` | ok, 14 tools | ok, **14 tools — identical** |
| read inside workspace | ok | ok |
| `~/.ssh` | reachable | **EPERM** |
| `~/.gitconfig`, `/etc/passwd` | reachable | **EPERM** |
| `~/Documents` (sibling projects) | reachable | **EPERM** |
| DNS / network | reachable | **denied** |
| profile size | 5 rules | 15 rules |

- **#77's claim is true, and the difference is categorical rather than one
  of degree.** The same server, doing the same work with the same 14
  tools, runs with `deny default` and no network at all. That is not
  available to a shell at any profile size — a shell is a universal
  executor, so its allow-list is decoration
  ([#86](https://github.com/dglazkov/fsio/issues/86)'s framing, now with a
  measurement behind it). What buys the tighter posture is that the unit of
  the mechanism is a *named service*
  ([D27](../../spec/DECISIONS.md)); nothing else in the design does.
- **The profile decomposes, and the per-service part is small.** Of 15
  rules, **9 are node-runtime infrastructure** (`/System/Library`,
  `/usr/lib`, `sysctl-read`, `/dev/urandom`, one `mach-lookup`, …) shared
  by every node-based service, and **5 are this service's reach** — its
  binary, its code, its workspace — of which 3 are parameters. So a
  profile mechanism wants a **runtime base layer plus a per-service
  delta**, composed into one policy before the spawn, and the thing a user
  or consent surface reads is the 5-rule delta, not the 15.
- **Two walls fired on the same read, and they are not redundant.** The
  server refused `~/.gitconfig` under *both* postures with its own
  allowed-directories check — an application-level error a driver can
  relay ("Access denied - path outside allowed directories"), which is
  exactly the refusal shape #86 asks to be legible to a non-human driver.
  Seatbelt refuses the same read with `EPERM`. Keep both: the server's wall
  is *legible but bypassable* (it is the server's own code), Seatbelt's is
  *enforcement but opaque*. "Do not duplicate a wall another party
  enforces" needs the refinement — do not duplicate another party's wall
  for **enforcement**, but a second wall that exists for **legibility** is
  not duplication.
- **Install-time reach is not run-time reach.** The subject was installed
  with npm before measurement; `npx`-style invocation would need network
  at every start, which is exactly the reach P2 denies. A service profile
  this tight implies the service is *installed*, not fetched per spawn —
  a constraint `fsio expose` (#77) inherits.
- **Unmeasured, and it is the important one:** a *credentialed* server
  (act 4's actual product — the `github` server holding a token). #86 says
  the mechanism must tolerate credentials as a deliberate act; this subject
  carries none, so the credential path is untested
  ([#90](https://github.com/dglazkov/fsio/issues/90)).

---

## A read wall costs 21 rules and holds the crown jewels — but the toolchain names its own price, and it is git's identity and npm's cache

Measured 2026-07-31 (macOS 26.5/arm64, node 24.11.0, git 2.50.1;
`node scripts/read-wall-lab.mjs`, ~2 min;
[#90](https://github.com/dglazkov/fsio/issues/90), the leg the two entries
above left open — [#86](https://github.com/dglazkov/fsio/issues/86) open
question 4). The write-wall entry priced what the shipped wall does *not*
hold; this prices what closing it costs. Every width is the shipped profile
plus a read wall of increasing width — the only variable that changes.
Rules were added only when a measured denial demanded one. Subject: a
workspace with a git repo, a dependency, a compiler and a test.

| | W0 shipped | W1 workspace only | W2 + toolchain | W3 + named user state |
|---|---|---|---|---|
| node runs | ok | **FAIL** | ok | ok |
| read the workspace | ok | **FAIL** | ok | ok |
| compile (tsc) | ok | **FAIL** | ok | ok |
| run tests | ok | **FAIL** | ok | ok |
| `git status` / `git commit` | ok | **FAIL** | **FAIL** | ok |
| `npm ci --offline` | ok | **FAIL** | **FAIL** | ok |
| `~/.ssh` (private keys) | reachable | — | **denied** | **denied** |
| `~/.config`, `~/Documents`, `/etc/passwd` | reachable | — | **denied** | **denied** |
| `~/.gitconfig` | reachable | — | denied | **reachable** |
| `~/.npmrc` + `~/.npm` | reachable | — | denied | **reachable** |
| profile size | 8 rules | 12 | 25 | **29** |

- **The read wall exists and is affordable.** 21 rules over the shipped 8
  buy a working toolchain with `~/.ssh`, `~/Documents`, `~/.config` and
  `/etc/passwd` all denied — the reach the write-wall entry found wide
  open. #86 worried that the shell case produced "a false trade between
  confinement and utility"; for a real build-and-test workload the trade is
  real and cheap. **The honest consent sentence gets stronger**: not just
  "writes are limited to this folder" but "reads are limited to this
  folder, your toolchain, and your git and npm settings."
- **What survives the wall is exactly the credential-bearing part.** The
  two carve-outs W3 must make are not incidental config. `~/.npmrc` is
  where a registry auth token lives; `~/.npm/_cacache` is a
  content-addressed store of package bodies already fetched, private
  registries included; `~/.gitconfig` routinely carries `[credential]`
  helpers and `url.*.insteadOf` rewrites. A read wall authored from the
  toolchain's denials converges on *keeping the secrets readable and
  denying the rest* — the opposite of the intuition, and it matters most
  where the brain is remote and anything readable is anything that leaves.
- **The wall's floor is far above the workspace.** W1 — workspace and
  scratch only, the width the phrase "sandboxed to this folder" implies —
  does not merely fail the toolchain: `/bin/sh` never starts. Denying
  `(literal "/")`, the root directory every absolute path walk reads,
  aborts the process with **SIGABRT before `main()` and no error text at
  all** (exit 134, empty stderr; the lab's own denial log named it — one
  line, `file-read-data /`). A too-narrow read wall does not look broken,
  it looks like nothing happened. "A broken confinement must look broken"
  applies to the read wall, and the failure is worse than the write wall's
  because there is no process left to report it.
- **The runtime lives under `$HOME`.** With a version manager, node is at
  `~/.nvm/versions/node/<v>/` — so "deny `$HOME`" and "run node" are not
  independent knobs. Same shape as the keystore collision the agent
  measurements found (narrow the profile, log the child out): the profile
  cannot be authored against a mental model in which `$HOME` is user data
  and `/usr` is the system.
- **Sizing, for the consent surface.** Of W3's 29 rules, 8 are the shipped
  write wall, 4 the workspace and scratch, 13 runtime-and-system
  infrastructure shared by any node service (the base layer again), and
  **4 are the user state this particular toolchain names**. The per-subject
  delta is the small part, and it is the part a consent surface has to
  show — #86's "describable to a third party in one line".

**Method trap, and it is the third of its class in this repo.** Kernel
Sandbox denials are stamped in the unified log when they **flush**, not
when they occur, and the lag runs to several seconds — while a whole width
here runs in ~2 s. Unbounded windows therefore reported one width's denials
under the next (`~/.gitconfig` shown as denied in W3, where git demonstrably
worked; `/dev/dtracehelper` carrying a running total of ×47 then ×97), and
tight windows dropped denials the child had just reported synchronously (W2
showing 1 denial in a cell where git had printed EPERM). The lab now spaces
widths by 10 s, holds each window open 8 s past its width, and prints every
window next to its results so the artifact can be audited instead of
trusted. Same class as F16's focus emulation and the agent lab's local-time
parsing: **an instrument that fails toward a plausible answer.** Denial
counts in the table above are corroborated by the child's own exit codes,
which is the signal that does not depend on the log at all.

---

## What is not here

Two measurements about **agent CLIs under this wall** — where a child's
state can be placed, where its identity actually lives, and how each one
fails — are the agent demo's ground rather than the library's, because this
package deliberately does not know what your child is. They live in
`packages/acp-demo/MEASUREMENTS.md`, and the read-wall entry above depends
on one of them.
