// A small markdown parser for what an agent says.
//
// Copied from `acp-demo/src/markdown.ts` rather than shared with it (#164:
// Pewter copies from the demos, and the duplication is accepted). It is a
// parser and not a look, so it lives beside the element that renders it and
// imports nothing — which is also what lets it be tested in Node on every
// push instead of only through a browser.
//
// **The sentence: agent text never becomes markup.** This emits a token tree
// and never an HTML string; `prose.ts` turns that tree into lit templates, so
// every piece of agent-authored text lands in a text binding that lit
// escapes. There is deliberately no seam in this design where an HTML string
// exists to be sanitized or forgotten, and `unsafeHTML` must never appear in
// the renderer.
//
// That matters more here than the sandbox makes it look. An extension's frame
// has an origin of its own and holds no folder handle, so a script injected
// through a chat bubble does not reach the grant. What it does reach is the
// `pewt` API — the port in that frame is a capability, and every operation the
// extension can call, injected script can call too. And the text is model
// output that the folder's own contents influence: an agent summarizing a file
// is quoting whatever that file says. A file can therefore be written to
// contain a payload that an agent quotes and a screen renders, which is a long
// way round to the API and exactly why the tree is not a string.
//
// The subset is deliberately small — what agents actually emit in chat:
//
//   blocks   fenced code, ATX headings, thematic breaks, blockquotes,
//            flat bullet/ordered lists, paragraphs
//   inline   code spans, **strong**, *em*, [links](https://…)
//
// Not supported, and left as literal text rather than half-rendered: nested
// lists, tables, reference links, setext headings, backslash escapes, and
// raw HTML (which is the point — see above).
//
// Two deliberate departures from CommonMark, both because this is chat and
// not a document:
//
//   - **A soft line break stays a line break.** CommonMark folds single
//     newlines inside a paragraph into spaces. In a transcript people write
//     newlines meaning newlines, so paragraphs keep them and the renderer
//     sets `white-space: pre-wrap`.
//   - **An unterminated fence is a code block, not literal text.** Agent
//     output streams in token by token, so ``` arrives long before its
//     closing fence. Treating the fence as open-to-end-of-input means a code
//     block renders as code while it is still being written, instead of
//     flashing as raw backticks and then reflowing. The block says it is
//     still open (`closed: false`) so a screen can show that.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

export type Block =
  | { kind: "p"; children: Inline[] }
  | { kind: "heading"; level: number; children: Inline[] }
  /** `closed` is false when the input ended before the fence did — i.e. a
   *  block still streaming. The renderer can say so; nothing else changes. */
  | { kind: "code"; lang: string; text: string; closed: boolean }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "quote"; children: Inline[] }
  | { kind: "hr" };

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const UL = /^ {0,3}[-*+]\s+(.*)$/;
const OL = /^ {0,3}\d{1,9}[.)]\s+(.*)$/;

/** True for any line that would start a block other than a paragraph — the
 *  set a paragraph has to stop before. */
const startsBlock = (line: string): boolean =>
  FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || UL.test(line) || OL.test(line);

export function parseMarkdown(src: string): Block[] {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code. The closing fence must use the same character and be at
    // least as long, so ``` inside a ~~~ block (or a longer run) survives.
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const char = marker[0]!;
      const lang = (fence[2] ?? "").trim().split(/\s+/)[0] ?? "";
      const body: string[] = [];
      let closed = false;
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        const close = FENCE.exec(l);
        if (close && close[1]![0] === char && close[1]!.length >= marker.length && (close[2] ?? "").trim() === "") {
          closed = true;
          i++;
          break;
        }
        body.push(l);
        i++;
      }
      blocks.push({ kind: "code", lang, text: body.join("\n"), closed });
      continue;
    }

    // Thematic break before lists: `---` also matches a bullet pattern in
    // some spellings, and the break is the more specific reading.
    if (HR.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, children: parseInline(heading[2] ?? "") });
      i++;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const body: string[] = [quote[1] ?? ""];
      i++;
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]!);
        if (!q) break;
        body.push(q[1] ?? "");
        i++;
      }
      blocks.push({ kind: "quote", children: parseInline(body.join("\n")) });
      continue;
    }

    const ordered = OL.test(line);
    if (ordered || UL.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const m = ordered ? OL.exec(l) : UL.exec(l);
        if (m) {
          items.push(m[1] ?? "");
          i++;
          continue;
        }
        // Lazy continuation: a plain line under an item belongs to it. A
        // blank line, or anything that starts a block (including the OTHER
        // list flavour), ends the list.
        if (l.trim() === "" || startsBlock(l) || !items.length) break;
        items[items.length - 1] += "\n" + l.trim();
        i++;
      }
      blocks.push({ kind: "list", ordered, items: items.map(parseInline) });
      continue;
    }

    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() !== "" && !startsBlock(lines[i]!)) {
      para.push(lines[i]!);
      i++;
    }
    blocks.push({ kind: "p", children: parseInline(para.join("\n")) });
  }

  return blocks;
}

