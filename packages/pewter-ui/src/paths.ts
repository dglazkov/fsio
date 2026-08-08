// The files a thing is about, offered as somewhere to go.
//
// Shared by `<pewter-ask>` and `<pewter-step>` rather than being a third
// element, because it is a row of buttons and not a thing with state. If a
// screen ever wants it on its own, that is the moment it becomes an element
// — two users of one template is the signal for extracting it here, and a
// third would be the signal for exporting it.
//
// **Why a callback and not an anchor.** A path is not a URL and this package
// cannot resolve one: `pewter-ui` does not import `pewter` and must not — an
// element that called `pewt.open()` would make the look depend on the API.
// So the element reports the click and the screen decides. In a pewter that
// is `pewt.open(path)` and a real tab, which is the thing a page can do that
// an agent's prompt inside a pty cannot.
//
// A path with nowhere to go renders as text rather than as a dead button.
// The difference between "you can look at this" and "this is what it
// touched" is worth keeping visible.
import { css, html, nothing } from "lit";
import type { TemplateResult } from "lit";

/** The row, or nothing when there are no paths. */
export function paths(list: string[], onpath: ((path: string) => void) | null): TemplateResult | typeof nothing {
  if (!list.length) return nothing;
  return html`<div class="paths" part="paths">
    ${list.map((p) =>
      onpath
        ? html`<button class="path" part="path" title=${`open ${p}`} @click=${() => onpath(p)}>${short(p)}</button>`
        : html`<span class="path" part="path" title=${p}>${short(p)}</span>`
    )}
  </div>`;
}

/** What a path reads as in a row that is not very wide.
 *
 *  An agent names files absolutely, and the interesting half of
 *  `/Users/you/pewters/dev/repos/site/src/main.ts` is the end of it. The
 *  whole path stays in the `title`, so hovering answers "which one" when two
 *  files share a name. */
function short(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 2 ? p : parts.slice(-2).join("/");
}

export const pathStyles = css`
  .paths {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin: 0.25rem 0;
  }
  .path {
    font-family: var(--_mono);
    font-size: 0.75rem;
    padding: 0.1rem 0.4rem;
    border-radius: 5px;
    background: var(--_wash);
    color: inherit;
    opacity: 0.85;
  }
  button.path {
    border: 1px solid transparent;
  }
  button.path:hover {
    border-color: var(--_line);
    opacity: 1;
  }
`;
