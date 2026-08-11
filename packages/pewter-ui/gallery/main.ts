// The kit, in every state, on one page.
//
// **The gap this closes.** Four things shipped in a row whose commit messages
// all ended "nobody has looked at it". Each needed a host, a browser, a
// granted folder, an ACP adapter and a conversation that happened to ask for
// permission — so the only way to see a card was to go and have one. That is
// not a loop anybody runs twice.
//
// So: every element, every state it has, no host and no folder. `npm run kit`
// and look. Editing an element reloads the page, which makes styling a
// second-long loop instead of a session-long one.
//
// **What it deliberately is not.** Not a test — nothing here asserts, and
// nothing fails. `bridge-probe` is what fails, and it drives these same
// elements inside a real sandboxed iframe. This is the other half: the half
// that answers "does it read right", which no assertion answers and which
// somebody has to look at. Keeping them apart means neither pretends to be
// the other.
//
// **It imports the source, not the build.** That is what makes the reload
// loop worth having, and it is also an honest difference from a pewter,
// where an extension gets `dist/` through a bundle. Anything that depends on
// the bundling — the sandbox, the stylesheet inlining — belongs in the probe
// or the rig, not here.
import "../src/index.js";
// The sheet is imported rather than linked from the HTML, for two reasons.
// A `<link href="../style.css">` normalizes to `/style.css` in the browser,
// which is not under vite's root, so it silently 404s and the page renders
// in Times — which is what it was doing, unnoticed, until the palette landed
// and the miss became obvious. And this is how an extension takes it
// (`import "pewter-ui/style.css"`), so the gallery is doing the same thing a
// screen does rather than something adjacent to it.
import "../style.css";
import type { PewterAskChoice } from "../src/ask.js";

const app = document.getElementById("app")!;

/** Everything that happened, newest first. The elements report through
 *  callbacks rather than events, so a page that did not show them would make
 *  half of each element unverifiable by eye. */
const log: string[] = [];
const logEl = document.createElement("pre");
logEl.className = "log";
const note = (what: string): void => {
  log.unshift(`${new Date().toISOString().slice(11, 19)}  ${what}`);
  logEl.textContent = log.slice(0, 12).join("\n");
};
note("nothing yet — click something");

/** One labelled specimen. The label says what state this is, because a wall
 *  of cards with no captions is a picture rather than a reference. */
function specimen(what: string, el: Element | string): HTMLElement {
  const box = document.createElement("section");
  box.className = "specimen";
  const cap = document.createElement("p");
  cap.className = "cap";
  cap.textContent = what;
  box.append(cap);
  if (typeof el === "string") {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = el;
    box.append(p);
  } else {
    box.append(el);
  }
  return box;
}

function group(title: string, blurb: string, ...items: HTMLElement[]): HTMLElement {
  const sec = document.createElement("section");
  sec.className = "group";
  const h = document.createElement("h2");
  h.textContent = title;
  const p = document.createElement("p");
  p.className = "blurb";
  p.textContent = blurb;
  sec.append(h, p, ...items);
  return sec;
}

// ---- <pewter-status>

const statusQuiet = document.createElement("pewter-status");
statusQuiet.hidden = true;

const statusSaid = document.createElement("pewter-status");
statusSaid.say("waiting — the host asks on its own terminal before it starts a shell");

const statusOffer = document.createElement("pewter-status");
statusOffer.say("the agent exited (1)");
statusOffer.offer("new conversation", () => note("status: acted"));

// ---- <pewter-menu>

const menuPlaces = document.createElement("pewter-menu");
menuPlaces.choices = [
  { value: null, label: "this pewter" },
  { value: "fsio", label: "fsio" },
  { value: "site", label: "site — not a git repository" },
];
menuPlaces.onpick = (v) => note(`menu: picked ${JSON.stringify(v)}`);

const menuHints = document.createElement("pewter-menu");
menuHints.hints = ["npm i @agentclientprotocol/claude-agent-acp — asks before it edits", "npm i pi-acp — edits with its own hands"];

