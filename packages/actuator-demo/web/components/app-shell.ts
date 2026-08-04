// The app being actuated: a bar naming the folder, the tabs in it, what the
// active tab is showing, and — on the right — where files are.
//
// Deliberately an ordinary little application. Nothing in this file knows
// that a terminal exists — it renders page state and edits page state, and
// the commands arriving from the machine land in exactly the same place a
// click does (run.ts). That is the claim the demo is making, so the UI
// must not have a special "remote" path anywhere in it.
//
// A tab shows one of three things and the renderer treats all three alike:
// a message, a file in the folder, a file this page holds. The line under
// the title is the only place the difference is spoken, and it is spoken
// every time, because "which of these do I still have if the folder goes
// away" is the question this demo exists to answer.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { tokens, panel, sizeOf } from "@fsio/ui";
import type { Chip } from "@fsio/ui";
import type { Tab } from "../../src/model";
import { contentFor } from "../content";
import { runOperation } from "../run";
import { app, displaced, filesOpen, folder, folderFiles, helper, lastCommand, phase, setupHidden } from "../state";
import "./details";
import "./files-pane";
import "./setup";

class ActuatorApp extends SignalWatcher(LitElement) {
  static override styles = [
    tokens,
    panel,
    css`
      :host {
        display: flex; flex-direction: column; flex: 1; min-height: 0;
        background: var(--fsio-bg); color: var(--fsio-fg);
        font-family: var(--fsio-mono);
      }
      .body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 17rem; position: relative; }
      /* The button that opens the pane when the pane has nowhere to sit.
         Hidden at widths where the pane is simply there. */
      .drawerBtn {
        display: none; flex: none; align-items: center; gap: 0.3rem;
        background: none; border: 1px solid var(--fsio-line-strong); border-radius: 6px;
        color: var(--fsio-dimmer); font: inherit; font-size: 0.74rem;
        padding: 0.15rem 0.5rem; cursor: pointer;
      }
      .drawerBtn:hover { color: var(--fsio-fg-bright); border-color: var(--fsio-control-hover); }
      .drawerBtn:focus-visible { outline: 2px solid var(--fsio-accent); outline-offset: 2px; }
      /* Narrow: the pane stops being a column and becomes a drawer over the
         one that is left. It used to be display:none — the files pane
         simply gone, with nothing saying it existed. That is the worst
         possible narrow-width answer for THIS demo, because the bottom half
         of that pane is the page's own custody of its files, which is the
         entire second act. */
      @media (max-width: 52rem) {
        .body { grid-template-columns: minmax(0, 1fr); }
        .drawerBtn { display: inline-flex; }
        actuator-files {
          position: absolute; inset: 0 0 0 auto; width: min(19rem, 86vw); z-index: 4;
          box-shadow: var(--fsio-lift); background: var(--fsio-aside);
          transform: translateX(100%); transition: transform 180ms ease-out;
        }
        actuator-files[data-open] { transform: none; }
        @media (prefers-reduced-motion: reduce) { actuator-files { transition: none; } }
      }
      main { min-height: 0; overflow: auto; display: grid; place-items: start center; padding: 3rem 1.5rem; }
      article {
        width: min(46rem, 100%); border: 1px solid var(--fsio-line); border-radius: 14px;
        padding: 2rem 2.2rem; background: var(--fsio-panel);
      }
      h1 { margin: 0 0 0.4rem; font: 400 2.3rem/1.05 var(--fsio-title); color: var(--fsio-fg-bright); }
      .origin {
        margin: 0 0 1.2rem; font-size: 0.72rem; color: var(--fsio-dimmest);
        display: flex; align-items: baseline; gap: 0.4rem; flex-wrap: wrap;
      }
      .origin .mark { color: var(--fsio-cyan); }
      .message { line-height: 1.75; white-space: pre-wrap; font-size: 0.92rem; }
      pre.text {
        margin: 0; max-height: 32rem; overflow: auto; font-size: 0.8rem; line-height: 1.6;
        white-space: pre-wrap; word-break: break-word; color: var(--fsio-fg);
      }
      img.view { max-width: 100%; border-radius: 8px; display: block; background: var(--fsio-aside); }
      .note { margin-top: 0.9rem; font-size: 0.74rem; color: var(--fsio-dimmest); }
      .gone { color: var(--fsio-bad-bright); font-size: 0.85rem; line-height: 1.6; }
      .empty {
        color: var(--fsio-dimmer); padding-top: 3rem;
        width: min(34rem, 100%); display: flex; flex-direction: column; gap: 0.5rem;
      }
      .empty p { margin: 0 0 0.3rem; }
      footer {
        display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
        padding: 0.45rem 0.9rem; border-top: 1px solid var(--fsio-line);
        background: var(--fsio-panel); font-size: 0.76rem; color: var(--fsio-dimmer);
      }
      .badge {
        border: 1px solid var(--fsio-line-strong); border-radius: 999px;
        padding: 0.05rem 0.5rem; color: var(--fsio-dimmer);
      }
      .badge.cli { color: var(--fsio-cyan); border-color: var(--fsio-cyan); }
      button.badge.door { font: inherit; background: none; cursor: pointer; color: var(--fsio-cyan); border-color: var(--fsio-cyan); }
      button.badge.door:hover { color: var(--fsio-fg-bright); }
      .badge.bad { color: var(--fsio-bad-bright); border-color: var(--fsio-bad-line); }
      code { color: var(--fsio-fg); }
    `,
  ];

