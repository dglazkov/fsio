# What two real agent CLIs do under the wall

Why `agents.ts` declares a **state posture per agent** instead of picking
one policy — measured, on two subjects, which disagreed.

These sat in `spec/FINDINGS.md` as F26 and F28 until
[#132](https://github.com/dglazkov/fsio/issues/132) moved them here. A
finding is ground *the protocol* stands on; the protocol does not stand on
where a coding agent keeps its credential. This demo does, and it is the
only thing in the repo that has to choose. The numbers are spent and are not
reused.

The requirement numbers these entries used to cite were never defined in a
file; they live in [#86](https://github.com/dglazkov/fsio/issues/86)'s body
and comments, and are named here by what they say. The wall itself is
measured in `packages/confine/MEASUREMENTS.md`.

This file is the demo's, and goes when the demo goes.

---

## Subject 1 — placement moves state but not identity: the credential is in the OS keystore, so a deny-default profile silently logs the agent out

Measured 2026-07-31 (macOS 26.5/arm64, claude CLI 2.1.220;
`node scripts/agent-reach-lab.mjs`;
[#90](https://github.com/dglazkov/fsio/issues/90) act-2 leg). The deliberate
re-run of the organic field test in
[#18](https://github.com/dglazkov/fsio/issues/18#issuecomment-5119402080),
whose accidental result produced "placement over denial". Subject: the
claude CLI, one headless turn per cell, in a scratch workspace with an
isolated config dir. Denials from the unified log; no credential contents
were read in either location.

| cell | posture | result | distinct denials |
|---|---|---|---|
| 0 | no sandbox, config dir in workspace | ok | 0 |
| A | shipped profile, config dir in workspace (#18's fix) | ok | 2 (both benign) |
| A′ | shipped profile, **default** `~/.claude` | **ok, exit 0** | 7 — incl. `~/.claude/projects/…`, `.claude.json.lock`, `.claude.json.tmp.*` |
| Ak | cell A + `(deny mach-lookup)` | **"Not logged in · Please run /login", exit 1** | 12 — incl. `com.apple.SecurityServer` ×3, `com.apple.securityd.xpc` |
| B | host-owned slot (`~/.fsio/state/<ws>/<svc>/`), carve exactly that wide | **"Not logged in", exit 1** — state tree written | 3 (all benign) |
| At | cell A + the agent spawns a child (`Bash(ls)`) | ok | 2 (both benign) |
| C | cell A + synthesized 8-variable environment | **ok — identical** | 2 (both benign) |

- **Placement works, for state.** Pointed at either the in-workspace dir or
  the host-owned slot, the child writes its whole tree there — config,
  backups, `projects/<ws>/` transcripts, `sessions/`, memory — with **zero
  state-related denials**. The slot carve is exactly wide enough, and needs
  nothing outside itself.
- **Placement does not carry identity, and #86's strongest claim about the
  slot is false.** That comment said transcript and token "get the same
  answer: the slot." They do not. The credential lives in the **login
  Keychain** (item `Claude Code-credentials`, created 2025-09-17 — i.e.
  long before this lab); a stale `.credentials.json` sitting in the placed
  config dir was *removed by the CLI during the run* and was never the
  source of auth. A fully-populated slot still reports "Not logged in"
  (cell B).
- **The keystore is reached by mach-lookup, so a deny-default profile logs
  the child out.** Cell Ak isolates it: denying mach-lookup produces
  `com.apple.SecurityServer` and `com.apple.securityd.xpc` denials and the
  identical "Not logged in" failure. This puts the tight **service posture**
  measured in `packages/confine/MEASUREMENTS.md` — the one that makes an
  MCP server safe in 15 rules — in direct tension with running an agent
  CLI: it would silently break a keystore-backed child. "Narrow the
  profile" and "let the child keep its credentials" are not independent
  knobs.
- **The refusal is legible but blames the wrong party.** "Please run
  /login" is exactly the relayable refusal shape #86 asks for — and it is
  *misleading*: the user who follows it will log in successfully and fail
  again next run, because the cause is the profile, not the session. A
  mechanism that only *applies* policy cannot say this; the host has to
  interpret denials to name the real cause.
- **#18's accident, reproduced exactly — and it is silent.** Cell A′ shows
  the original denial set, and the run still **exits 0 with a correct
  answer**. In headless mode nothing surfaces: the turn succeeds, the
  transcript is simply lost, so resume breaks later with no error at the
  time of the loss. "A broken confinement must look broken" applies to
  *state placement* too, and today it does not hold.
- **The environment is almost entirely unnecessary.** Cell C ran on 8
  synthesized variables (`PATH`, `HOME`, `TERM`, `LANG`, `USER`,
  `LOGNAME`, `SHELL`, `TMPDIR`) plus `CLAUDE_CONFIG_DIR` and behaved
  identically. None of the other ~39 inherited variables — including the
  canary secrets and `SSH_AUTH_SOCK` the write-wall measurement found
  crossing — are load-bearing for this child. Synthesize-then-add is
  affordable for this subject, which is the concrete answer #71's
  env-policy slice needed.
- **Transitivity holds on a real workload.** Cell At: the agent used its
  own Bash tool to spawn a child; it stayed confined and succeeded, and the
  CLI's permission layer did not contradict the wall. Every cell also shows
  `forbidden-exec-sugid` (×3–5) — the setuid denial the wall measurements
  describe, hit by a real agent, with no effect on the outcome.

**Method traps, each of which cost a round.** (1) The harness is itself a
Claude Code session exporting 8 `CLAUDE_*` markers; inherited, they steer
the subject — the first A′ run wrote nothing and reported zero denials. The
lab now scrubs `CLAUDE*`/`ANTHROPIC*` before every cell. (2) `log show
--start` parses **local** time; an ISO/UTC stamp puts the window hours in
the future and returns nothing, which reads exactly like "no denials" — the
first three cells all reported 0 for this reason. Same class as F16's
focus-emulation trap: an instrument that fails silently toward the
comfortable answer.

---

## Subject 2 — a second agent keeps its identity *in* its state dir, so placement and login are the same knob

Measured 2026-08-01 (macOS 26.5/arm64, node 24.11.0, pi-acp 0.0.32 /
`@earendil-works/pi-coding-agent` 0.82.1), spawning the agent exactly as
this demo does — `sandbox-exec` with the shipped agent profile, pipes,
synthesized environment — and driving two ACP requests per cell:
`initialize`, then `session/new`. No model turn was taken in any cell (no
quota spent, and none needed: the failure lands before inference).

| cell | posture | `initialize` | `session/new` |
|---|---|---|---|
| N | no sandbox, inherited environment | ok | ok |
| E | no sandbox, synthesized 8-variable environment | ok | ok |
| W | write wall (shipped profile), **no state carve** | **ok** | **fails** — JSON-RPC `-32603` |
| Wc | write wall + `~/.pi` carved writable | ok | ok |

- **The identity/state split has a second answer, and it is the opposite
  one.** Subject 1's credential is in the login Keychain, with its state
  freely placeable. This agent keeps `auth.json` in `~/.pi/agent`, in the
  same directory as `sessions/` and `models-store.json` — so its placement
  variable (`PI_CODING_AGENT_DIR`) moves the credential too, and pointing
  it at an empty slot is indistinguishable from logging out. Two subjects,
  two incompatible postures: **the mechanism cannot hold one state
  policy.** `src/agents.ts` therefore declares posture per agent
  (`place` | `carve`) as a fact about the child, and the host-owned slot
  becomes the answer for the agents that can use it rather than *the*
  answer.
- **The denial is loud, and wrong about its cause — the second instance.**
  Cell W answers `session/new` with `{code: -32603, message: "Internal
  error: Cannot call write after a stream was destroyed"}`. No `EPERM`, no
  path, no mention of a policy; the same stderr line, and nothing else. A
  page relaying that text tells the human about a stream. Compared with
  subject 1's cell A′ (exit 0, transcript silently lost) this is an
  improvement bought by *structure*: the write failed inside a request the
  human had made, so the protocol had somewhere to put the error — but the
  cause still has to be supplied by the host, which is the only party that
  knows what it denied.
- **The environment floor holds on a second subject.** Cell E: `PATH`,
  `HOME`, `TERM`, `LANG`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR` — the same
  eight measured on subject 1 — ran the agent identically to full
  inheritance. Synthesize-then-add is now two-for-two, and this package
  ships it as the default rather than inheriting `process.env`.
- **`initialize` proves nothing about a profile.** Every cell passes it,
  including the broken one: the handshake touches no state. A helper that
  preflights an agent by initializing it would report a green chain and
  hand the user a session that dies on its first real request.

**Reproduction.** The mechanism is the repo's: run
`node packages/acp-demo/dist/helper.js <folder>` and drive it with a client
(the B1 suite's rig, or the demo page). Cell W is the shipped code with the
`homeDirs` entry removed from `agents.ts`; cell E is the default, and cell N
requires passing `from` into `synthesizeEnv`.
