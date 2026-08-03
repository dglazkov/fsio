// Which stain the cabinet is under.
//
// Three states, not a toggle: "system" is a real answer, and a two-way switch
// forces a person who keeps their machine dark to re-pick every time the OS
// flips. Light is still the default — this theme is a light-wood cabinet
// first — so "system" is a thing you opt into rather than the starting point.
//
// It lives in @fsio/ui rather than in either demo for the usual reason: the
// two pages would otherwise write it twice, and the second copy is where the
// drift starts (PROCESS.md rule 6). Both pages slot it into the corner "i",
// which is where a page keeps facts about itself.
import { LitElement, html, css } from "lit";
import type { TemplateResult } from "lit";
import { tokens, icons } from "../tokens.js";
import { getTheme, setTheme, type ThemePref } from "../theme.js";

const CHOICES: Array<{ pref: ThemePref; icon: string; label: string }> = [
  { pref: "light", icon: "light_mode", label: "Light" },
  { pref: "dark", icon: "dark_mode", label: "Dark" },
  { pref: "system", icon: "contrast", label: "System" },
];

class FsioThemeSwitch extends LitElement {
  static override styles = [
    tokens,
    icons,
    css`
      :host { display: flex; align-items: center; gap: 0.35rem; }
      .label { color: var(--fsio-dimmer); font-size: 0.78rem; margin-right: 0.15rem; }
      .set { display: flex; gap: 0.15rem; }
      button {
        display: flex; align-items: center; gap: 0.28rem;
        background: none; border: 1px solid transparent; border-radius: 6px;
        color: var(--fsio-dimmer); font: inherit; font-size: 0.78rem;
        padding: 0.2rem 0.45rem; cursor: pointer;
      }
      button:hover { color: var(--fsio-fg); }
      button:focus-visible { outline: 2px solid var(--fsio-accent); outline-offset: 1px; }
      /* aria-pressed is the state, so it is also the selector — no parallel
         class to keep in step with it. */
      button[aria-pressed="true"] {
        background: var(--fsio-raised); border-color: var(--fsio-line);
        color: var(--fsio-fg-bright);
      }
    `,
  ];

  override render(): TemplateResult {
    const now = getTheme();
    return html`
      <span class="label">theme</span>
      <div class="set" role="group" aria-label="theme">
        ${CHOICES.map(
          (c) => html`<button
            aria-pressed=${c.pref === now}
            title=${c.pref === "system" ? "follow the operating system" : c.label}
            @click=${() => { setTheme(c.pref); this.requestUpdate(); }}
          ><span class="icon sm">${c.icon}</span>${c.label}</button>`
        )}
      </div>
    `;
  }
}

customElements.define("fsio-theme-switch", FsioThemeSwitch);

declare global {
  interface HTMLElementTagNameMap {
    "fsio-theme-switch": FsioThemeSwitch;
  }
}
