// The question the host asks before it starts a process.
//
// It is asked in the terminal running `pewt serve`, never in the page. The
// page is the thing asking for permission, so the page cannot be the thing
// granting it (NARRATIVE.md) — which is P5: the enforcer is the person at the
// keyboard, who predates this software and gains nothing from it. The same
// shape `sudo` has, and the same shape `acp-demo/src/install.ts` uses for the
// one other question this repository asks.
//
// There are three answers, and the third is remembered: allow once, allow
// always, or deny. "Always" writes a standing grant to `.pewter/grants.json`
// and the next question of that shape is not asked — `pewt grants` lists them
// and `pewt grants revoke` takes one back (grants.ts, which says what a grant
// covers and why it covers that much).
//
// A shell has only two answers. It is unconfined, so an "always" would be
// "always, anything", and the question carries nothing to scope it with.
//
// Nothing in this file decides anything. A host with no terminal to ask in
// denies, and says which flag turns that into a yes.
//
// Each kind that starts something gets its own flag (`--allow-runs`,
// `--allow-shells`) and its own question. That is P3: a distinct capability
// is a distinct rung with a distinct gesture. A rig that was told it could
// build must not thereby be able to open a shell, and one flag covering both
// is exactly how it would. A standing grant is the same principle with the
// gesture moved: narrower than any flag, and it costs a keystroke rather than
// a restart.
import readline from "node:readline/promises";
import type { HostLogger, SpawnPolicy } from "@fsio/host";
import { describeGrant, grantId, type Grant, type GrantKey } from "pewter";
import type { Pewter } from "./pewter.js";
import { asAgentSpec, AgentError, planAgent, type AgentPlan } from "./agent.js";
import { GRANTS_FILE, GrantsError, readGrants, recordGrant, standingGrant } from "./grants.js";
import { asRunSpec, planRun, RunError, type RunPlan } from "./run.js";
import { planShell, ShellError, type ShellPlan } from "./shell.js";

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
  /** allow every shell without asking. */
  allowShells?: boolean;
  /** allow every agent without asking. */
  allowAgents?: boolean;
  /** where the question goes. */
  asker: Asker;
}

/** The kinds that start something, and the flag that answers yes to each in
 *  advance. Everything else is the API, which starts nothing. */
const STARTS = { run: "--allow-runs", shell: "--allow-shells", agent: "--allow-agents" } as const;

/** The host's spawn policy (D12): consulted for every session, and the only
 *  thing standing between a page and a process on this machine.
 *
 *  A `pewt` session is the API — it reads the folder and bundles extensions,
 *  and starts nothing — so it is allowed and narrated. A `run` and a `shell`
 *  are resolved first (a human should never be asked about a script that does
 *  not exist, or a project that is not there) and then asked about. */
