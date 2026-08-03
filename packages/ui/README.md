# @fsio/ui

The chrome both demo pages had written. Lit components and the CSS tokens
under them, extracted from `acp-demo` and `terminal-demo` once the two had
the same thing twice (PROCESS.md rule 6).

Browser-only, and a demo dependency — nothing in `spec/` knows this package
exists, and it carries no numbered entries. What it owes instead is this
file and `src/test-text.ts`.

## The split

**This package owns mechanics. The demos own prose and consequences.**

That line is what let one tab strip serve two pages that mean different
things by a tab. Focus management, roving tabindex, scrolling the active chip
into view, the top layer, Escape, click-away, which dot is which shape, when
a popover asks to be refreshed — here. What a chip is called, what closing one
costs, what happens when you do — there, as props and events.

Where the two pages disagreed, the disagreement became a prop rather than a
winner. Where they agreed by accident — two shades of the same border — one
won, and it was the agent page's, because a token that means two things means
nothing.

## What's in it

| | |
|---|---|
| `<fsio-tab-strip>` | the chips, the "+" list, the "⋯" menu, the close confirm. Chips in, `select`/`close`/`action`/`list-open` out; the list body is slotted. |
| `<fsio-wizard-frame>` | the setup modal: wordmark, tagline, breadcrumbs, and open/close driven by a phase. Panels are slotted. |
| `<fsio-session-row>` | one session, offered: name, where it is, who holds it, what it last said, and a button. |
| `<fsio-details>` | the "i" in the corner and the popover it opens. All content slotted. |
| `<fsio-cmd>` | a command to run in a terminal, and the button that copies it. |
| `createReporter` | the cooperative-verification reporter (TESTING.md), parameterized by page name and by what the page calls the things it holds. |
| `text.ts` | `friendlyName`, `sinceLabel`, `ago`, `sizeOf`. |
| `tokens.ts` | the palette as custom properties, plus the rule sets a demo needs for content it slots into a component here. |
| `Dismiss` | Escape and click-away for a popover, as a reactive controller. |

## Styling across the boundary

A shadow root sees no page CSS, so a component here cannot style content the
demo slots into it. That is why `tokens.ts` exports fragments as well as
variables: `wizardStyles` for a wizard's panels, `listBody` for what goes in
the "+" popover, `diagBody` for what goes in the "i". Put `tokens` first in
any `static styles` that reads a `--fsio-*` variable.

## Not in here

- **`fs-access.d.ts`.** Byte-identical in three packages and still copied,
  because it declares globals, and reaching an ambient declaration across a
  package boundary costs more plumbing than the 25 lines it saves. It is a
  shim for types the platform has and TypeScript does not, not UI.
- **Anything either page renders once.** The chat log, the permission card,
  the workspace pane, the xterm frame. One consumer is not a signal.
