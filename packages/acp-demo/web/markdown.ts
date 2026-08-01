// The other half of `../src/markdown.ts`: tree → lit templates.
//
// Every piece of agent-authored text below arrives as a child binding
// (`${n.text}`), which lit escapes — there is no `unsafeHTML` here and there
// must never be one. The parser's header says why at length; the short
// version is that this page holds the human's folder handle, so a script
// injected through a chat bubble would be a filesystem capability.
//
// Styling lives in the host component's shadow root (chat.ts) — these are
// plain elements, so one sheet there covers both agent messages and thoughts.
import { html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { parseMarkdown, type Block, type Inline } from "../src/markdown.js";

export function renderMarkdown(src: string): TemplateResult {
  return html`${parseMarkdown(src).map(block)}`;
}

function block(b: Block): TemplateResult {
  switch (b.kind) {
    case "p":
      return html`<p>${b.children.map(inline)}</p>`;
    case "heading":
      // Six cases spelled out rather than an unsafe tag-name interpolation:
      // lit templates are static by design, and that is the property doing
      // the security work here.
      switch (b.level) {
        case 1:
          return html`<h1>${b.children.map(inline)}</h1>`;
        case 2:
          return html`<h2>${b.children.map(inline)}</h2>`;
        case 3:
          return html`<h3>${b.children.map(inline)}</h3>`;
        case 4:
          return html`<h4>${b.children.map(inline)}</h4>`;
        case 5:
          return html`<h5>${b.children.map(inline)}</h5>`;
        default:
          return html`<h6>${b.children.map(inline)}</h6>`;
      }
    case "code":
      // `data-lang` is display only; no highlighting, and an agent-supplied
      // language string is never used to pick code to run.
      return html`<pre class="code" data-lang=${b.lang || nothing}><code>${b.text}</code></pre>`;
    case "list":
      return b.ordered
        ? html`<ol>
            ${b.items.map((it) => html`<li>${it.map(inline)}</li>`)}
          </ol>`
        : html`<ul>
            ${b.items.map((it) => html`<li>${it.map(inline)}</li>`)}
          </ul>`;
    case "quote":
      return html`<blockquote>${b.children.map(inline)}</blockquote>`;
    case "hr":
      return html`<hr />`;
  }
}

function inline(n: Inline): TemplateResult | string {
  switch (n.kind) {
    case "text":
      return n.text;
    case "code":
      return html`<code>${n.text}</code>`;
    case "strong":
      return html`<strong>${n.children.map(inline)}</strong>`;
    case "em":
      return html`<em>${n.children.map(inline)}</em>`;
    case "link":
      // The scheme was allow-listed at parse time (http/https/mailto only).
      // `noopener noreferrer` because the agent chose this destination, not
      // the human: the new tab gets no handle on this one and no referrer.
      return html`<a href=${n.href} target="_blank" rel="noopener noreferrer">${n.children.map(inline)}</a>`;
  }
}
