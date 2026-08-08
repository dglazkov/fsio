// The parser, in Node, on every push.
//
// This file is why the parser imports nothing: it carries a security claim —
// **agent text becomes a token tree and never an HTML string** — and a claim
// like that should fail a build rather than a browser session. The renderer's
// half of it (a tree becomes lit bindings, never `unsafeHTML`) is checked by
// reading `prose.ts`; what is checkable here is that nothing dangerous
// survives parsing as something clickable or executable.
import assert from "node:assert/strict";
import test from "node:test";
import { parseInline, parseMarkdown, type Block, type Inline } from "./markdown.js";

const kinds = (blocks: Block[]): string[] => blocks.map((b) => b.kind);
const text = (ns: Inline[]): string => ns.map((n) => ("text" in n ? n.text : "children" in n ? text(n.children) : "")).join("");

test("paragraphs keep the newlines somebody typed", () => {
  // The deliberate departure from CommonMark: in a transcript a newline
  // means a newline, and the renderer sets `white-space: pre-wrap` to match.
  const [p] = parseMarkdown("one\ntwo");
  assert.equal(p?.kind, "p");
  assert.equal(text((p as { children: Inline[] }).children), "one\ntwo");
});

test("a fence that never closes is still a code block", () => {
  // Output streams token by token, so ``` arrives long before its partner.
  // Treating it as open-to-end means code renders as code while it is being
  // written instead of flashing as backticks and reflowing.
  const [b] = parseMarkdown("```ts\nconst a = 1;");
  assert.equal(b?.kind, "code");
  assert.equal((b as { lang: string }).lang, "ts");
  assert.equal((b as { closed: boolean }).closed, false, "and it says it is still open, so a screen can show that");
  assert.equal((b as { text: string }).text, "const a = 1;");
});

test("a closed fence says so, and keeps its contents verbatim", () => {
  const [b] = parseMarkdown("```\n**not bold**\n```");
  assert.equal((b as { closed: boolean }).closed, true);
  assert.equal((b as { text: string }).text, "**not bold**");
});

test("the blocks an agent actually emits", () => {
  const src = ["# Heading", "", "- one", "- two", "", "1. first", "2. second", "", "> quoted", "", "---", "", "a paragraph"].join("\n");
  assert.deepEqual(kinds(parseMarkdown(src)), ["heading", "list", "list", "quote", "hr", "p"]);
});

test("a code span binds tighter than emphasis", () => {
  const ns = parseInline("`**not bold**` and **bold**");
  assert.deepEqual(
    ns.map((n) => n.kind),
    ["code", "text", "strong"]
  );
  assert.equal((ns[0] as { text: string }).text, "**not bold**");
});

// ---- the security half
//
// Each of these is a way agent-authored text could have become something
// that acts rather than something that reads. None of them can, and the
// reason is structural rather than a filter: what leaves the parser is a
// tree of text, and the renderer binds text.

test("a javascript: link is text, not a link", () => {
  // Refused by allow-list — http/https/mailto — so the URL stays readable
  // and simply is not clickable. A blocklist would be a list of the schemes
  // somebody thought of.
  for (const bad of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<script>", "vbscript:x", "file:///etc/passwd"]) {
    const ns = parseInline(`[click](${bad})`);
    assert.ok(
      ns.every((n) => n.kind !== "link"),
      `${bad} must not become a link`
    );
    assert.match(text(ns), /click/, "and the text is still readable");
  }
});

test("http, https and mailto do become links", () => {
  for (const good of ["https://example.test/x", "http://example.test", "mailto:someone@example.test"]) {
    const ns = parseInline(`[go](${good})`);
    assert.equal(ns[0]?.kind, "link", good);
    assert.equal((ns[0] as { href: string }).href, good);
  }
});

test("raw HTML stays text — there is no seam where a string could be trusted", () => {
  // The parser has no HTML mode at all, which is the point: markup an agent
  // writes is characters, and the renderer puts characters in a text binding.
  const src = '<script>alert(1)</script> and <img src=x onerror=alert(1)> and <b>b</b>';
  const [p] = parseMarkdown(src);
  assert.equal(p?.kind, "p");
  assert.equal(text((p as { children: Inline[] }).children), src, "every angle bracket survives as text");
});

test("an unclosed emphasis run does not swallow the rest of the message", () => {
  // A parser that treated a lone `**` as opening emphasis would render the
  // remainder of a streaming message as bold and then un-bold it.
  const ns = parseInline("**not closed");
  assert.equal(text(ns), "**not closed");
});

test("parsing the same source twice gives the same tree", () => {
  // The element re-parses on every chunk while a turn streams, so the parse
  // has to be a function of its input and nothing else.
  const src = "# h\n\n```js\nx\n```\n\n- a\n- b\n\n[l](https://e.test)";
  assert.deepEqual(parseMarkdown(src), parseMarkdown(src));
});
