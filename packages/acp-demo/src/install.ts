// Installing an agent, once the human has said to (#124).
//
// The demo used to decline this rung entirely: print `npm i -g …` and let
// the human carry it to another terminal. That was one gesture too many at
// the exact moment someone has the least context — they have just been told
// the thing they came to see cannot run yet.
//
// What replaces it is a question, not an assumption. The helper has just
// scanned and found nothing; it says so, names what it would install, what
// that costs, and how to undo it; and it does nothing until a human types
// `y`. The enforcer is the person at the keyboard, who predates this
// software and gains nothing from it — which is what P5 asks for. It is the
// shape `sudo` has. What P5 forbids is software judging its own policy, and
// nothing here judges anything.
//
// Three properties this shape buys beyond the saved trip:
//
//   - **The install is an object, not an event.** `npm i -g` writes into the
//     machine's PATH, unnamed, permanently. `~/.fsio/agents/<name>/` is one
//     directory the helper can print, that is not on PATH, that comes back
//     off in one `rm -rf` the helper also prints. That is P3's shape — a
//     distinct rung with a distinct gesture — applied to a rung the demo
//     previously refused to touch.
//   - **No install scripts run.** Measured 2026-08-02 against
//     `@agentclientprotocol/claude-agent-acp@0.64.2`: `--ignore-scripts`
//     produces a byte-identical file tree to a plain install (111 packages,
//     293 MB, ~3 s either way; 260 MB of it is the bundled Claude Code CLI),
//     and the adapter answers `initialize` over ACP the same in both. There
//     is no native build step to lose — no libvips, no node-gyp — so the
//     flag is free, and the one child this demo runs unconfined does not
//     also execute vendor postinstall code as the user.
//   - **The version is the measured one.** `agents.ts` builds a sandbox
//     profile out of facts about one specific release (F30). Installing
//     whatever npm calls latest that day would make the profile a set of
//     claims about software nobody guaranteed the user has, and the drift
//     would surface as a sandbox bug rather than as version skew.
//
// The page never triggers any of this, and that is deliberate rather than
// incidental. Taking a spawn from the wire is safe because the allow-list
// bounds argv *and* the sandbox bounds the child; an install is neither.
// D12's page-asks-host-decides shape is the tempting move here and it is
// explicitly declined: this runs from a terminal, on an answer typed into
// that terminal, or it does not run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { execFile } from "node:child_process";
import type { AgentEntry } from "./agents.js";

/** Where a helper-installed agent goes: named, off PATH, one `rm -rf` from
 *  gone. Never `npm i -g` — the point is that this install has an address. */
export const agentsHome = (home: string = os.homedir()): string => path.join(home, ".fsio", "agents");

export const agentDir = (name: string, home?: string): string => path.join(agentsHome(home), name);

/** The binary an `~/.fsio/agents` install would put on disk, whether or not
 *  it is there. Entries whose `bin` is already a path (the puppet, and the
 *  fixtures the tests point at their own files) are never managed here. */
export function managedBin(entry: AgentEntry, home?: string): string | null {
  if (entry.bin.includes(path.sep)) return null;
  return path.join(agentDir(entry.name, home), "node_modules", ".bin", entry.bin);
}

export interface InstallResult {
  ok: boolean;
  dir: string;
  /** npm's own output when it failed — printed verbatim, never summarized:
   *  a registry outage, a proxy, and a disk-full all look the same once
   *  someone paraphrases them. */
  error?: string;
}

/** Run the install. Assumes the human already said yes. */
export async function installAgent(entry: AgentEntry, home?: string): Promise<InstallResult> {
  const dir = agentDir(entry.name, home);
  if (!entry.pkg) return { ok: false, dir, error: `${entry.name} is not an npm package this helper can install` };
  fs.mkdirSync(dir, { recursive: true });
  const spec = `${entry.pkg.name}@${entry.pkg.version}`;
  const args = ["install", "--prefix", dir, "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", spec];
  const out = await new Promise<{ err: Error | null; stderr: string; stdout: string }>((resolve) => {
    execFile("npm", args, { timeout: 600_000, maxBuffer: 8 << 20 }, (err, stdout, stderr) =>
      resolve({ err, stdout: String(stdout), stderr: String(stderr) })
    );
  });
  if (out.err) return { ok: false, dir, error: (out.stderr || out.stdout || out.err.message).trim() };
  const bin = managedBin(entry, home);
  if (!bin || !fs.existsSync(bin)) {
    return { ok: false, dir, error: `npm reported success but ${bin ?? "the binary"} is not there` };
  }
  return { ok: true, dir };
}

/** The question, and everything the human needs to answer it: what, where,
 *  how big, and how to undo it. Default is no — an empty line, a pipe, a
 *  Ctrl-D and a Ctrl-C all mean "carry on without it", because the helper
 *  runs perfectly well with an empty roster (#102) and the page will offer
 *  the manual line either way.
 *
 *  Only ever asked on a TTY. A helper started from a script, a launch agent,
 *  or a CI job has nobody to answer, and a prompt into a pipe is a hang. */
export async function confirm(question: string, input: NodeJS.ReadStream = process.stdin): Promise<boolean> {
  if (!input.isTTY) return false;
  const rl = readline.createInterface({ input, output: process.stdout });
  try {
    // Raced against `close` rather than awaited directly: `rl.question()`
    // never settles when the input stream ends, so a Ctrl-D at this prompt
    // would hang the helper before it ever served anything — measured, not
    // guessed. `close` fires on EOF and the empty answer falls through to
    // the default, which is no.
    const answer = await new Promise<string>((resolve) => {
      rl.once("close", () => resolve(""));
      void rl.question(question).then(resolve, () => resolve(""));
    });
    return /^y(es)?$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    rl.close();
    input.pause(); // the helper reads no further stdin; don't hold the loop open
  }
}
