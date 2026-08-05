// The question the host asks before it starts a process.
//
// It is asked in the terminal running `pewt serve`, never in the page. The
// page is the thing asking for permission, so the page cannot be the thing
// granting it (NARRATIVE.md) — which is P5: the enforcer is the person at the
// keyboard, who predates this software and gains nothing from it. The same
// shape `sudo` has, and the same shape `acp-demo/src/install.ts` uses for the
// one other question this repository asks.
//
// What is here is allow-once or deny, asked every time. Remembering an answer
// — `.pewter/grants.json`, "allow always", `pewt grants revoke` — is the
// grants slice, and it is deliberately not started here: `shell` and `agent`
// have not yet said what they need a grant record to hold.
//
// Nothing in this file decides anything. A host with no terminal to ask in
// denies, and says which flag turns that into a yes.
import readline from "node:readline/promises";
import type { HostLogger, SpawnPolicy } from "@fsio/host";
import type { Pewter } from "./pewter.js";
import { asRunSpec, planRun, RunError, type RunPlan } from "./run.js";

export interface Asker {
  /** null when this host cannot ask — no terminal, or a caller that answers
   *  for itself. */
  ask: ((question: string) => Promise<string>) | null;
}

/** The default: ask on this process's own terminal, one question at a time. */
export function terminalAsker(): Asker {
  // A host started by a rig, by CI, or as a background task has no terminal,
  // and a question nobody can see is a hang rather than a prompt. This is the
  // check that turns it into a refusal with an instruction (memory of a
  // guarded `[y/N]` skipping silently under a non-TTY stdin).
  if (!process.stdin.isTTY) return { ask: null };
  let queue: Promise<unknown> = Promise.resolve();
  return {
    ask: (question) => {
      // Serialized: two pages asking at once would otherwise type over each
      // other's prompt, and the human could not tell which answer went where.
      const next = queue.then(async () => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question(question);
        } finally {
          rl.close();
        }
      });
      queue = next.catch(() => {});
      return next;
    },
  };
}

const stamp = (): string => new Date().toTimeString().slice(0, 8);

export interface GateOptions {
  /** allow every run without asking. */
  allowRuns?: boolean;
  /** where the question goes. */
  asker: Asker;
}

/** The host's spawn policy (D12): consulted for every session, and the only
 *  thing standing between a page and a process on this machine.
 *
 *  A `pewt` session is the API — it reads the folder and bundles extensions,
 *  and starts nothing — so it is allowed and narrated. A `run` is resolved
 *  first (a human should never be asked about a script that does not exist)
 *  and then asked about. */
export function spawnGate(p: Pewter, opts: GateOptions, log: HostLogger): SpawnPolicy {
  return async (spec, info) => {
    if (info.kind !== "run") {
      log.info(`● ${info.kind} session — origin: ${info.origin ?? "(none reported)"}`);
      return true;
    }
    let plan: RunPlan;
    try {
      const asked = asRunSpec(spec);
      if (!asked) throw new RunError("bad_params", "a run needs a script name");
      plan = planRun(p, asked);
    } catch (e) {
      const message = e instanceof RunError ? [e.message, e.hint].filter(Boolean).join(" — ") : e instanceof Error ? e.message : String(e);
      log.warn(`✗ ${message}`);
      return { allow: false, reason: message };
    }
    if (opts.allowRuns) {
      log.info(`▸ ${plan.label} — allowed by --allow-runs (${info.origin ? `from the page (${info.origin})` : "from a terminal"})`);
      return true;
    }
    return askToRun(opts.asker, plan, info.origin, log);
  };
}

/** Ask about one run. `origin` is where it came from, in the words the
 *  narrative uses: a page reports one, a terminal does not. */
export async function askToRun(asker: Asker, plan: RunPlan, origin: string | undefined, log: HostLogger): Promise<{ allow: boolean; reason?: string }> {
  const from = origin ? `from the page (${origin})` : "from a terminal";
  const t = stamp();
  if (!asker.ask) {
    log.warn(`${t}  ▸ ${plan.label}  ${from}\n${t}    ✗ denied — this host has no terminal to ask in`);
    return {
      allow: false,
      reason: "the host has no terminal to ask on, so it cannot allow a process; start it with `pewt serve --allow-runs` to answer yes to every run",
    };
  }

  // The command and the working directory are the whole question. A human
  // deciding whether to allow a build needs to see what the project declared,
  // not the name somebody typed for it.
  const answer = (
    await asker.ask(
      `\n${t}  ▸ ${plan.label}${" ".repeat(Math.max(1, 40 - plan.label.length))}${from}\n` +
        `${t}    ?   npm run ${plan.script}\n` +
        `${t}        ${plan.declared}\n` +
        `${t}        cwd ${plan.where}/\n` +
        `${t}      allow once / deny  [y/N] `
    )
  )
    .trim()
    .toLowerCase();

  const allow = answer === "y" || answer === "yes";
  log.info(`${stamp()}    ${allow ? "✓ allowed once" : "✗ denied"} — ${plan.label}`);
  return allow ? { allow: true } : { allow: false, reason: "denied at the host's terminal" };
}
