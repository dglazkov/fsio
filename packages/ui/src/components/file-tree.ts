// The folder, as a folder: directories that open and close, files inside
// them, and a click that means "show me this one".
//
// Both panes had a flat list of slash-separated paths sorted by mtime — a
// feed, which is what you want while an agent is editing things in front of
// you and nothing else. What it is bad at is the other question a pane gets
// asked ("what is in here?"), because a path is not a place: `web/state.ts`
// and `src/state.ts` sit next to each other under an ordering neither of them
// chose, and nothing on screen says the folder has any shape at all.
//
// So: hierarchy, with the feed's one irreplaceable trick kept intact. A file
// that changes while you are watching still lights up (`fsio-file-row`'s
// glow), and the directories above it open themselves so you can see it do
// that — see `#reveal`. That is what a fixed-position row can offer instead
// of jumping to the top, and it is why collapse state lives here rather than
// in either page: a pane cannot auto-reveal something it does not lay out.
//
// Directories are inferred from the paths of files, because that is what the
// panes' walks report. An empty directory therefore does not appear — a real
// explorer would show it, and nothing here would know it was there.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { tokens, icons } from "../tokens.js";
import { GLOW_MS } from "./file-row.js";
import "./file-row.js";

/** One file, as a pane's directory walk reports it. The shape both panes
 *  already had (`FileRow` in either page's state.ts). */
export interface TreeRow {
  /** folder-relative, slash-separated. */
  path: string;
  size: number;
  modified: number;
  /** when the pane last saw it change, or 0 for never — the glow reads it. */
  seenChanged: number;
}

/** One rung of indentation. Small enough that six levels still leave room for
 *  a name, large enough to see. */
const STEP = 0.8;

interface Node {
  name: string;
  path: string;
  dirs: Map<string, Node>;
  files: TreeRow[];
}

const node = (name: string, path: string): Node => ({ name, path, dirs: new Map(), files: [] });

class FsioFileTree extends LitElement {
  static override properties = {
    rows: { attribute: false },
    now: { type: Number },
    open: { attribute: false },
    actionsFor: { attribute: false },
    metaFor: { attribute: false },
    label: {},
  };

  /** Every file the pane can see, in any order — this sorts its own. */
  rows: TreeRow[] = [];
  /** What time the owner of the clock thinks it is, passed in for the same
   *  reason the row takes it: one interval per pane, not one per row. */
  now = 0;
  /** Paths that already have a tab open on them, drawn as current. */
  open: string[] = [];
  /** Per-row controls the page slots into the row (the actuator's "⤓"). The
   *  tree owns the layout and the page owns the verbs — the same split the
   *  tab strip makes. */
  actionsFor: ((row: TreeRow) => unknown) | null = null;
  /** The one fact on the right of a row. Defaults to nothing, because the two
   *  panes disagree about which fact matters. */
  metaFor: ((row: TreeRow) => string) | null = null;
  label = "files in this folder";

  /** Directories the human closed. Explicit-only: a directory nobody has
   *  touched is open, so a fresh pane shows the whole shape of the folder
   *  rather than a row of things to click. */
  #collapsed = new Set<string>();
  /** Changes already revealed, by path — the value is the `seenChanged` that
   *  was acted on. What makes revealing an event rather than a condition; see
   *  `#reveal`. */
  #revealed = new Map<string, number>();

  static override styles = [
    tokens,
    icons,
    css`
      :host { display: block; }
      /* The disclosure row. A button, so it is reachable and pressable
         without this file re-implementing either. */
      .dir {
        display: flex; align-items: center; gap: 0.25rem; width: 100%;
        background: none; border: none; cursor: pointer;
        padding: 0.2rem 0.5rem 0.2rem var(--indent);
        font: inherit; font-size: 0.8rem; font-family: var(--fsio-mono);
        color: var(--fsio-dimmer); text-align: left;
      }
      .dir:hover { color: var(--fsio-fg-bright); background: var(--fsio-panel); }
      .dir:focus-visible { outline: 2px solid var(--fsio-accent); outline-offset: -2px; }
      .dir .icon {
        font-size: 1rem; flex: none; color: var(--fsio-dimmest);
        transition: transform 120ms ease-out;
      }
      .dir[aria-expanded="true"] .icon { transform: rotate(90deg); }
      @media (prefers-reduced-motion: reduce) { .dir .icon { transition: none; } }
      .dir .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      /* A closed directory says how much is inside it, because that is the
         thing you just took off the screen. Pushed to the right edge, into the
         column the file rows put their own one fact in — beside the name it
         reads as part of it ("ui 1 file"). */
      .dir .count {
        color: var(--fsio-dimmest); font-size: 0.72rem; flex: none;
        margin-left: auto; padding-left: 0.5rem;
      }
      /* Something in there changed while it was closed. The row cannot glow —
         it is not the file — so the folder wears the accent until you look. */
      .dir.hot .name { color: var(--fsio-fg-bright); }
      .dir.hot .count { color: var(--fsio-cyan); }
      /* The page's own per-row controls (actionsFor). They are styled here
         because they live in THIS shadow root — a page that hands them over
         cannot reach them with its own sheet, and every pane that has one
         wants the same quiet square that appears on hover. When they show is
         the row's business (fsio-file-row's ::slotted rules). */
      fsio-file-row button {
        border: 1px solid transparent; background: none; border-radius: 6px;
        color: var(--fsio-dimmest); font: inherit; font-size: 0.72rem; line-height: 1;
        padding: 0.15rem 0.3rem; cursor: pointer;
      }
      fsio-file-row button:hover { color: var(--fsio-fg-bright); border-color: var(--fsio-line-strong); }
      fsio-file-row button:focus-visible { outline: 2px solid var(--fsio-accent); outline-offset: 1px; }
    `,
  ];

