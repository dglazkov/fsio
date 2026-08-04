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
// The row is `@fsio/ui`'s now (`<fsio-file-row>`) — this file's header used to
// say the layout and the change-fade were copied out of acp-demo's workspace
// pane, which is exactly the citation rule 6 waits for. What is still this
// page's is that a row is a *control*: it opens, and it carries the two verbs
// that make this demo's point.
//
// The top half is a tree (`<fsio-file-tree>`, also shared): the folder has a
// shape, and a picker that flattens it makes you read three directories of
// prefix on every row to find the one file you came for. The bottom half is
// not, and cannot be — a flung copy has a name and a provenance, not a place.
// The page is holding it. That asymmetry is the split doing its teaching
// again: what is in the folder is *somewhere*, what the page holds is just
// here.
import { LitElement, html, css } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { ago, sizeOf, tokens, Ticker } from "@fsio/ui";
import type { TreeRow } from "@fsio/ui";
import type { HeldFile } from "../../src/model";
import { app, folder, folderFiles, folderNote } from "../state";
import { flingLocal, runOperation } from "../run";

class ActuatorFiles extends SignalWatcher(LitElement) {
  // Both halves say how long ago on wall-clock time, and the fade expires on
  // it too, so re-render on a slow tick rather than only when something
  // changes.
  #ticker = new Ticker(this);

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
      .rows { padding: 0 0 0.4rem; overflow-y: auto; flex: 1; }
      /* The held half's controls only: the tree styles the ones it lays out,
         since they sit in its shadow root and this sheet cannot reach them. */
      fsio-file-row button {
        border: 1px solid transparent; background: none; border-radius: 6px;
        color: var(--fsio-dimmest); font: inherit; font-size: 0.72rem; line-height: 1;
        padding: 0.15rem 0.3rem; cursor: pointer;
      }
      fsio-file-row button:hover { color: var(--fsio-fg-bright); border-color: var(--fsio-line-strong); }
      fsio-file-row button:focus-visible { outline: 2px solid var(--fsio-accent); outline-offset: 1px; }
      .empty { padding: 0.4rem 0.8rem; font-size: 0.72rem; line-height: 1.5; color: var(--fsio-dimmest); }
      .empty code { color: var(--fsio-dim); }
    `,
  ];

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
          : html`<div class="rows">
              <fsio-file-tree
                .rows=${rows}
                .now=${now}
                .open=${[...openPaths]}
                .metaFor=${(r: TreeRow) => ago(now - r.modified)}
                .actionsFor=${(r: TreeRow) => this.#fling(r)}
                label="files in the granted folder"
                @open=${(e: CustomEvent<{ path: string }>) =>
                  void this.#run({ method: "files.open", params: { path: e.detail.path } })}
              ></fsio-file-tree>
            </div>`}
      </section>

      <section>
        <header>
          <span>in this browser</span>
          <span class="count">${held.length ? `${held.length} · ${sizeOf(held.reduce((n, h) => n + h.size, 0))}` : "empty"}</span>
        </header>
        <div class="blurb">copies the page owns. These stay when the folder and the helper go.</div>
        ${held.length === 0
          ? html`<div class="empty">nothing flung yet. Try <code>actuator fling ~/some-file</code>, or ⤓ on a file above.</div>`
          : html`<div class="rows" role="list">
              ${held.map((h) => this.#heldRow(h, now))}
            </div>`}
      </section>
    `;
  }

  /** The verb that makes this pane this demo's: take a copy. It is slotted
   *  into the tree's row rather than drawn by it, because the tree lays rows
   *  out and this page is the one with something to say about them. */
  #fling(row: TreeRow): TemplateResult {
    return html`<button
      title=${`hand the page a copy of ${row.path} (${sizeOf(row.size)}) — it keeps it`}
      @click=${(e: Event) => {
        e.stopPropagation();
        void this.#hold(row.path);
      }}
    >
      ⤓
    </button>`;
  }

  #heldRow(file: HeldFile, now: number): TemplateResult {
    return html`<fsio-file-row
      interactive
      .path=${file.name}
      .meta=${`${sizeOf(file.size)} · ${ago(now - file.at)}`}
      .now=${now}
      title=${`${file.name} — ${sizeOf(file.size)}, flung from ${file.from}. Open it in a tab.`}
      @click=${() => void this.#run({ method: "files.show", params: { id: file.id } })}
    >
      <button
        title="let go of this copy"
        @click=${(e: Event) => {
          e.stopPropagation();
          void this.#run({ method: "files.drop", params: { id: file.id } });
        }}
      >
        ✕
      </button>
    </fsio-file-row>`;
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
