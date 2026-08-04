// Setup: a modal over the empty chat. Three steps — run the helper, pick the
// folder, choose the agent — and then it dissolves. The frame is `@fsio/ui`'s
// (the terminal demo opens exactly the same way); the panels are this page's.
//
// A returning visit usually never sees it: the folder handle is remembered
// (#58) and, since #113, so is the session. What it does still own is the one
// case Chrome will not let a page automate — a remembered folder whose
// permission came back `prompt`, which needs a user activation to re-grant
// (F15). That is the reconnect panel, and it is one click.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { sinceLabel, wizardStyles } from "@fsio/ui";
import type { Crumb } from "@fsio/ui";
import { adoptable, agents, gate, launch, phase, wizardStep, folder, helper, pickError, reconnectTo, resumeError, type AgentOffer, type Adoptable } from "../state";
import { abandonAndStartNew, adoptSession, chooseAgent, declineRunning, forgetFolder, pickFolder, regrant, retryResume } from "../connection";

// The one-liner (#106): CI force-pushes the bundled helper to the `acp-demo`
// branch on every green main, so this installs and runs the same code the
// repo just tested. No clone, no build, no second terminal to get one.
const CMD = "npx github:dglazkov/fsio#acp-demo";

const TAGLINE =
  "a coding agent on your machine, driven from this page — its whole " +
  "conversation transported through files in a folder you grant.";

class AcpWizard extends SignalWatcher(LitElement) {
  static override styles = [
    ...wizardStyles,
    css`
      .agent, .sess {
        border: 1px solid var(--fsio-line-strong); border-radius: 8px;
        padding: 0.6rem 0.8rem; margin: 0.5rem 0;
        display: flex; gap: 0.8rem; align-items: center;
      }
      .agent .who { flex: 1; min-width: 0; }
      .agent .name { font-family: var(--fsio-mono); font-size: 0.9rem; }
      .agent .what { color: var(--fsio-dim); font-size: 0.85rem; margin-top: 0.1rem; }
      .agent .asks { color: var(--fsio-good); }
      .agent .hands { color: var(--fsio-warn-quiet); }
      .caveat {
        border-left: 2px solid var(--fsio-line-control); padding-left: 0.7rem;
        margin: 0.9rem 0 0; color: var(--fsio-dim); font-size: 0.85rem;
      }
    `,
  ];

  override render(): TemplateResult {
    const g = gate.get();
    const p = phase.get();
    const steps = !g && p === "wizard";
    return html`<fsio-wizard-frame
      edition="agent"
      .tagline=${TAGLINE}
      .crumbs=${steps ? this.#crumbs() : []}
      ?open=${g !== null || p === "wizard" || p === "reconnect" || p === "resume-error" || p === "pick-session"}
    >
      ${g
        ? html`<fsio-gate .msg=${g.msg} .hint=${g.hint}></fsio-gate>`
        : p === "reconnect"
          ? this.#reconnect()
          : p === "resume-error"
            ? this.#resumeError()
            : p === "pick-session"
              ? this.#running()
              : this.#step()}
    </fsio-wizard-frame>`;
  }