  override render(): TemplateResult {
    this.#reveal();
    const root = node("", "");
    for (const row of this.rows) place(root, row);
    return html`<div role="tree" aria-label=${this.label}>${this.#children(root, 0)}</div>`;
  }

  /** Open whatever a just-changed file is buried under.
   *
   *  This is the half of the feed worth keeping: you looked away, the agent
   *  edited something three directories down, and the row is lit — inside a
   *  directory you closed an hour ago, where nobody would see it. Revealing is
   *  one-way: the glow expires and the directory stays open, so the file you
   *  were shown is still where you were shown it.
   *
   *  Once per change, and that is not a detail. Written as a condition —
   *  "anything lit is revealed" — it re-opens the directory on every render for
   *  as long as the glow lasts, so a folder an agent is writing into cannot be
   *  closed at all: you click, it springs open, and the pane appears broken.
   *  So the *arrival* of a new `seenChanged` is what reveals, and a collapse
   *  made afterwards holds until the next change. Observed on the preview
   *  page, where `now` is frozen and the folder was uncollapsible outright. */
  #reveal(): void {
    const hot = new Map<string, number>();
    for (const r of this.rows) {
      if (!r.seenChanged || this.now - r.seenChanged >= GLOW_MS) continue;
      hot.set(r.path, r.seenChanged);
      if (this.#revealed.get(r.path) === r.seenChanged) continue;
      const parts = r.path.split("/");
      parts.pop();
      let at = "";
      for (const p of parts) {
        at = at ? `${at}/${p}` : p;
        this.#collapsed.delete(at);
      }
    }
    // Only what is still lit is remembered: a change nobody can see any more
    // cannot reveal anything, so its entry has nothing left to suppress.
    this.#revealed = hot;
  }

  /** Directories first, then files, each alphabetical — a file explorer's
   *  order, and the reason this is not the pane it replaced. Sorting by time
   *  here would put a directory's rows in an order that changes under the
   *  pointer, which is exactly what a tree is for not doing. */
  #children(dir: Node, depth: number): TemplateResult[] {
    const out: TemplateResult[] = [];
    for (const child of [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(this.#dir(child, depth));
    }
    for (const file of [...dir.files].sort((a, b) => a.path.localeCompare(b.path))) {
      out.push(this.#file(file, depth));
    }
    return out;
  }

  #dir(dir: Node, depth: number): TemplateResult {
    const shut = this.#collapsed.has(dir.path);
    const hot = shut && this.#hotInside(dir);
    return html`
      <button
        class="dir ${hot ? "hot" : ""}"
        role="treeitem"
        aria-expanded=${!shut}
        style=${`--indent: ${0.5 + depth * STEP}rem`}
        title=${`${dir.path}/`}
        @click=${() => this.#toggle(dir.path)}
      >
        <span class="icon">chevron_right</span>
        <span class="name">${dir.name}</span>
        ${shut ? html`<span class="count">${count(dir)}</span>` : nothing}
      </button>
      ${shut ? nothing : html`<div role="group">${this.#children(dir, depth + 1)}</div>`}
    `;
  }

  /** A file, as the shared row — same glow, same truncation, same keyboard,
   *  indented to where it sits. The name only: the directories above it are on
   *  screen now, so repeating them in every row is the flat list's tax and not
   *  something a tree has to pay. */
  #file(row: TreeRow, depth: number): TemplateResult {
    const name = row.path.split("/").pop() ?? row.path;
    return html`<fsio-file-row
      role="treeitem"
      interactive
      ?current=${this.open.includes(row.path)}
      style=${`--fsio-row-indent: ${0.55 + depth * STEP}rem`}
      .path=${name}
      .meta=${this.metaFor?.(row) ?? ""}
      .hotSince=${row.seenChanged}
      .now=${this.now}
      title=${row.path}
      @click=${() => this.dispatchEvent(new CustomEvent("open", { detail: { path: row.path }, bubbles: true, composed: true }))}
      >${this.actionsFor?.(row) ?? nothing}</fsio-file-row
    >`;
  }

  #hotInside(dir: Node): boolean {
    for (const f of dir.files) if (f.seenChanged && this.now - f.seenChanged < GLOW_MS) return true;
    for (const d of dir.dirs.values()) if (this.#hotInside(d)) return true;
    return false;
  }

  #toggle(path: string): void {
    if (this.#collapsed.has(path)) this.#collapsed.delete(path);
    else this.#collapsed.add(path);
    this.requestUpdate();
  }
}

function place(root: Node, row: TreeRow): void {
  const parts = row.path.split("/");
  const name = parts.pop();
  if (!name) return;
  let at = root;
  let path = "";
  for (const part of parts) {
    path = path ? `${path}/${part}` : part;
    let next = at.dirs.get(part);
    if (!next) {
      next = node(part, path);
      at.dirs.set(part, next);
    }
    at = next;
  }
  at.files.push(row);
}

/** How many files are under here, at any depth — what closing this row took
 *  off the screen. */
function inside(dir: Node): number {
  let n = dir.files.length;
  for (const d of dir.dirs.values()) n += inside(d);
  return n;
}

function count(dir: Node): string {
  const n = inside(dir);
  return `${n} file${n === 1 ? "" : "s"}`;
}

customElements.define("fsio-file-tree", FsioFileTree);

declare global {
  interface HTMLElementTagNameMap {
    "fsio-file-tree": FsioFileTree;
  }
}
