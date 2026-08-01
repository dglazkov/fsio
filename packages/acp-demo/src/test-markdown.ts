// What the page will and will not turn agent text into (markdown.ts).
//
// The security-shaped tests are the ones about what does NOT render: a
// `javascript:` link, raw HTML, an unknown scheme. The parser cannot emit
// markup — it emits a tree, and the renderer builds lit templates from it —
// so these assert the layer above that: that a hostile-looking construct
// survives as *text a human can read*, rather than being dropped silently or
// half-rendered into something clickable.
import test from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, parseInline, type Inline } from "./markdown.js";

/** Flatten a tree back to its text, ignoring structure — for asserting that
 *  nothing was lost when something declined to render as markup. */
const text = (nodes: Inline[]): string =>
  nodes
    .map((n) =>
      n.kind === "text" ? n.text : n.kind === "code" ? n.text : n.kind === "link" ? text(n.children) : text(n.children)
    )
    .join("");

test("markdown: a link with a non-http scheme is text, not a link", () => {
  for (const src of [
    "[click me](javascript:alert(1))",
    "[click me](JaVaScRiPt:alert(1))",
    "[click me](data:text/html,<script>alert(1)</script>)",
    "[click me](vbscript:msgbox)",
    "[click me](file:///etc/passwd)",
  ]) {
    const nodes = parseInline(src);
    assert.equal(
      nodes.some((n) => n.kind === "link"),
      false,
      `${src} must not become a link`
    );
    // Readable, not vanished: the human can still see what was offered.
    assert.match(text(nodes), /click me/);
  }
});

test("markdown: http, https and mailto links are the ones that render", () => {
  for (const [src, href] of [
    ["[a](https://example.com/x?y=1)", "https://example.com/x?y=1"],
    ["[a](http://example.com)", "http://example.com"],
    ["[a](mailto:someone@example.com)", "mailto:someone@example.com"],
    ["[a](https://en.wikipedia.org/wiki/Foo_(bar))", "https://en.wikipedia.org/wiki/Foo_(bar)"], // balanced parens
  ] as const) {
    const nodes = parseInline(src);
    const link = nodes.find((n) => n.kind === "link");
    assert.ok(link && link.kind === "link", `${src} should be a link`);
    assert.equal(link.href, href);
  }
});

test("markdown: raw HTML is never structure — it survives as visible text", () => {
  const blocks = parseMarkdown(`<script>alert(1)</script>\n<img src=x onerror=alert(1)>`);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.kind, "p");
  const t = text((blocks[0] as { children: Inline[] }).children);
  assert.match(t, /<script>alert\(1\)<\/script>/);
  assert.match(t, /<img src=x onerror=alert\(1\)>/);
});

test("markdown: a title after the URL is dropped, and the href is only the URL", () => {
  const nodes = parseInline(`[a](https://example.com "a title")`);
  const link = nodes.find((n) => n.kind === "link");
  assert.ok(link && link.kind === "link");
  assert.equal(link.href, "https://example.com");
});

// ---------------------------------------------------------------- blocks

test("markdown: fenced code keeps its language and its contents verbatim", () => {
  const blocks = parseMarkdown("before\n\n```ts\nconst a = **not bold**;\n```\n\nafter");
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["p", "code", "p"]
  );
  const code = blocks[1] as { lang: string; text: string; closed: boolean };
  assert.equal(code.lang, "ts");
  assert.equal(code.text, "const a = **not bold**;");
  assert.equal(code.closed, true);
});

test("markdown: an unterminated fence is an open code block, not raw backticks (streaming)", () => {
  const blocks = parseMarkdown("here you go:\n\n```py\ndef f():\n    return 1");
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["p", "code"]
  );
  const code = blocks[1] as { text: string; closed: boolean };
  assert.equal(code.closed, false);
  assert.equal(code.text, "def f():\n    return 1");
});

test("markdown: a longer fence survives a shorter one inside it", () => {
  const blocks = parseMarkdown("````\n```\nnested\n```\n````");
  assert.equal(blocks.length, 1);
  assert.equal((blocks[0] as { text: string }).text, "```\nnested\n```");
});

test("markdown: headings, thematic breaks and blockquotes", () => {
  const blocks = parseMarkdown("# One\n\n## Two\n\n---\n\n> quoted\n> still quoted");
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["heading", "heading", "hr", "quote"]
  );
  assert.equal((blocks[0] as { level: number }).level, 1);
  assert.equal((blocks[1] as { level: number }).level, 2);
  assert.equal(text((blocks[3] as { children: Inline[] }).children), "quoted\nstill quoted");
});

test("markdown: bullet and ordered lists, with lazy continuation", () => {
  const blocks = parseMarkdown("- one\n- two\n  wrapped\n\n1. first\n2. second");
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["list", "list"]
  );
  const ul = blocks[0] as { ordered: boolean; items: Inline[][] };
  assert.equal(ul.ordered, false);
  assert.deepEqual(ul.items.map(text), ["one", "two\nwrapped"]);
  const ol = blocks[1] as { ordered: boolean; items: Inline[][] };
  assert.equal(ol.ordered, true);
  assert.deepEqual(ol.items.map(text), ["first", "second"]);
});

test("markdown: a soft line break inside a paragraph is kept (chat, not prose)", () => {
  const blocks = parseMarkdown("line one\nline two");
  assert.equal(blocks.length, 1);
  assert.equal(text((blocks[0] as { children: Inline[] }).children), "line one\nline two");
});

// ---------------------------------------------------------------- inline

test("markdown: strong and em, and no empty emphasis", () => {
  assert.deepEqual(parseInline("**bold**")[0], { kind: "strong", children: [{ kind: "text", text: "bold" }] });
  assert.deepEqual(parseInline("*it*")[0], { kind: "em", children: [{ kind: "text", text: "it" }] });
  // Bare asterisks are just characters.
  assert.equal(text(parseInline("2 * 3 * 4")), "2 * 3 * 4");
  assert.equal(text(parseInline("****")), "****");
});

test("markdown: snake_case identifiers are not italics", () => {
  const nodes = parseInline("call read_text_file and write_text_file");
  assert.equal(
    nodes.some((n) => n.kind === "em"),
    false
  );
  assert.equal(text(nodes), "call read_text_file and write_text_file");
});

test("markdown: a code span is verbatim, including markdown inside it", () => {
  const nodes = parseInline("use `**literal**` here");
  const code = nodes.find((n) => n.kind === "code");
  assert.ok(code && code.kind === "code");
  assert.equal(code.text, "**literal**");
});

test("markdown: an unmatched backtick is a backtick", () => {
  assert.equal(text(parseInline("a ` b")), "a ` b");
});

test("markdown: empty input yields no blocks", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("\n\n  \n"), []);
});