export function spawnGate(p: Pewter, opts: GateOptions, log: HostLogger): SpawnPolicy {
  const told = { run: opts.allowRuns, shell: opts.allowShells, agent: opts.allowAgents };
  return async (spec, info) => {
    // The one kind that starts a process and is not asked about, so it does
    // not ride the "starts nothing" branch below unremarked. Settled in #189
    // on `pewt check`'s precedent: git fetches and executes nothing it
    // fetched, and it writes only inside repos/. Narrated by name, because a
    // host that goes quiet about what it starts has no record of it.
    if (info.kind === "repos.clone") {
      log.info(`● repos.clone — git will fetch into repos/, executing nothing (${from(info.origin)})`);
      return true;
    }
    if (!(info.kind in STARTS)) {
      log.info(`● ${info.kind} session — origin: ${info.origin ?? "(none reported)"}`);
      return true;
    }
    const kind = info.kind as keyof typeof STARTS;
    let plan: Question;
    try {
      plan = kind === "run" ? runQuestion(p, spec) : kind === "shell" ? shellQuestion(p, spec, info) : agentQuestion(p, spec);
    } catch (e) {
      const message =
        e instanceof RunError || e instanceof ShellError || e instanceof AgentError
          ? [e.message, e.hint].filter(Boolean).join(" — ")
          : e instanceof Error
            ? e.message
            : String(e);
      log.warn(`✗ ${message}`);
      return { allow: false, reason: message };
    }
    if (told[kind]) {
      log.info(`▸ ${plan.label} — allowed by ${plan.flag} (${from(info.origin)})`);
      return true;
    }

    // Read at every question rather than held in memory, so a revoke takes
    // effect on the next question rather than on the next host (grants.ts).
    let standing: Grant | null;
    try {
      standing = plan.grant ? standingGrant(readGrants(p), plan.grant) : null;
    } catch (e) {
      // The grants file cannot be read. Nothing starts on a list nobody can
      // check — the safe direction, and the message says how to get moving.
      const message = e instanceof GrantsError ? [e.message, e.hint].filter(Boolean).join(" — ") : e instanceof Error ? e.message : String(e);
      log.warn(`✗ ${message}`);
      return { allow: false, reason: message };
    }
    if (standing) {
      // Narrated even though nobody is asked. A host that goes quiet about
      // what it starts is a host with no record of what it started, and the
      // way to take this one back is on the same line as the fact it was used.
      const t = stamp();
      log.info(`\n${t}  ${header(plan, info.origin)}\n${t}    ✓ allowed — a standing grant: ${describeGrant(standing)}\n${t}      take it back with \`pewt grants revoke ${grantId(standing)}\``);
      return true;
    }

    return askToStart(p, opts.asker, plan, info.origin, log);
  };
}

/** Where a request came from, in the words the narrative uses: a page reports
 *  an origin and a terminal does not. */
const from = (origin: string | undefined): string => (origin ? `from the page (${origin})` : "from a terminal");

/** The one line above every question and every answer: what would start, and
 *  who asked for it. */
const header = (plan: Question, origin: string | undefined): string =>
  `▸ ${plan.label}${" ".repeat(Math.max(1, 40 - plan.label.length))}${from(origin)}`;

/** One thing a human is about to be asked about. Every kind that starts a
 *  process reduces to this, so there is one question and one transcript
 *  rather than one per kind. */
export interface Question {
  /** how it reads in one line: `run build --repo fsio`, `shell --repo site`. */
  label: string;
  /** what would actually run, one line per line of the prompt. */
  lines: string[];
  /** the flag that answers yes to all of these, named in the denial. */
  flag: string;
  /** the standing grant "allow always" would record here, or absent when this
   *  question has no third answer. A shell is the one with none. */
  grant?: GrantKey;
}

function runQuestion(p: Pewter, spec: Readonly<Record<string, unknown>>): Question {
  const asked = asRunSpec(spec);
  if (!asked) throw new RunError("bad_params", "a run needs a script name");
  const plan: RunPlan = planRun(p, asked);
  // The command and the working directory are the whole question. A human
  // deciding whether to allow a build needs to see what the project declared,
  // not the name somebody typed for it.
  return {
    label: plan.label,
    lines: [`npm run ${plan.script}`, plan.declared, `cwd ${plan.where}/`],
    flag: STARTS.run,
    // The project, not the script: what you are being asked to trust is a
    // package.json you can read, and the next script in it is a line away.
    grant: { kind: "run", ...(plan.repo !== undefined ? { repo: plan.repo } : {}) },
  };
}

function shellQuestion(p: Pewter, spec: Readonly<Record<string, unknown>>, info: { cmd?: string | undefined; cwd?: string | undefined; pty?: boolean | undefined }): Question {
  const plan: ShellPlan = planShell(p, spec, info);
  return {
    label: plan.label,
    // A shell is not a command with a purpose you can read, so there is less
    // to show than a run has: the program, where it starts, and the one thing
    // a person cannot see from the outside — that nothing confines it.
    lines: [plan.cmd, `cwd ${plan.where}/`, plan.pty ? "a terminal, unconfined — it can do anything you can" : "no pty (node-pty missing): pipes, so no job control and no full-screen programs"],
    flag: STARTS.shell,
  };
}

