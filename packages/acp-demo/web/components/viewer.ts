// A file, open, where the conversation was.
//
// It takes the conversation's column rather than splitting it, and that is a
// choice about what this page is: the chat is not a sidebar to a file
// browser. You go and look at something, and you come back — the conversation
// is still there, still running, and the chip you came from is one click
// away. Nothing in here can act on the agent; it is a window onto bytes.
//
// The line under the name is the load-bearing sentence, and it is on screen
// every time: this file is on your disk, and the page is reading it live
// through the grant you gave it. Everything else in the demo is about what
// travels; this says what does not.
import { LitElement, html, css, nothing } from "lit";
import type { TemplateResult } from "lit";
import { SignalWatcher } from "@lit-labs/signals";
import { ago, sizeOf, tokens, Ticker } from "@fsio/ui";
import { activeFile, folder, phase } from "../state";
import { basename, contentFor, fileTabFor } from "../files";

class AcpViewer extends SignalWatcher(LitElement) {
  // "read 4s ago" is wall-clock, and it is the proof the window is live: it
  // resets when the agent touches the file, without anybody clicking.
  #ticker = new Ticker(this);

  static override styles = [
    tokens,
    css`
      :host { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
      /* The host's own display beats the UA sheet's [hidden]. */
      :host([hidden]) { display: none !important; }
      header {
        padding: 0.7rem 1.2rem 0.55rem; border-bottom: 1px solid var(--fsio-line);
        display: flex; flex-direction: column; gap: 0.15rem;
      }
      h1 {
        margin: 0; font: 400 1.15rem/1.2 var(--fsio-title); color: var(--fsio-fg-bright);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .origin {
        font-size: 0.72rem; color: var(--fsio-dimmest);
        display: flex; align-items: baseline; gap: 0.4rem; flex-wrap: wrap;
      }
      .origin .mark { color: var(--fsio-cyan); }
      .origin .dir { font-family: var(--fsio-mono); }
      .body { flex: 1; min-height: 0; overflow: auto; padding: 1rem 1.2rem; }
      pre.text {
        margin: 0; font-family: var(--fsio-mono); font-size: 0.8rem; line-height: 1.6;
        white-space: pre-wrap; word-break: break-word; color: var(--fsio-fg);
      }
      img.view {
        max-width: 100%; border-radius: 8px; display: block; background: var(--fsio-aside);
        border: 1px solid var(--fsio-line);
      }
      .note { margin-top: 0.9rem; font-size: 0.74rem; color: var(--fsio-dimmest); }
      .gone { color: var(--fsio-bad-bright); font-size: 0.85rem; line-height: 1.6; max-width: 40rem; }
    `,
  ];

  override render(): TemplateResult | typeof nothing {
    const tab = fileTabFor(activeFile.get());
    // An attribute rather than a bound property: this element sits in the
    // page's light DOM (index.html), so it hides itself the way the workspace
    // pane opens itself.
    this.toggleAttribute("hidden", !tab || phase.get() !== "chat");
    if (!tab) return nothing;
    const loaded = contentFor(tab.path);
    const now = Date.now();
    const dir = tab.path.includes("/") ? `${tab.path.slice(0, tab.path.lastIndexOf("/"))}/` : "";
    return html`
      <header>
        <h1 title=${tab.path}>${basename(tab.path)}</h1>
        <div class="origin">
          <span class="mark">↗</span>
          <span class="dir">${folder.get()?.name ?? "the folder"}/${dir}</span>
          ${loaded && !loaded.missing
            ? html`<span>· ${sizeOf(loaded.size)} · read ${ago(now - loaded.loadedAt)}</span>`
            : nothing}
          <span>— on your disk, read live through your grant</span>
        </div>
      </header>
      <div class="body">${this.#view(tab.path, loaded)}</div>
    `;
  }

  #view(path: string, loaded: ReturnType<typeof contentFor>): TemplateResult {
    if (!loaded) return html`<div class="note">reading…</div>`;
    if (loaded.missing) {
      // The honest end state of a window onto someone else's file, and the
      // one a demo about custody must not paper over.
      return html`<div class="gone">
        This file is not in the folder any more — it was moved, deleted, or the
        grant is gone.<br />
        The page never had a copy: that is what opening a file here means.
      </div>`;
    }
    if (loaded.viewer === "text") {
      return html`<pre class="text">${loaded.text}</pre>
        ${loaded.truncated ? html`<div class="note">showing the head of a ${sizeOf(loaded.size)} file</div>` : nothing}`;
    }
    if (loaded.viewer === "image") {
      return html`<img class="view" src=${loaded.url ?? ""} alt=${path} />`;
    }
    return html`<div class="note">
      No viewer for ${loaded.type || "this file type"} yet — ${sizeOf(loaded.size)} sitting in the folder.
    </div>`;
  }
}

customElements.define("acp-viewer", AcpViewer);
