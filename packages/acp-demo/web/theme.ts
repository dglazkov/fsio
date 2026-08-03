// "Pewter Curio" preview — a dev-only page for judging the theme before it is
// swept across the two demos.
//
// It is here in acp-demo/web/ so the running vite (:8767) serves it with no
// second dev loop, and vite's build only ever inputs `index.html`, so it does
// not ship. Reach it at http://localhost:8767/theme.html
//
// The rule that makes it worth looking at: **the preview invents no values.**
// The components are the real ones, the rule sets are adopted straight out of
// `@fsio/ui`, and every colour in theme.html's own stylesheet is a
// `var(--fsio-*)`. A preview with its own palette would agree with itself and
// nothing else.
import "@fontsource/instrument-serif";
import "@fontsource/jetbrains-mono";
import {
  ICON_NAMES,
  controls,
  glass,
  icons,
  installPageTheme,
  getTheme,
  prose,
  setTheme,
  statusLines,
} from "@fsio/ui";
import "@fsio/ui";
import type { ThemePref } from "@fsio/ui";

installPageTheme();

// The real rule sets, at document scope. These are written for shadow roots
// (bare `button`, `.status`), which is exactly what this page wants — it IS
// the flat case.
document.adoptedStyleSheets = [
  ...document.adoptedStyleSheets,
  ...[controls, prose, statusLines, glass, icons].map((c) => c.styleSheet!),
];

/** The stain switch. Three states because "system" is a real answer — the
 *  default is light, but a person who keeps their machine dark should be able
 *  to say so once. */
function wireSwitch(): void {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-theme-set]")];
  const paint = (): void => {
    const now = getTheme();
    for (const b of buttons) {
      b.setAttribute("aria-pressed", String(b.dataset["themeSet"] === now));
    }
  };
  for (const b of buttons) {
    b.addEventListener("click", () => {
      setTheme(b.dataset["themeSet"] as ThemePref);
      paint();
    });
  }
  paint();
}

/** Every token that names a colour, read back off the page rather than
 *  hardcoded — so a swatch cannot disagree with the table it came from, and
 *  so a token added to tokens.ts shows up here without touching this file. */
const SWATCHES: Array<[group: string, names: string[]]> = [
  ["surfaces", ["--fsio-wood", "--fsio-bg", "--fsio-raised", "--fsio-aside", "--fsio-panel", "--fsio-control", "--fsio-control-hover", "--fsio-slab"]],
  ["lines", ["--fsio-line", "--fsio-line-strong", "--fsio-line-control"]],
  ["text", ["--fsio-fg-bright", "--fsio-fg", "--fsio-dim", "--fsio-dimmer", "--fsio-dimmest"]],
  ["meaning", ["--fsio-accent", "--fsio-accent-hover", "--fsio-cyan", "--fsio-good", "--fsio-warn", "--fsio-warn-quiet", "--fsio-bad", "--fsio-bad-bright", "--fsio-bad-wash"]],
];

function paintSwatches(): void {
  const host = document.getElementById("swatches")!;
  host.replaceChildren();
  for (const [group, names] of SWATCHES) {
    const h = document.createElement("div");
    h.style.cssText =
      "grid-column:1/-1;font-family:var(--fsio-mono);font-size:0.7rem;color:var(--fsio-dimmest);" +
      "text-transform:uppercase;letter-spacing:0.08em;margin-top:0.5rem";
    h.textContent = group;
    host.append(h);
    for (const name of names) {
      const sw = document.createElement("div");
      const isLine = group === "lines";
      sw.className = `sw${isLine ? " line" : ""}`;
      const chip = document.createElement("div");
      chip.className = "chip";
      // A line token is an alpha hairline: filling a box with it shows almost
      // nothing, so lines get drawn AS a line, over the recessed surface.
      if (isLine) chip.style.borderTopColor = `var(${name})`;
      else chip.style.background = `var(${name})`;
      const label = document.createElement("div");
      label.className = "label";
      label.textContent = name.replace("--fsio-", "");
      sw.append(chip, label);
      host.append(sw);
    }
  }
}

/** The glyph vocabulary, read from the same list that builds the subset URL —
 *  so the shelf cannot show an icon the font was never asked for, which is a
 *  failure that renders as the word "close" rather than as an error. */
const ICONS = ICON_NAMES;

function paintIcons(): void {
  const shelf = document.getElementById("shelf")!;
  shelf.replaceChildren();
  for (const name of ICONS) {
    const cell = document.createElement("div");
    cell.className = "cell";
    const i = document.createElement("span");
    i.className = "icon";
    i.textContent = name;
    const n = document.createElement("div");
    n.className = "n";
    n.textContent = name;
    cell.append(i, n);
    shelf.append(cell);
  }
}

/** The real tab strip, with one chip in each dot state so the whole
 *  vocabulary is visible at once. */
function paintStrip(): void {
  const strip = document.getElementById("strip") as HTMLElementTagNameMap["fsio-tab-strip"];
  strip.chips = [
    { id: "a", name: "rename pass", secondary: "claude", dot: "busy", title: "working" },
    { id: "b", name: "test triage", dot: "unread", badge: 2 },
    { id: "c", name: "docs sweep", dot: "fenced", dotTitle: "another window drives this one" },
    { id: "d", name: "spike", dot: "bad" },
    { id: "e", name: "yesterday's thread", dot: "doc", quiet: true },
  ];
  strip.activeId = "a";
  strip.confirmFor = (c) => ({
    question: `End "${c.name}"?`,
    note: "The agent is a child process and a model bill. Detaching leaves it running for the next visit.",
    confirm: "End it",
  });
  strip.menuFor = () => [
    { id: "detach", name: "Detach", note: "leave it running, stop watching", button: "Detach" },
    { id: "end", name: "End conversation", note: "stops the agent for good", button: "End…", danger: true },
  ];
  strip.addEventListener("select", (e) => {
    strip.activeId = (e as CustomEvent<{ id: string }>).detail.id;
    strip.requestUpdate();
  });
}

function paintRows(): void {
  const one = document.getElementById("row1") as HTMLElementTagNameMap["fsio-session-row"];
  one.name = "rename pass";
  one.note = "claude 2.1";
  one.meta = "~/myproject · held by this window · 4 min ago";
  one.quote = "Found 14 occurrences across 6 files. Two of them are in strings, so I'll leave those.";
  one.action = "Open";
  one.primary = true;

  const two = document.getElementById("row2") as HTMLElementTagNameMap["fsio-session-row"];
  two.name = "test triage";
  two.meta = "~/myproject · another window · 2 h ago";
  two.quote = "The lane re-probe assumes machine speed; a loaded runner parks it.";
  two.flag = "Blocked on a question nobody answered.";
  two.action = "Take over";
}

wireSwitch();
paintSwatches();
paintIcons();
paintStrip();
paintRows();
