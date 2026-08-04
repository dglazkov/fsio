// The right-hand pane: two lists, and the whole argument between them.
//
// Above the line, the granted folder — files that are on your disk, which
// the page can read because you handed it that one directory and for no
// other reason. Below it, the files the page has custody of, in the
// browser's own storage. The same file can appear in both, and it means
// two different things in each.
//
// The split is doing the teaching, so the pane never merges the halves,
// never sorts one into the other, and keeps both visible when one is empty:
// an empty top with a full bottom is the demo's punchline (no folder, and
// the page still has its files), and it only lands if the empty half is
// still on screen saying so.
//
// The shape is acp-demo's workspace pane, which is where the row layout and
// the change-fade come from; what is new here is that a row is a control.
import { LitElement, html, css } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { ago, sizeOf, tokens } from "@fsio/ui";
import type { HeldFile } from "../../src/model";
import { app, folder, folderFiles, folderNote, type FileRow } from "../state";
import { flingLocal, runOperation } from "../run";

/** How long a changed file stays highlighted. */
const GLOW_MS = 12_000;

class ActuatorFiles extends SignalWatcher(LitElement) {
  #tick: ReturnType<typeof setInterval> | undefined;

  static override styles = [
    tokens,
    css`
      :host {
        display: flex; flex-direction: column; min-height: 0;
        border-left: 1px solid var(--fsio-line); background: var(--fsio-aside);
      }
      section { display: flex; flex-direction: column; min-height: 0; flex: 1 1 50%; }
      section + section { border-top: 1px solid var(--fsio-line-strong); }
      header {
        display: flex; justify-content: space-between; align-items: baseline; gap: 0.5rem;
        padding: 0.5rem 0.8rem 0.3rem; font-size: 0.78rem; color: var(--fsio-fg);
      }
      header .count { color: var(--fsio-dimmest); font-size: 0.72rem; white-space: nowrap; }
      .blurb { padding: 0 0.8rem 0.45rem; font-size: 0.68rem; line-height: 1.45; color: var(--fsio-dimmest); }
      ul { list-style: none; margin: 0; padding: 0 0 0.4rem; overflow-y: auto; flex: 1; }
      li {
        display: flex; align-items: center; gap: 0.4rem;
        padding: 0.2rem 0.5rem 0.2rem 0.8rem; font-size: 0.8rem; color: var(--fsio-dim);
        font-family: var(--fsio-mono); cursor: pointer;
      }
      li:hover { background: var(--fsio-panel); color: var(--fsio-fg-bright); }
      li.hot { color: var(--fsio-fg-bright); background: var(--fsio-accent-wash); }
      li.open { color: var(--fsio-fg-bright); }
      li .path {
        flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        direction: rtl; text-align: left;
      }
      li .meta { color: var(--fsio-dimmest); white-space: nowrap; font-size: 0.72rem; }
      li.hot .meta { color: var(--fsio-cyan); }
      button {
        flex: none; border: 1px solid transparent; background: none; border-radius: 6px;
        color: var(--fsio-dimmest); font: inherit; font-size: 0.72rem; line-height: 1;
        padding: 0.15rem 0.3rem; cursor: pointer; opacity: 0;
      }
      li:hover button, button:focus-visible { opacity: 1; }
      button:hover { color: var(--fsio-fg-bright); border-color: var(--fsio-line-strong); }
      .empty { padding: 0.4rem 0.8rem; font-size: 0.72rem; line-height: 1.5; color: var(--fsio-dimmest); }
      .empty code { color: var(--fsio-dim); }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    // Both halves say how long ago on wall-clock time, so re-render on a
    // slow tick rather than only when something changes.
    this.#tick = setInterval(() => this.requestUpdate(), 2000);
  }

  override disconnectedCallback(): void {
    clearInterval(this.#tick);
    super.disconnectedCallback();
  }

  override render(): TemplateResult {
    const state = app.get();
    const openPaths = new Set(state.tabs.flatMap((t) => (t.body.kind === "local" ? [t.body.path] : [])));
    const rows = folderFiles.get();
    const held = [...state.held].sort((a, b) => b.at - a.at);
    const f = folder.get();
    const now = Date.now();

    return html`
      <section>
        <header><span>in the folder</span><span class="count">${f ? folderNote.get() : "not granted"}</span></header>
        <div class="blurb">on your disk. The page reads these through your grant — opening one moves nothing.</div>
        ${rows.length === 0
          ? html`<div class="empty">
              ${f
                ? html`nothing to show in <code>${f.name}/</code>`
                : html`no folder granted. The page cannot see your disk — and everything below still works.`}
            </div>`
          : html`<ul>
              ${rows.map((r) => this.#localRow(r, openPaths.has(r.path), now))}
            </ul>`}
      </section>

      <section>
        <header>
          <span>in this browser</span>
          <span class="count">${held.length ? `${held.length} · ${sizeOf(held.reduce((n, h) => n + h.size, 0))}` : "empty"}</span>
        </header>
        <div class="blurb">copies the page owns. These stay when the folder and the helper go.</div>
        ${held.length === 0
          ? html`<div class="empty">nothing flung yet. Try <code>actuator fling ~/some-file</code>, or ⤓ on a file above.</div>`
          : html`<ul>
              ${held.map((h) => this.#heldRow(h, now))}
            </ul>`}
      </section>
    `;
  }

  #localRow(row: FileRow, open: boolean, now: number): TemplateResult {
    const classes = [row.seenChanged && now - row.seenChanged < GLOW_MS ? "hot" : "", open ? "open" : ""]
      .filter(Boolean)
      .join(" ");
    return html`<li
      class=${classes}
      title=${`${row.path} — ${sizeOf(row.size)}. Click to open it in a tab.`}
      @click=${() => void this.#run({ method: "files.open", params: { path: row.path } })}
    >
      <span class="path">${row.path}</span>
      <span class="meta">${ago(now - row.modified)}</span>
      <button
        title="hand the page a copy of this file — it keeps it"
        @click=${(e: Event) => {
          e.stopPropagation();
          void this.#hold(row.path);
        }}
      >
        ⤓
      </button>
    </li>`;
  }

  #heldRow(file: HeldFile, now: number): TemplateResult {
    return html`<li
      title=${`${file.name} — ${sizeOf(file.size)}, flung from ${file.from}. Click to open it in a tab.`}
      @click=${() => void this.#run({ method: "files.show", params: { id: file.id } })}
    >
      <span class="path">${file.name}</span>
      <span class="meta">${sizeOf(file.size)} · ${ago(now - file.at)}</span>
      <button
        title="let go of this copy"
        @click=${(e: Event) => {
          e.stopPropagation();
          void this.#run({ method: "files.drop", params: { id: file.id } });
        }}
      >
        ✕
      </button>
    </li>`;
  }

  /** A click here is the same operation the CLI sends — same reducer, same
   *  store, same signal. A refusal lands in the status line the same way
   *  too, which is why nothing is caught and shown here. */
  async #run(op: Parameters<typeof runOperation>[0]): Promise<void> {
    await runOperation(op, "page").catch(() => {});
  }

  async #hold(path: string): Promise<void> {
    await flingLocal(path, folder.get()?.name ?? "folder").catch(() => {});
  }
}

customElements.define("actuator-files", ActuatorFiles);
