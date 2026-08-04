// Setup: a modal over the empty terminal. Two steps — run the helper, pick
// the folder — and then it dissolves, unless the arrival picker intercepts
// first. The frame is `@fsio/ui`'s (the agent demo opens exactly the same
// way); the panels are this page's.
import { LitElement, html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { friendlyName, wizardStyles } from "@fsio/ui";
import type { Crumb } from "@fsio/ui";
import { gate, phase, wizardStep, folder, helper, pickError, reconnectTo, resumable, tabs } from "../state";
import { pickFolder, regrant, dismissPicker, onMac } from "../connection";
import { openTab } from "../tabs";

const CMD = "npx github:dglazkov/fsio#terminal-demo";

const TAGLINE =
  "a terminal to your own machine, served from this page — transported " +
  "through nothing but files in a folder.";

class FsioWizard extends SignalWatcher(LitElement) {
  // Nothing of its own: every panel below is built out of the shared
  // vocabulary, which is the point of having one.
  static override styles = wizardStyles;

  override render(): TemplateResult {
    const g = gate.get();
    const p = phase.get();
    const steps = !g && p === "wizard";
    return html`<fsio-wizard-frame
      edition="terminal"
      .tagline=${TAGLINE}
      .crumbs=${steps ? this.#crumbs() : []}
      ?open=${g !== null || (p !== "shell" && p !== "boot")}
      ?dismissible=${p === "picker" && tabs.get().length > 0}
      @dismiss=${() => dismissPicker()}
    >
      ${g
        ? html`<fsio-gate .msg=${g.msg} .hint=${g.hint}></fsio-gate>`
        : p === "reconnect"
          ? this.#reconnect()
          : p === "picker"
            ? this.#picker()
            : this.#step()}
    </fsio-wizard-frame>`;
  }

  #crumbs(): Crumb[] {
    const s = wizardStep.get();
    return [
      { label: "1 · run the helper", state: s === 1 ? "on" : "" },
      { label: "2 · pick the folder", state: s === 2 ? "on" : "" },
    ];
  }

  #step(): TemplateResult {
    return wizardStep.get() === 1 ? this.#stepRun() : this.#stepPick();
  }

  #stepRun(): TemplateResult {
    return html`
      <p class="explain">
        In a terminal, <code>cd</code> into a folder you're comfortable
        handing to this page, then:
      </p>
      <fsio-cmd command=${CMD}></fsio-cmd>
      <p class="fineprint">
        ${onMac
          ? html`macOS only (for now). The shell you'll get is sandboxed to
              that folder: it can read the world, but writes anywhere else are
              denied — the policy is a plain text file the helper drops at
              <code>.fsio/sandbox.sb</code>.`
          : html`<strong>Heads up: the helper is macOS-only for now</strong>
              (its sandbox is built on Apple's Seatbelt). The page will
              connect from anywhere, but the helper side needs a Mac.`}
      </p>
      <div class="row">
        <button class="primary" @click=${() => wizardStep.set(2)}>I've run it — next</button>
        ${folder.get() && helper.get() === "silent"
          ? html`<span class="fineprint">${folder.get()!.name}/ is connected from last visit — waiting for the helper's heartbeat.</span>`
          : nothing}
      </div>
    `;
  }

  /** The one gesture that is genuinely the human's, and the moment the whole
   *  demo is about. */
  #stepPick(): TemplateResult {
    const err = pickError.get();
    const f = folder.get();
    const h = helper.get();
    return html`
      <p class="explain">
        Pick the <em>same folder</em> the helper is running in. Chrome will
        ask twice — once to view, once to save. That's the point:
        <em>you</em> are granting this page the folder, and nothing else.
      </p>
      <div class="row">
        <button class="ghost small" @click=${() => wizardStep.set(1)}>← back</button>
        <button class="primary" @click=${() => void pickFolder()}>Choose folder…</button>
        ${f ? html`<span class="fineprint">${f.name}/${f.via === "picked" ? "" : " (remembered from last visit)"}</span>` : nothing}
      </div>
      ${err ? html`<div class="status bad">${err.msg}<span class="hint">${err.hint}</span></div>` : nothing}
      ${!err && f && h === "silent"
        ? html`<div class="status wait">
            folder connected, but no helper heartbeat
            <span class="hint">The helper writes a heartbeat every 2 seconds; we're not seeing it. Is it still running in this exact folder?</span>
          </div>`
        : nothing}
      ${!err && f && h === "alive" ? html`<div class="status ok">helper found — its heartbeat is in the folder</div>` : nothing}
    `;
  }

  /** The remembered folder, one click from being usable again.
   *
   *  This panel exists because of F15: `requestPermission` needs a user
   *  activation, so a page that remembers your folder still cannot reopen it
   *  by itself. */
  #reconnect(): TemplateResult {
    const name = reconnectTo.get()?.name ?? "your folder";
    return html`
      <h2>Welcome back</h2>
      <p class="explain">
        This page remembers <code>${name}/</code> from last visit. One click
        and you're back in — Chrome will just confirm the folder grant.
      </p>
      <div class="row">
        <button class="primary" @click=${() => void regrant()}>Reconnect to ${name}/</button>
        <button class="ghost" @click=${() => { phase.set("wizard"); wizardStep.set(1); }}>use a different folder</button>
      </div>`;
  }

  /** Shells already running in this folder, offered on arrival. Filtered
   *  against live tabs at render time so a just-resumed row disappears
   *  immediately — the 2 s poll would lag behind the click. */
  #picker(): TemplateResult {
    const held = new Set(tabs.get().filter((t) => t.session).map((t) => t.sessionId));
    const rows = resumable.get().filter((r) => !held.has(r.id));
    return html`
      <h2>Your shells are still here</h2>
      <p class="explain">
        Shells live in the helper, not the tab — closing the page doesn't end
        them. Resume one (scrollback included), or start fresh. Each resume
        opens its own tab.
      </p>
      ${rows.length === 0
        ? html`<p class="fineprint">No running shells right now — start a new one below.</p>`
        : rows.map(
            (r) => html`<fsio-session-row
              boxed
              .name=${friendlyName(r.id)}
              .meta=${r.status?.detached
                ? "detached — no tab is holding it, safe to resume"
                : `held by ${r.client ?? "another client"}${r.origin ? ` at ${r.origin}` : ""} — resuming takes it over (that tab keeps watching, read-only)`}
              .action=${"Resume"}
              primary
              @action=${() => openTab(r.id)}
            ></fsio-session-row>`
          )}
      <div class="row">
        <button @click=${() => { openTab(); dismissPicker(); }}>Start a new shell</button>
        ${tabs.get().length > 0 ? html`<button class="primary" @click=${() => dismissPicker()}>To the terminal</button>` : nothing}
      </div>`;
  }
}

customElements.define("fsio-wizard", FsioWizard);