/** Schemes a link may carry. Everything else — `javascript:` first among
 *  them, but also anything exotic enough that we have not thought about it —
 *  falls back to literal text, so the URL is still *readable* and simply not
 *  clickable. Refusing by allow-list rather than by blocklist is the posture
 *  the host takes toward everything it starts: name what is permitted, never
 *  what is forbidden. */
const SAFE_SCHEME = /^(?:https?:|mailto:)/i;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf) out.push({ kind: "text", text: buf });
    buf = "";
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i]!;

    // Code spans bind tightest: whatever is between matching backtick runs
    // is verbatim, so `**not bold**` inside one stays literal.
    if (c === "`") {
      let n = 0;
      while (src[i + n] === "`") n++;
      const run = "`".repeat(n);
      const end = src.indexOf(run, i + n);
      if (end !== -1) {
        flush();
        // One leading/trailing space is stripped so `` ` `` can hold a backtick.
        out.push({ kind: "code", text: src.slice(i + n, end).replace(/^ (.*) $/s, "$1") });
        i = end + n;
        continue;
      }
    }

    if (c === "[") {
      const link = matchLink(src, i);
      if (link) {
        flush();
        out.push(link.node);
        i = link.next;
        continue;
      }
    }

    if (c === "*" || c === "_") {
      const double = src[i + 1] === c;
      const delim = double ? c + c : c;
      const end = findClose(src, i + delim.length, delim, c === "_");
      if (end !== -1) {
        flush();
        out.push({ kind: double ? "strong" : "em", children: parseInline(src.slice(i + delim.length, end)) });
        i = end + delim.length;
        continue;
      }
    }

    buf += c;
    i++;
  }

  flush();
  return out;
}

/** Find the closing delimiter for emphasis, or -1.
 *
 *  `wordBoundary` is set for `_` only, and it is why `snake_case_names`
 *  survive a conversation about code: CommonMark lets `*` bind inside a
 *  word but not `_`, and agent output is full of identifiers. */
function findClose(src: string, from: number, delim: string, wordBoundary: boolean): number {
  if (from >= src.length || src[from] === " ") return -1; // no empty/space-opened emphasis
  let i = from;
  while (i < src.length) {
    const at = src.indexOf(delim, i);
    if (at === -1) return -1;
    // A longer run than we opened with is a different delimiter.
    if (src[at + delim.length] === delim[0]) {
      i = at + delim.length + 1;
      continue;
    }
    const before = src[at - 1];
    const after = src[at + delim.length];
    const ok = before !== undefined && before !== " " && (!wordBoundary || after === undefined || !/[\w]/.test(after));
    if (ok && at > from) return at;
    i = at + delim.length;
  }
  return -1;
}

/** `[label](href)` at `src[start]`, or null if this bracket is just a
 *  bracket. Parens inside the href are balanced so markdown links to URLs
 *  that contain them survive. */
function matchLink(src: string, start: number): { node: Inline; next: number } | null {
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || src[i + 1] !== "(") return null;
  const label = src.slice(start + 1, i);
  let j = i + 2;
  let parens = 1;
  for (; j < src.length; j++) {
    if (src[j] === "(") parens++;
    else if (src[j] === ")") {
      parens--;
      if (parens === 0) break;
    }
  }
  if (parens !== 0) return null;
  // A title after the URL (`[a](url "t")`) is dropped, not rendered.
  const href = (src.slice(i + 2, j).trim().split(/\s+/)[0] ?? "").trim();
  if (!SAFE_SCHEME.test(href)) return null;
  return { node: { kind: "link", href, children: parseInline(label) }, next: j + 1 };
}
