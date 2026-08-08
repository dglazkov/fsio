// The extension pipeline: source → one self-contained HTML file, rebuilt
// only when it is stale.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bundleExtension, BundleError, inline, listExtensions } from "./bundle.js";
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

test("a stylesheet imported from code is bundled and inlined — the terminal's xterm.css path", async () => {
  const p = pewter();
  extension(p, "drawn", `import "./skin.css";\ndocument.title = "drawn";\n`);
  fs.writeFileSync(path.join(p.extensions, "drawn", "skin.css"), ".xterm { color: aliceblue }\n");
  const html = fs.readFileSync(path.join(p.root, (await bundleExtension(p, "drawn")).path), "utf8");
  // esbuild collects the import into a css output file, and the bundler puts
  // it in a <style> block — the same journey `import "@xterm/xterm/css/
  // xterm.css"` makes in the scaffolded terminal extension, walked here with
  // a local file so no test needs a node_modules.
  assert.match(html, /<style>[\s\S]*aliceblue[\s\S]*<\/style>/);
  assert.doesNotMatch(html, /import ["']\.\/skin\.css["']/);
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

test("a linked package resolves its peers out of the pewter, not out of its own checkout", async () => {
  // `create-pewt --link` installs `pewter-ui` as a symlink into a checkout of
  // this repository, and the checkout has its own node_modules. Followed to
  // its real path, the kit's own `import "lit"` lands there — so one bundle
  // carries the pewter's lit *and* the checkout's, the extension writes a
  // signal through one graph and the kit reads it through the other, and the
  // screen renders once and then silently never again.
  //
  // Stood up here with two copies of one package that say different things,
  // because "which copy did we get" is the whole question and a byte count
  // cannot answer it.
  const p = pewter();
  const elsewhere = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pewt-checkout-"));
  const shared = (root: string, says: string): void => {
    const dir = path.join(root, "node_modules", "shared");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "shared", version: "1.0.0", main: "index.js" }));
    fs.writeFileSync(path.join(dir, "index.js"), `export const says = ${JSON.stringify(says)};\n`);
  };
  // The kit, living in the checkout, declaring `shared` as a peer.
  const kit = path.join(elsewhere, "kit");
  fs.mkdirSync(kit, { recursive: true });
  fs.writeFileSync(path.join(kit, "package.json"), JSON.stringify({ name: "kit", version: "1.0.0", type: "module", main: "index.js", peerDependencies: { shared: "*" } }));
  fs.writeFileSync(path.join(kit, "index.js"), `import { says } from "shared";\nexport const fromTheKit = says;\n`);
  shared(elsewhere, "the checkout's");
  // The pewter: its own copy of `shared`, and the kit as npm links it.
  shared(p.root, "the pewter's");
  fs.symlinkSync(kit, path.join(p.root, "node_modules", "kit"), "dir");

  extension(p, "linked", `import { fromTheKit } from "kit";\nimport { says } from "shared";\ndocument.title = fromTheKit + says;\n`);
  const html = fs.readFileSync(path.join(p.root, (await bundleExtension(p, "linked")).path), "utf8");
  assert.doesNotMatch(html, /the checkout's/, "the kit read its peer out of the checkout — two copies in one bundle");
  // And exactly one copy of the one that is right.
  assert.equal(html.match(/the pewter's/g)?.length, 1);
});

test("a bundle that looks like a replacement pattern is inlined verbatim", () => {
  // lit-html's marker, which is the real source of this: the whole line
  // arrives through `inline` and every `$`-sequence in it has to survive.
  // Through a replacement *string*, `$$` collapses and `` $` `` becomes the
  // page before the script tag — a syntax error in somebody else's library.
  const js = "const o = `lit$${Math.random()}$`; const p = \"$& $' $<x>\";";
  const html = inline('<body><p id="drawn"></p><script type="module" src="./main.ts"></script></body>', js, "");
  assert.match(html, /const o = `lit\$\$\{Math\.random\(\)\}\$`;/);
  assert.match(html, /\$& \$' \$<x>/);
});

test("a stylesheet that looks like a replacement pattern is inlined verbatim too", async () => {
  const p = pewter();
  extension(p, "dollared");
  const dir = path.join(p.extensions, "dollared");
  fs.writeFileSync(path.join(dir, "style.css"), "b::after { content: '$& $`'; }\n");
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<link rel="stylesheet" href="./style.css" />\n<body><script type="module" src="./main.ts"></script></body>\n`
  );
  const html = fs.readFileSync(path.join(p.root, (await bundleExtension(p, "dollared")).path), "utf8");
  assert.match(html, /content: '\$& \$`';/);
});

test("CSS is inlined into the head", () => {
  const html = inline("<head><title>t</title></head><body></body>", "1;", "body { color: red }");
  assert.match(html, /<style>[\s\S]*color: red[\s\S]*<\/style>\s*<\/head>/);
});

test("an HTML file with no script tag still gets the bundle", () => {
  const html = inline("<body><h1>hi</h1></body>", "const a = 1;", "");
  assert.match(html, /<script type="module">[\s\S]*const a = 1;[\s\S]*<\/script>\s*<\/body>/);
});

// ---- what the folder holds (#187)
//
// The page's only door to an extension used to be a name somebody already
// knew, which is why closing the last tab left no way back. These cover the
// answer that door reads.

test("the list is the folder, sorted, with no build in it", async () => {
  const p = pewter();
  extension(p, "repos");
  extension(p, "agent");
  const found = await listExtensions(p);
  assert.deepEqual(
    found.map((e) => e.name),
    ["agent", "repos"]
  );
  assert.ok(
    found.every((e) => e.ready),
    "both are openable"
  );
  // Listing must not compile anything: opening a menu that builds every
  // screen in the pewter would be a menu nobody opens twice.
  assert.equal(fs.existsSync(p.build), false);
});

test("a half-written screen is listed and says what it lacks, rather than vanishing", async () => {
  const p = pewter();
  extension(p, "done");
  // The normal state of a screen somebody is in the middle of writing — and
  // the state an agent leaves one in between two tool calls.
  fs.mkdirSync(path.join(p.extensions, "started"), { recursive: true });
  fs.writeFileSync(path.join(p.extensions, "started", "index.html"), "<h1>soon</h1>");
  const found = await listExtensions(p);
  assert.deepEqual(
    found.map((e) => `${e.name}:${e.ready}`),
    ["done:true", "started:false"]
  );
  assert.equal(found.find((e) => e.name === "started")?.missing, "main.ts");
});

test("files beside the screens are not screens", async () => {
  const p = pewter();
  extension(p, "repos");
  // The scaffold writes this one, and a directory nobody should offer.
  fs.writeFileSync(path.join(p.extensions, "env.d.ts"), "declare module '*.css';\n");
  fs.mkdirSync(path.join(p.extensions, ".cache"), { recursive: true });
  assert.deepEqual(
    (await listExtensions(p)).map((e) => e.name),
    ["repos"]
  );
});

test("a pewter with no extensions/ lists nothing rather than failing", async () => {
  const p = pewter();
  assert.deepEqual(await listExtensions(p), []);
});
