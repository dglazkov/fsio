# @fsio/ui

The chrome the demo pages had written. Lit components and the CSS tokens
under them, extracted from `acp-demo`, `terminal-demo` and `actuator-demo`
once two of them had the same thing twice (PROCESS.md rule 6).

Browser-only, and a demo dependency — nothing in `spec/` knows this package
exists, and it carries no numbered entries. What it owes instead is this
file and `src/test-text.ts`.

## The split

**This package owns mechanics. The demos own prose and consequences.**

That line is what let one tab strip serve three pages that mean different
things by a tab. Focus management, roving tabindex, measuring what fits, the
top layer, Escape, click-away, which dot is which shape, when a popover asks
to be refreshed — here. What a chip is called, what closing one costs, what
happens when you do — there, as props and events.

Where the pages disagreed, the disagreement became a prop rather than a
winner. Where they agreed by accident — two shades of the same border — one
won, and it was the agent page's, because a token that means two things means
nothing.

The one place the line moved: a page's **theme switch and page log** are
rendered by `<fsio-details>` rather than slotted into it. All three pages
ended the "i" with those same two sections, at three different qualities —
one pinned the log and offered to copy it, one truncated it to 25 lines, one
put the theme switch up in the header at the weight of the folder you are
working in. Sections that identical are furniture, and furniture is
mechanics. What a person is *looking at* is still prose, still slotted.

## What's in it

| | |
|---|---|
| `<fsio-top-bar>` | the row across the top: the folder's name, a slot for what is open in it, a `status` slot for anything worth one quiet word. |
| `<fsio-tab-strip>` | the chips, the "N more" overflow list, the "+" list, the "⋯" menu, the close confirm. Chips in, `select`/`close`/`action`/`list-open` out; the "+" body is slotted. |
| `<fsio-wizard-frame>` | the setup modal: wordmark, tagline, breadcrumbs, and open/close driven by a phase. Panels are slotted. |
| `<fsio-gate>` | the hard stop for a browser without File System Access, and the one thing it can offer: this page's address, copied. |
| `<fsio-session-row>` | one session, offered: name, where it is, who holds it, what it last said, and a button. |
| `<fsio-file-row>` | one file in a pane: tail-first name, one fact, the change-fade, and a slot for whatever the page lets you do to it. |
| `<fsio-file-tree>` | the flat paths a folder walk reports, as directories that open and close. Rows in, `open` out; the page supplies each row's one fact (`metaFor`) and its controls (`actionsFor`). Owns collapse state, because it is the thing that lays rows out — and therefore the only thing that can re-open a directory when a file inside it changes. |
| `<fsio-details>` | the "i" in the corner and the popover it opens. Page content slotted above (`default`) and below (`foot`); the theme switch and the page log are its own. |
| `<fsio-cmd>` | a command to run in a terminal, and the button that copies it. |
| `createReporter` | the cooperative-verification reporter (TESTING.md), parameterized by page name and by what the page calls the things it holds. |
| `text.ts` | `friendlyName`, `sinceLabel`, `ago`, `sizeOf`. |
| `tokens.ts` | the palette as custom properties, plus the rule sets a demo needs for content it slots into a component here. |
| `Dismiss` | Escape and click-away for a popover, as a reactive controller. |
| `Ticker` | a 2 s re-render, for panes rendering "3 minutes ago" — the text goes stale while the data sits still. |
| `@fsio/ui/boot` | the theme and its two faces, installed before anything can paint. A page imports this first and `@fsio/ui` second; the module comment says why the order is load-bearing. |

## Overflow, and why "N more" is not "+"

The strip measures. Chips that do not fit come out of the row and into a
"N more" list beside it; the active chip is always one of the ones on screen.
It used to scroll, which was honest — nothing was hidden without a way to
reach it — and still meant chips the page held were chips you could not see.

"N more" is a **different control from "+"**, deliberately. "+" means
*everything in this folder, including what this page is not holding*; two of
the three pages want one and the third does not. "N more" means *what this
page IS holding, just not on screen*. Different question, different control,
and the page with no "+" still gets its chips back.

`.tab` is `flex: none` for the measurement's sake, not for looks: a chip that
shrinks to fit changes width when a sibling leaves the row, and measuring,
hiding, and measuring again would never agree with itself.

## Styling across the boundary

A shadow root sees no page CSS, so a component here cannot style content the
demo slots into it. That is why `tokens.ts` exports fragments as well as
variables: `wizardStyles` for a wizard's panels, `listBody` for what goes in
the "+" popover, `diagBody` for what goes in the "i". Put `tokens` first in
any `static styles` that reads a `--fsio-*` variable.

## Not in here

- **The folder-grant lifecycle and the granted-folder walk.** Written three
  times and twice respectively, and neither is chrome — one is the browser
  half of getting a session, the other is a directory reader. Where they go
  is [#160](https://github.com/dglazkov/fsio/issues/160).
- **`fs-access.d.ts`.** Byte-identical in three packages and still copied,
  because it declares globals, and reaching an ambient declaration across a
  package boundary costs more plumbing than the 25 lines it saves. It is a
  shim for types the platform has and TypeScript does not, not UI.
- **The file *panes*.** Two pages have one, and what is left of them after the
  row and the tree came in here is what they never agreed on: their headers,
  their blurbs, and the actuator's second half — the files the page holds,
  which is a list and not a tree, because a copy has a name and not a place.

  The disagreement this bullet used to record — a feed you watch versus a
  picker you click ([#157](https://github.com/dglazkov/fsio/issues/157)) —
  ended when the agent page grew somewhere to click *to*. Both panes open
  files now. What the feed was actually protecting was "the thing that just
  changed is findable", and the tree pays that back as auto-reveal plus the
  glow rather than as an ordering.
- **Anything one page renders once.** The chat log, the permission card, the
  xterm frame. One consumer is not a signal.
