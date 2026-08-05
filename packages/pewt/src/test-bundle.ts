// The extension pipeline: source → one self-contained HTML file, rebuilt
// only when it is stale.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bundleExtension, BundleError, inline } from "./bundle.js";
import { pewterAt, type Pewter } from "./pewter.js";

function pewter(): Pewter {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pewt-bundle-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", pewter: {} }));
  return pewterAt(root)!;
}

/** An extension with no dependencies — enough for the pipeline, and it
 *  compiles without a node_modules to resolve anything out of. */
function extension(p: Pewter, name: string, main = `const who: string = "world";\ndocument.title = who;\n`): void {
  const dir = path.join(p.extensions, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), `<h1>hi</h1>\n<script type="module" src="./main.ts"></script>\n`);
  fs.writeFileSync(path.join(dir, "main.ts"), main);
}

test("an extension becomes one HTML file with its script inlined", async () => {
  const p = pewter();
  extension(p, "repos");
  const b = await bundleExtension(p, "repos");
  assert.equal(b.path, ".pewter/build/repos.html");
  assert.equal(b.rebuilt, true);
  const html = fs.readFileSync(path.join(p.root, b.path), "utf8");
  assert.match(html, /<h1>hi<\/h1>/);
  assert.match(html, /document\.title/);
  // The tag that pointed at the source is gone: what ships is the bundle.
  assert.doesNotMatch(html, /src=["']\.\/main\.ts["']/);
  assert.equal(b.bytes, Buffer.byteLength(html));
});

test("a second call does nothing while the bundle is newer than its sources", async () => {
  const p = pewter();
  extension(p, "repos");
  const first = await bundleExtension(p, "repos");
  const again = await bundleExtension(p, "repos");
  assert.equal(again.rebuilt, false);
  assert.equal(again.hash, first.hash);
});

test("saving a source file is the whole build step", async () => {
  const p = pewter();
  extension(p, "repos");
  const first = await bundleExtension(p, "repos");
  // Ahead of the bundle by a second: mtime granularity varies by filesystem,
  // and a same-millisecond write is the one case this check cannot see.
  const later = new Date(Date.now() + 1000);
  const main = path.join(p.extensions, "repos", "main.ts");
  fs.writeFileSync(main, `document.title = "changed";\n`);
  fs.utimesSync(main, later, later);
  const second = await bundleExtension(p, "repos");
  assert.equal(second.rebuilt, true);
  assert.notEqual(second.hash, first.hash);
  assert.match(fs.readFileSync(path.join(p.root, second.path), "utf8"), /changed/);
});

test("a stylesheet link becomes a style block — an extension is one file", async () => {
  const p = pewter();
  extension(p, "styled");
  const dir = path.join(p.extensions, "styled");
  fs.writeFileSync(path.join(dir, "style.css"), "body { color: rebeccapurple }\n");
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<link rel="stylesheet" href="./style.css" />\n<link rel="stylesheet" href="https://example.com/x.css" />\n<body><script type="module" src="./main.ts"></script></body>\n`
  );
  const html = fs.readFileSync(path.join(p.root, (await bundleExtension(p, "styled")).path), "utf8");
  // The local one is in the file. A frame at an opaque origin has no base
  // URL to resolve it against, so a link left behind never loads at all.
  assert.match(html, /<style>\s*body \{ color: rebeccapurple \}/);
  assert.doesNotMatch(html, /href=["']\.\/style\.css["']/);
  // The remote one is left alone: that is a network request an extension is
  // allowed to make, and rewriting it would be this bundler deciding not to.
  assert.match(html, /https:\/\/example\.com\/x\.css/);
});

test("a stylesheet link that climbs out of the extension is not followed", async () => {
  const p = pewter();
  extension(p, "nosy");
  fs.writeFileSync(path.join(p.root, "secrets.css"), "body { content: 'private' }");
  fs.writeFileSync(
    path.join(p.extensions, "nosy", "index.html"),
    `<link rel="stylesheet" href="../../secrets.css" />\n<body><script type="module" src="./main.ts"></script></body>\n`
  );
  const html = fs.readFileSync(path.join(p.root, (await bundleExtension(p, "nosy")).path), "utf8");
  assert.doesNotMatch(html, /private/);
});

test("a name that is not an extension name is refused before anything is resolved", async () => {
  const p = pewter();
  for (const name of ["../secrets", "a/b", ".", "Repos", ""]) {
    await assert.rejects(
      () => bundleExtension(p, name),
      (e: unknown) => e instanceof BundleError && e.code === "bad_name"
    );
  }
});

test("a directory that is not an extension says which half is missing", async () => {
  const p = pewter();
  fs.mkdirSync(path.join(p.extensions, "half"), { recursive: true });
  fs.writeFileSync(path.join(p.extensions, "half", "index.html"), "<h1>hi</h1>");
  await assert.rejects(
    () => bundleExtension(p, "half"),
    (e: unknown) => e instanceof BundleError && e.code === "no_extension" && /main\.ts/.test(e.message)
  );
});

test("a compile error travels with esbuild's own words", async () => {
  const p = pewter();
  extension(p, "broken", `const x: number = ;\n`);
  await assert.rejects(() => bundleExtension(p, "broken"));
});

test("a </script> inside the bundle cannot end the tag early", () => {
  const html = inline("<body></body>", `const s = "</script><img onerror=alert(1)>";`, "");
  assert.match(html, /<\\\/script>/);
  // Exactly one closing tag: the one this function wrote.
  assert.equal(html.match(/<\/script>/g)?.length, 1);
});

test("CSS is inlined into the head", () => {
  const html = inline("<head><title>t</title></head><body></body>", "1;", "body { color: red }");
  assert.match(html, /<style>[\s\S]*color: red[\s\S]*<\/style>\s*<\/head>/);
});

test("an HTML file with no script tag still gets the bundle", () => {
  const html = inline("<body><h1>hi</h1></body>", "const a = 1;", "");
  assert.match(html, /<script type="module">[\s\S]*const a = 1;[\s\S]*<\/script>\s*<\/body>/);
});