function agentQuestion(p: Pewter, spec: Readonly<Record<string, unknown>>): Question {
  const plan: AgentPlan = planAgent(p, asAgentSpec(spec));
  return {
    label: plan.label,
    lines: [
      `${plan.adapter.title}${plan.version ? ` ${plan.version}` : ""}`,
      `cwd ${plan.where}/`,
      // The one fact a person wants before saying yes to an agent, and the
      // reason the roster carries a measured column at all. A version nobody
      // measured says so here rather than in a footnote — this is the moment
      // the answer matters.
      plan.adapter.asks
        ? `it asks before it edits${plan.unmeasured ? ` (measured at ${plan.adapter.measured}, this is ${plan.version ?? "unknown"})` : ""}`
        : "it edits with its own hands — nothing will ask you again",
    ],
    flag: STARTS.agent,
    // The adapter as well as the project, unlike a run. The line above is the
    // whole content of this question, and a grant covering an adapter nobody
    // read that line about would answer a question nobody asked.
    grant: { kind: "agent", adapter: plan.adapter.name, ...(plan.repo !== undefined ? { repo: plan.repo } : {}) },
  };
}

/** Ask about one thing that would start, and remember the answer if that is
 *  what was answered. `origin` is where it came from, in the words the
 *  narrative uses: a page reports one, a terminal does not. */
export async function askToStart(p: Pewter, asker: Asker, plan: Question, origin: string | undefined, log: HostLogger): Promise<{ allow: boolean; reason?: string }> {
  const t = stamp();
  if (!asker.ask) {
    log.warn(`${t}  ${header(plan, origin)}\n${t}    ✗ denied — this host has no terminal to ask in`);
    return {
      allow: false,
      reason: `the host has no terminal to ask on, so it cannot allow a process; start it with \`pewt serve ${plan.flag}\` to answer yes to every one of these`,
    };
  }

  const [first, ...rest] = plan.lines;
  const answer = (
    await asker.ask(
      `\n${t}  ${header(plan, origin)}\n` +
        `${t}    ?   ${first}\n` +
        rest.map((line) => `${t}        ${line}\n`).join("") +
        // Three answers where there is something to remember, two where there
        // is not. Deny is the capital, so a bare Enter starts nothing.
        (plan.grant ? `${t}      allow once / allow always / deny  [o/a/D] ` : `${t}      allow once / deny  [y/N] `)
    )
  )
    .trim()
    .toLowerCase();

  const always = answer === "a" || answer === "always";
  // `y` still means once. It is what this question took before there was a
  // third answer, and it is what a hand types.
  const once = answer === "o" || answer === "once" || answer === "y" || answer === "yes";

  if (always && !plan.grant) {
    // Typed `a` at a shell, almost certainly straight after answering `a` to a
    // run. Denied rather than quietly downgraded to once: the answer meant
    // something this question cannot do, and being told why is the point.
    const reason = "a shell has no standing grant — it is unconfined, so an `always` here would be `always, anything`";
    log.warn(`${stamp()}    ✗ denied — ${plan.label}\n${stamp()}      ${reason}`);
    return { allow: false, reason };
  }

  if (always) {
    let recorded: { grant: Grant; already: boolean };
    try {
      recorded = recordGrant(p, plan.grant!);
    } catch (e) {
      // The answer was yes and it stands; only the memory of it failed. A
      // host that denied here would be punishing a human for a broken file.
      const why = e instanceof GrantsError ? [e.message, e.hint].filter(Boolean).join(" — ") : e instanceof Error ? e.message : String(e);
      log.warn(`${stamp()}    ✓ allowed once — ${plan.label}\n${stamp()}      but not remembered: ${why}`);
      return { allow: true };
    }
    log.info(
      `${stamp()}    ✓ standing grant ${recorded.already ? "already recorded in" : "recorded →"} ${GRANTS_FILE}\n` +
        `${stamp()}      ${describeGrant(recorded.grant)} — take it back with \`pewt grants revoke ${grantId(recorded.grant)}\``
    );
    return { allow: true };
  }

  log.info(`${stamp()}    ${once ? "✓ allowed once" : "✗ denied"} — ${plan.label}`);
  return once ? { allow: true } : { allow: false, reason: "denied at the host's terminal" };
}