// ---- <pewter-markdown>

const mdRich = document.createElement("pewter-markdown");
mdRich.text = [
  "## What I changed",
  "",
  "Edited `src/main.ts` and left a note in the **header**. Two things worth",
  "knowing:",
  "",
  "- the parser keeps a soft line break,",
  "- and a list is flat, because agents write flat lists.",
  "",
  "> A quote, for the shape of it.",
  "",
  "See [the issue](https://example.test/210) — and [this one](javascript:alert(1))",
  "is deliberately not a link.",
  "",
  "```ts",
  'const where = (abs: string) => abs.replace(cwd, "");',
  "```",
  "",
  "---",
].join("\n");

const mdStreaming = document.createElement("pewter-markdown");
mdStreaming.text = ["Working on it. Here is what I have so far:", "", "```ts", "function half(", ""].join("\n");

/** A long block, twice: as it comes, and capped the way a screen would cap
 *  it. The element does not cap by default — prose in a document should not
 *  be truncated by its renderer — so a transcript that wants a ceiling asks
 *  for one through the part. Written as two specimens because the caption
 *  under the first used to claim a scroll that was not there, which is the
 *  first thing looking at this page caught. */
const longCode = ["```", ...Array.from({ length: 30 }, (_, i) => `line ${i + 1} — a long one, and long enough sideways to prove a code block scrolls rather than widening the page`), "```"].join("\n");

const mdLong = document.createElement("pewter-markdown");
mdLong.text = longCode;

const mdCapped = document.createElement("pewter-markdown");
mdCapped.text = longCode;
mdCapped.classList.add("capped");

// ---- <pewter-ask>

const ACP_LIKE: PewterAskChoice[] = [
  { value: "allow_once", label: "allow once", intent: "affirm" },
  { value: "allow_always", label: "always allow", intent: "affirm" },
  { value: "reject_once", label: "reject", intent: "deny" },
];

function askCard(opts: { question: string; who?: string; choices?: PewterAskChoice[]; paths?: string[]; answered?: string; dismissable?: boolean; body?: Element }) {
  const ask = document.createElement("pewter-ask");
  ask.question = opts.question;
  if (opts.who) ask.who = opts.who;
  ask.choices = opts.choices ?? [];
  ask.paths = opts.paths ?? [];
  if (opts.answered) ask.answered = opts.answered;
  ask.dismissable = opts.dismissable ?? false;
  ask.onpath = (p) => note(`ask: open ${p}`);
  ask.onpick = (v) => {
    note(`ask: answered ${v ?? "(dismissed)"}`);
    ask.answered = v ?? "";
    if (!v) ask.answeredLabel = "declined";
    // Past tense once it is answered. Looking at the page is what caught
    // this: a card reading "the agent is asking" under an answer it already
    // has is the page saying something untrue.
    if (opts.who) ask.who = opts.who.replace("is asking", "asked");
  };
  if (opts.body) ask.append(opts.body);
  return ask;
}

const diff = document.createElement("pre");
diff.textContent = ["@@ -1,4 +1,6 @@", "-const a = 1;", "+const a = 2;", "+// and a note", " export { a };"].join("\n");

const askProse = document.createElement("pewter-markdown");
askProse.text = "This will **overwrite** the file. The previous contents are in git.";

// ---- <pewter-step>

function step(label: string, state: "waiting" | "running" | "done" | "failed", paths: string[] = [], detail = "") {
  const el = document.createElement("pewter-step");
  el.label = label;
  el.state = state;
  el.paths = paths;
  el.onpath = (p) => note(`step: open ${p}`);
  if (detail) {
    const pre = document.createElement("pre");
    pre.textContent = detail;
    el.append(pre);
  }
  return el;
}

// ---- the page