  override render(): TemplateResult {
    const state = app.get();
    const active = state.tabs.find((t) => t.id === state.activeId);
    const chips: Chip[] = state.tabs.map((t) => ({
      id: t.id,
      name: t.title,
      title: `${t.title} · ${t.id}`,
      closeTitle: "remove this tab",
    }));
    const f = folder.get();
    const open = filesOpen.get();
    const shown = state.held.length + folderFiles.get().length;
    return html`
      <fsio-top-bar name=${f ? f.name : "fsio"} suffix="/ actuator">
        <fsio-tab-strip
          .chips=${chips}
          .activeId=${state.activeId}
          .showList=${false}
          label="tabs in this app"
          @select=${(e: CustomEvent<{ id: string }>) => void this.#run("tabs.activate", e.detail.id)}
          @close=${(e: CustomEvent<{ id: string }>) => void this.#run("tabs.remove", e.detail.id)}
        ></fsio-tab-strip>
        <button
          slot="status"
          class="drawerBtn"
          aria-expanded=${open}
          aria-controls="files"
          title="the files this page can see, and the ones it is holding"
          @click=${() => filesOpen.set(!open)}
        >
          files${shown ? html` · ${shown}` : nothing}
        </button>
      </fsio-top-bar>

      <div class="body">
        <main>
          ${active
            ? html`<article>
                <h1>${active.title}</h1>
                ${this.#origin(active)} ${this.#view(active)}
              </article>`
            : this.#empty()}
        </main>
        <actuator-files id="files" ?data-open=${open}></actuator-files>
      </div>

      <!-- Spoken when it changes, because the change is the demonstration: a
           command typed in a terminal in another window rewrites this line,
           and someone who cannot see it has no other evidence it landed. -->
      <footer role="status" aria-live="polite">${this.#status()}</footer>
      <actuator-details></actuator-details>
      <actuator-setup></actuator-setup>
    `;
  }

  /** Nothing here yet, and the two commands that change that.
   *
   *  They used to be bare `<code>` — the one screen in the demo whose whole
   *  job is to get a command into your terminal, printing it as something to
   *  retype, while the copy button that setup uses sat one import away. */
  #empty(): TemplateResult {
    return html`<div class="empty">
      <p>No tabs yet. Open one from the folder:</p>
      <fsio-cmd command=${`actuator tabs add --title Build --message "CI is running"`}></fsio-cmd>
      <fsio-cmd command="actuator open notes.md"></fsio-cmd>
    </div>`;
  }

