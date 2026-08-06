// What a file tab looks like.
//
// The one screen in the shell that is not an extension, and the reason it is
// here rather than in the folder: `pewt open` and `pewt fling` hand the *page*
// the bytes — they arrive through the grant this page holds, and an extension
// runs in a frame with an origin of its own and no grant at all. Sending them
// on to one would mean inventing a bytes-over-the-bridge surface for a viewer
// nobody asked for.
//
// It renders a `Loaded` (state.ts) and nothing else. Where those bytes came
// from — a window on the folder, or a copy in this browser's storage — is
// deliberately invisible here: "a copy and a window look the same until the
// folder goes away" is the claim the two commands exist to make, and a viewer
// that could tell them apart would be evidence against it. What is *not*
// invisible is the footer line, which says which one you are looking at,
// because that is a thing to know rather than a thing the bytes reveal.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { tokens } from "@fsio/ui";
import { sizeText, type Tab } from "pewter";
import { contentFor } from "../files";
import { tabs } from "../state";

class FileView extends SignalWatcher(LitElement) {
  static override properties = { tabId: { type: String } };
  /** which tab this pane belongs to. The body is looked up rather than passed
   *  because it moves: flinging the same path again supersedes the copy under
   *  an open tab, and an element holding the old reference would keep showing
   *  bytes the page no longer has. */
  tabId = "";

  static override styles = [
    tokens,
    css`
      :host { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--fsio-bg); color: var(--fsio-fg); font-family: var(--fsio-mono); }
      .body { flex: 1; min-height: 0; overflow: auto; }
      pre { margin: 0; padding: 1rem 1.1rem; font: inherit; font-size: 0.8rem; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
      .image { min-height: 100%; display: grid; place-items: center; padding: 1rem; }
      img { max-width: 100%; max-height: 100%; }
      /* min-height, not just place-items: the note is one paragraph in a box
         the size of a tab, so without it the text sits against the top of an
         otherwise empty screen. */
      .note { min-height: 100%; padding: 2rem 1.5rem; display: grid; place-items: center; text-align: center; }
      .note p { max-width: 30rem; line-height: 1.7; font-size: 0.85rem; color: var(--fsio-dim); }
      .note strong { display: block; font-size: 1rem; color: var(--fsio-fg-bright); margin-bottom: 0.5rem; font-weight: 400; }
      footer { flex: none; display: flex; gap: 1rem; flex-wrap: wrap; padding: 0.3rem 0.9rem; border-top: 1px solid var(--fsio-line); background: var(--fsio-panel); font-size: 0.72rem; color: var(--fsio-dimmest); }
      footer .gone { color: var(--fsio-bad-bright); }
    `,
  ];

  override render(): TemplateResult {
    const tab = tabs.get().tabs.find((t) => t.id === this.tabId);
    if (!tab || tab.body.kind === "extension") return html`<div class="note"><p>this tab is not showing a file</p></div>`;
    const loaded = contentFor(tab.body);
    const window = tab.body.kind === "file";
    if (!loaded) return html`<div class="note"><p>reading…</p></div>`;
    return html`
      <div class="body">${this.#view(loaded, window, tab)}</div>
      <footer>
        <span>${window ? `window on ${tab.body.kind === "file" ? tab.body.path : ""}` : "a copy this page holds"}</span>
        ${loaded.missing ? nothing : html`<span>${sizeText(loaded.size)}</span><span>${loaded.type || "unknown type"}</span>`}
        ${loaded.truncated ? html`<span>showing the head of it</span>` : nothing}
        ${loaded.missing ? html`<span class="gone">gone</span>` : nothing}
      </footer>
    `;
  }

  #view(loaded: ReturnType<typeof contentFor> & object, window: boolean, tab: Tab): TemplateResult {
    if (loaded.missing) {
      // The two ways bytes go absent, and they are different things to do
      // about — which is the whole reason both commands exist.
      return html`<div class="note">
        <p>
          <strong>${window ? "this file is gone" : "these bytes are gone"}</strong>
          ${window
            ? html`A window follows the file it was opened on, and there is nothing at
                <code>${tab.body.kind === "file" ? tab.body.path : ""}</code> now. Put it back and this tab fills in
                again — or take a copy next time: <code>pewt fling &lt;path&gt;</code> keeps working when the file
                does not.`
            : html`This page has a copy in its catalog and not the bytes behind it, which should not happen.
                <code>pewt files drop</code> clears the entry.`}
        </p>
      </div>`;
    }
    if (loaded.viewer === "text") return html`<pre>${loaded.text}</pre>`;
    if (loaded.viewer === "image") return html`<div class="image"><img src=${loaded.url ?? ""} alt="" /></div>`;
    return html`<div class="note">
      <p><strong>nothing here can show this</strong>The shell reads text and images. ${loaded.type || "This type"} is neither — an extension is where a third viewer goes.</p>
    </div>`;
  }
}

customElements.define("pewter-file-view", FileView);