app.append(
  group(
    "pewter-status",
    "One quiet line above a screen: what just happened, and at most one thing to do about it.",
    specimen("hidden — the ordinary state", "nothing renders; the strip must not stand as an empty box (#205)"),
    specimen("saying something", statusSaid),
    specimen("saying something, with one thing to do", statusOffer)
  ),
  group(
    "pewter-menu",
    "A list you pick from. Its sibling is pewter-ask, which is a question you answer.",
    specimen("choices", menuPlaces),
    specimen("hints — nothing to pick yet", menuHints)
  ),
  group(
    "pewter-markdown",
    "What an agent said, rendered as what it meant. Agent text becomes a token tree and never an HTML string.",
    specimen("the blocks agents actually emit — note the javascript: link is text, not a link", mdRich),
    specimen("mid-stream: a fence that has not closed yet is already code", mdStreaming),
    specimen("a long block: full height by default, and scrolling sideways rather than widening the page", mdLong),
    specimen("the same block, capped by the screen with pewter-markdown.capped::part(code) { max-height: 8rem }", mdCapped)
  ),
  group(
    "pewter-ask",
    "A question somebody has to answer. Choices carry an intent — what the answer means — and the element decides the weight.",
    specimen("an agent asking, with the file it is about", askCard({ question: "Write to src/main.ts?", who: "the agent is asking · edit", choices: ACP_LIKE, paths: ["/Users/you/pewters/dev/repos/site/src/main.ts"] })),
    specimen("with a diff slotted in", askCard({ question: "Apply this edit?", who: "the agent is asking · edit", choices: ACP_LIKE, paths: ["/abs/repos/site/a.ts", "/abs/repos/site/b.ts"], body: diff })),
    specimen("with prose slotted in", askCard({ question: "Overwrite notes.md?", who: "the agent is asking · write", choices: ACP_LIKE, body: askProse })),
    specimen("already answered — the card stays as the record, in the past tense", askCard({ question: "Run npm install?", who: "the agent asked", choices: ACP_LIKE, answered: "allow_once" })),
    specimen("no options — declining is the only honest answer", askCard({ question: "The agent asked something this build does not understand.", dismissable: true })),
    specimen("a screen's own confirm — nothing here is about agents", askCard({ question: "Delete the project 'site'?", choices: [{ value: "y", label: "delete", intent: "deny" }, { value: "n", label: "keep", intent: "affirm" }] }))
  ),
  group(
    "pewter-step",
    "One thing being done and how it is going. An agent's tool call, a build step, a reading.",
    specimen("waiting", step("read src/main.ts", "waiting", ["/abs/repos/site/src/main.ts"])),
    specimen("running", step("search for 'pewterPath'", "running")),
    specimen("done, with the files it touched", step("edit two files", "done", ["/abs/repos/site/src/main.ts", "/abs/repos/site/src/util.ts"])),
    specimen("failed, with its output — a failure keeps an edge, to be findable in a long transcript", step("run tests", "failed", [], "FAIL src/main.test.ts\n  ✕ it works (3 ms)\n\n  Expected: 1\n  Received: 2"))
  )
);

// ---- the frame around it

const bar = document.createElement("header");
bar.className = "bar";
const title = document.createElement("strong");
title.textContent = "pewter-ui";
const blurb = document.createElement("span");
blurb.className = "muted";
blurb.textContent = "every element, every state — no host, no folder, no conversation";
const theme = document.createElement("button");
/** The kit's colours are `light-dark()`, so half of every element is
 *  invisible in one theme. This flips the page rather than the OS. */
let forced: "light" | "dark" | null = null;
const paint = (): void => {
  document.documentElement.style.colorScheme = forced ?? "light dark";
  theme.textContent = `theme: ${forced ?? "auto"}`;
};
theme.addEventListener("click", () => {
  forced = forced === null ? "light" : forced === "light" ? "dark" : null;
  paint();
});
paint();
bar.append(title, blurb, theme);
document.body.prepend(bar);

const side = document.createElement("aside");
side.className = "side";
const sideTitle = document.createElement("p");
sideTitle.className = "cap";
sideTitle.textContent = "what the elements reported";
side.append(sideTitle, logEl);
document.body.append(side);