  /** Where what you are looking at actually lives. One line, always
   *  present, and the only place in the app that distinguishes the three
   *  kinds of tab. */
  #origin(tab: Tab): TemplateResult {
    if (tab.body.kind === "message") {
      return html`<div class="origin"><span class="mark">✎</span> text, as it arrived</div>`;
    }
    const loaded = contentFor(tab.body);
    const size = loaded && !loaded.missing ? ` · ${sizeOf(loaded.size)}` : "";
    if (tab.body.kind === "local") {
      return html`<div class="origin">
        <span class="mark">↗</span> ${folder.get()?.name ?? "the folder"}/${tab.body.path}${size} — on your disk, read live
      </div>`;
    }
    const file = app.get().held.find((h) => h.id === (tab.body as { fileId: string }).fileId);
    return html`<div class="origin">
      <span class="mark">⬒</span> held in this browser${size}${file ? ` · from ${file.from}` : ""} — yours now, folder or no folder
    </div>`;
  }

  #view(tab: Tab): TemplateResult {
    if (tab.body.kind === "message") return html`<div class="message">${tab.body.message}</div>`;

    const loaded = contentFor(tab.body);
    if (!loaded) return html`<div class="note">reading…</div>`;
    if (loaded.missing) {
      // The honest end state of a window onto someone else's file. A held
      // copy reaching this means its blob went missing, which is a bug
      // worth seeing rather than papering over.
      return html`<div class="gone">
        ${tab.body.kind === "local"
          ? html`This file is not in the folder any more — it was moved, deleted, or the grant is gone.<br />
              The page never had a copy: that is what opening a file means here.`
          : html`The bytes for this held file are missing from this browser's storage.`}
      </div>`;
    }
    if (loaded.viewer === "text") {
      return html`<pre class="text">${loaded.text}</pre>
        ${loaded.truncated ? html`<div class="note">showing the head of a ${sizeOf(loaded.size)} file</div>` : nothing}`;
    }
    if (loaded.viewer === "image") {
      return html`<img class="view" src=${loaded.url ?? ""} alt=${tab.title} />`;
    }
    return html`<div class="note">
      No viewer for ${loaded.type || "this file type"} yet — ${sizeOf(loaded.size)}
      ${tab.body.kind === "held" ? "held here all the same." : "sitting in the folder."}
    </div>`;
  }

  #status(): TemplateResult {
    const last = lastCommand.get();
    const h = helper.get();
    const live = phase.get() === "live" && !displaced.get();
    // Setup waved off (state.ts) leaves the only route back through here,
    // so the badge stops being a label and becomes the door.
    const hidden = setupHidden.get() && !live;
    return html`
      ${hidden
        ? html`<button class="badge door" @click=${() => setupHidden.set(false)}>connect a folder…</button>`
        : html`<span class="badge ${live ? "cli" : ""}"
            >${displaced.get()
              ? "another page holds this folder"
              : live && h === "alive"
                ? "listening for commands"
                : h === "silent"
                  ? "helper silent"
                  : "not connected"}</span
          >`}
      ${last
        ? html`<span class="badge ${last.ok ? "" : "bad"}">${last.origin === "cli" ? "from the folder" : "from this page"}</span>
            <span>${last.method} — ${last.detail}</span>`
        : html`<span>nothing has happened yet</span>`}
    `;
  }

  /** A click here is the same operation the CLI sends — same reducer, same
   *  store, same signal. The only difference is what the footer says about
   *  where it came from. */
  async #run(method: "tabs.activate" | "tabs.remove", id: string): Promise<void> {
    await runOperation({ method, params: { id } }, "page").catch(() => {});
  }
}

customElements.define("actuator-app", ActuatorApp);