  /** The helper opened this page, so step 1 is not a step — it is a fact, and
   *  it is shown as one (#124). Getting told "✓ helper running" is a different
   *  experience from being asked to confirm it: the second is the page
   *  interviewing someone for something the other end already proved. */
  #crumbs(): Crumb[] {
    const s = wizardStep.get();
    const sent = launch.get().dir !== null;
    return [
      { label: sent ? "✓ helper running" : "1 · run the helper", state: sent ? "done" : s === 1 ? "on" : "" },
      { label: sent ? "pick the folder" : "2 · pick the folder", state: s === 2 ? "on" : "" },
      { label: sent ? "the agent" : "3 · the agent", state: s === 3 ? "on" : "" },
    ];
  }

  #step(): TemplateResult {
    const s = wizardStep.get();
    return s === 1 ? this.#stepRun() : s === 2 ? this.#stepPick() : this.#stepAgent();
  }

  /** The remembered folder, one click from being usable again.
   *
   *  This panel exists because of F15: `requestPermission` needs a user
   *  activation, so a page that remembers your folder still cannot reopen it
   *  by itself. Saying that plainly is better than a picker that looks like
   *  the page forgot. */
  #reconnect(): TemplateResult {
    const h = reconnectTo.get();
    return html`
      <p class="explain">
        Last time you granted <code>${h?.name ?? ""}/</code>. Chrome kept the
        folder but not the permission — it wants one click from you before
        this page can open it again. If an agent is still running in there,
        this puts you back in the same conversation.
      </p>
      <div class="row">
        <button class="primary" @click=${() => void regrant()}>Reconnect to ${h?.name ?? "the folder"}/</button>
        <button class="ghost small" @click=${() => void forgetFolder()}>use a different folder</button>
      </div>`;
  }

  #stepRun(): TemplateResult {
    return html`
      <p class="explain">
        In a terminal, <code>cd</code> into the project you want the agent to
        work on, then run:
      </p>
      <fsio-cmd command=${CMD}></fsio-cmd>
      <p class="fineprint">
        No ACP agent installed? Run it anyway — the helper starts without one,
        and step 3 shows you what this machine has and how to get one. It will
        not start anything that isn't on its own list: this page names an
        agent, never a path.
      </p>
      <div class="row">
        <button class="primary" @click=${() => wizardStep.set(2)}>I've run it — next</button>
      </div>
    `;
  }

  /** The one gesture that is genuinely the human's, and the moment the whole
   *  demo is about. Everything #124 removed was clerical; this stayed, and
   *  the copy is written to make it feel like the point rather than a
   *  formality.
   *
   *  When the helper opened this page it named its folder, so the button
   *  names it too — "Pick myproject" instead of "Choose folder…" and a
   *  paragraph explaining which one. That is one hint doing the work of a
   *  sentence, and it is still only a hint: the handle comes from the
   *  picker, and picking something else works exactly as well. */
  #stepPick(): TemplateResult {
    const err = pickError.get();
    const f = folder.get();
    const h = helper.get();
    const l = launch.get();
    return html`
      <p class="explain">
        ${l.dir
          ? html`Pick <code>${l.dir}</code> — the folder the helper is running
              in. Chrome asks twice, once to view and once to save.`
          : html`Pick the <em>same folder</em> the helper is running in. Chrome
              asks twice — once to view, once to save.`}
        That gesture is the whole security model: you are granting this page
        one folder, and the agent gets exactly the same one.
      </p>
      ${l.agent
        ? html`<p class="fineprint">
            The helper reports one agent ready to drive: <code>${l.agent}</code>. It
            starts once the folder is granted, and everything the page says about
            it after that is read from the folder, not from this line.
          </p>`
        : nothing}
      <div class="row">
        ${l.dir ? nothing : html`<button class="ghost small" @click=${() => wizardStep.set(1)}>← back</button>`}
        <button class="primary" @click=${() => void pickFolder()}>${l.dir ? `Pick ${l.dir}` : "Choose folder…"}</button>
        ${f ? html`<span class="fineprint">${f.name}/</span>` : nothing}
      </div>
      ${l.dir
        ? html`<p class="fineprint">
            <button class="ghost small" @click=${() => wizardStep.set(1)}>the helper isn't running?</button>
          </p>`
        : nothing}
      ${err ? html`<div class="status bad">${err.msg}<span class="hint">${err.hint}</span></div>` : nothing}
      ${!err && f && h === "silent"
        ? html`<div class="status wait">
            folder connected, but no helper heartbeat
            <span class="hint">The helper writes a heartbeat every 2 seconds and we're not seeing it. Is it still running, in this exact folder?</span>
          </div>`
        : nothing}
      ${!err && f && h === "alive" ? html`<div class="status ok">helper found — starting the agent</div>` : nothing}
    `;
  }

  /** A session that is probably still running, that we failed to rejoin
   *  (#115).
   *
   *  The page stops here on purpose. Quietly starting a second conversation
   *  would be the failure a reattach exists to prevent — it looks like it
   *  worked, and the first conversation keeps running with nothing pointing
   *  at it. Both buttons here are honest: one tries again, the other says out
   *  loud that the old session is being left behind. */
  #resumeError(): TemplateResult {
    const e = resumeError.get();
    return html`
      <div class="status bad">${e?.msg ?? "could not rejoin the session"}<span class="hint">${e?.hint ?? ""}</span></div>
      <p class="fineprint">
        Nothing was started in its place, so there is still exactly one
        conversation in this folder.
      </p>
      <div class="row">
        <button class="primary" @click=${() => void retryResume()}>Try again</button>
        <button class="ghost small" @click=${() => void abandonAndStartNew()}>leave it running and start a new one</button>
      </div>`;
  }

  /** Conversations already running in this folder that nothing here has a
   *  record of (#117).
   *
   *  This panel is the difference between "the agent is gone" and "the page
   *  forgot where it was". Sessions live in the helper (#113), the folder
   *  lists them (D18 discovery), and none of that depends on which browser
   *  profile — or which browser — is looking. What it costs to be honest is
   *  the caveat at the bottom, and it is not a footnote: a rejoined
   *  conversation is genuinely half a conversation, and a panel that offered
   *  the rejoin without saying so would be handing someone a transcript with
   *  a hole in it and no sign there was ever anything there. */
  #running(): TemplateResult {
    const rows = adoptable.get();
    const f = folder.get();
    return html`
      <h2>${rows.length === 1 ? "A conversation is already running here" : `${rows.length} conversations are already running here`}</h2>
      <p class="explain">
        The agent lives in the helper, not in this tab — closing a page
        doesn't end it. These are running in <code>${f?.name ?? "this folder"}/</code>
        right now, and this browser has no record of any of them, which is
        why you are being asked instead of quietly given a new one.
      </p>
      ${rows.map((r) => this.#session(r))}
      <p class="caveat">
        What rejoining brings back, and what it can't: the agent's half comes
        out of the folder entire — every message, tool call and question.
        What you typed rode the uplink, which the folder never sees, and the
        browser record that would have carried it is the thing that's
        missing. So the conversation comes back with no human side before the
        moment you join it, and any permission question in it comes back with
        no verdict beside it: this page can't tell one that was answered from
        one the agent is still waiting on. Both are said in the transcript,
        where you'll be reading it.
      </p>
      <div class="row">
        <button @click=${() => void declineRunning()}>Leave them and start a new conversation</button>
      </div>
      <p class="fineprint">
        Starting a new one doesn't stop these — they keep running, and they
        keep showing up here. Only “end session” stops an agent.
      </p>`;
  }

  /** One offer. The `quote` line is the point of the row: an id and a
   *  timestamp are a list of hashes, and what a person actually chooses by is
   *  what the thing was saying. */
  #session(r: Adoptable): TemplateResult {
    return html`<fsio-session-row
      boxed
      .name=${r.agentName || r.agent || "an agent"}
      .note=${r.agentVersion ?? ""}
      .meta=${`${sinceLabel(r.startedAt, Date.now())} · ${
        r.detached
          ? "detached — no page is holding it"
          : `held by ${r.client || "another page"}${r.origin ? ` at ${r.origin}` : ""}, so rejoining takes it over`
      }`}
      .quote=${r.lastLine ?? ""}
      .flag=${r.blocked ?? ""}
      .action=${r.blocked ? "" : "Rejoin"}
      primary
      @action=${() => void adoptSession(r.id)}
    ></fsio-session-row>`;
  }

  /** Step 3 (#102): what this machine has, and what each one will do.
   *
   *  Reached only when there is something to say — several agents to pick
   *  between, or none at all. With exactly one installed the page names it
   *  and never shows this. */
  #stepAgent(): TemplateResult {
    const roster = agents.get() ?? [];
    const ready = roster.filter((a) => a.installed);
    const rest = roster.filter((a) => !a.installed);
    return html`
      ${ready.length
        ? html`<p class="explain">
            This machine has ${ready.length} ACP agents. Pick the one to drive —
            the page sends its <em>name</em>, and the helper looks that up in
            its own allow-list.
          </p>`
        : html`<p class="explain">
            No ACP agent on this machine yet. The helper is running and this
            page is watching: install one in a terminal and it shows up here,
            no restart, no reload.
          </p>`}
      ${ready.map((a) => this.#agent(a))}
      ${rest.length
        ? html`<p class="fineprint">${ready.length ? "Also known here, not installed:" : "The helper knows these:"}</p>
            ${rest.map((a) => this.#agent(a))}`
        : nothing}
      <p class="fineprint">
        fsio ships no agent on purpose: vendoring one costs ~118 MB of
        dependencies, and an agent you installed is one you can also inspect,
        update and revoke. Only want to see the permission card? Re-run the
        helper with <code>--fixture</code> — that's a scripted puppet, not a
        real agent, and it says so.
      </p>
    `;
  }

  /** One roster line. The `asks` sentence is the one that matters: this
   *  demo is about the agent's consent question becoming page UI, and not
   *  every agent sends one (F30, #100). Saying so before the choice beats
   *  discovering it after a turn that edited a file silently. */
  #agent(a: AgentOffer): TemplateResult {
    return html`<div class="agent">
      <div class="who">
        <span class="name">${a.name}</span> — ${a.title}
        <div class="what">
          ${a.asks
            ? html`<span class="asks">asks before it edits</span> — the permission card is this demo`
            : html`<span class="hands">edits with its own hands</span> — you'll see the transport and the live
                workspace, but no permission card`}
        </div>
        ${a.installed ? nothing : html`<fsio-cmd command=${a.install}></fsio-cmd>`}
      </div>
      ${a.installed
        ? html`<button class="primary" @click=${() => void chooseAgent(a.name)}>Use this one</button>`
        : nothing}
    </div>`;
  }
}

customElements.define("acp-wizard", AcpWizard);
