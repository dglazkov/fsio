// An extension becomes one self-contained HTML file.
//
//   extensions/repos/*.ts → bundle → .pewter/build/repos.html
//
// Two properties of the pipeline are load-bearing, and both are here rather
// than in the shell:
//
// **One file.** The shell loads an extension into a sandboxed iframe with no
// `allow-same-origin`, which means an opaque origin: no storage, no shell
// DOM, and — the part that shapes this file — no way to fetch a sibling
// asset. So the JavaScript and the CSS are inlined, and code splitting and
// runtime asset loading are not available to an extension.
//
// **No build step for you.** The host rebuilds when a source file is newer
// than the bundle, so saving a file and reloading the tab is the whole loop.
// It is an mtime comparison rather than a watcher: the shell asks for an
// extension every time it opens a tab, and the answer to "is this stale" is
// wanted exactly then and never in between.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureState, type Pewter } from "./pewter.js";

/** What went wrong before anything was compiled — a name that is not an
 *  extension, a missing entry point. A compile error is a different thing
 *  and carries esbuild's own words. */
export class BundleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "BundleError";
  }
}

export interface Bundle {
  /** the extension's name, which is its directory name under `extensions/`. */
  name: string;
  /** where the bytes are, relative to the pewter and with forward slashes:
   *  the shell reads this path through the grant it already holds, so it
   *  must be a path the page can walk, not one this process can open. */
  path: string;
  bytes: number;
  /** sha256 of the file, first 12 hex. The shell holds one of these per open
   *  tab; an unchanged hash means the reload it was about to do is a no-op. */
  hash: string;
  /** false when the bundle on disk was already newer than every source. */
  rebuilt: boolean;
  /** how long the compile took, when there was one. */
  ms?: number;
}

/** Extension names are directory names, and they arrive from the page. The
 *  page is not trusted with a path (nothing that can write the folder is —
 *  spec/PROTOCOL.md, threat model), so the name is checked against what a
 *  name may contain rather than resolved and checked afterwards. */
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** One screen this pewter holds. */
export interface Extension {
  /** its directory name under `extensions/`, which is what opens it. */
  name: string;
  /** false when the directory is not something `bundleExtension` could
   *  build. Reported rather than hidden: a half-written screen is the normal
   *  state of one you are in the middle of writing, and a list that silently
   *  omitted it would be a list that disagrees with your own folder. */
  ready: boolean;
  /** what it is missing, when it is not ready. */
  missing?: string;
}

/** What `extensions/` holds — the twin of `bundleExtension`, and the answer
 *  to "what can this page open".
 *
 *  Both front ends need it for the same reason and neither could ask before:
 *  the page's only door to an extension was a name somebody already knew
 *  (#187), and an agent that writes a screen had no way to confirm the pewter
 *  can see it. Reading the directory is the whole implementation — the folder
 *  is the list, and nothing caches it, so a screen written a second ago is on
 *  the next answer. */
export async function listExtensions(p: Pewter): Promise<Extension[]> {
  let entries;
  try {
    entries = await fs.readdir(p.extensions, { withFileTypes: true });
  } catch {
    // No `extensions/` at all is an empty pewter, not a broken one. The
    // caller draws "nothing to open" either way.
    return [];
  }
  const found: Extension[] = [];
  for (const e of entries) {
    // A dotfile is not a screen, and neither is `env.d.ts` — only directories
    // are, which is the same rule `bundleExtension` resolves against.
    if (!e.isDirectory() || e.name.startsWith(".") || !NAME.test(e.name)) continue;
    const at = path.join(p.extensions, e.name);
    const lacks: string[] = [];
    for (const what of ["index.html", "main.ts"]) {
      if (!(await exists(path.join(at, what)))) lacks.push(what);
    }
    found.push(lacks.length === 0 ? { name: e.name, ready: true } : { name: e.name, ready: false, missing: lacks.join(" and ") });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export async function bundleExtension(p: Pewter, name: string): Promise<Bundle> {
  if (!NAME.test(name)) {
    throw new BundleError(
      "bad_name",
      `${JSON.stringify(name)} is not an extension name`,
      "an extension is a directory under extensions/, named in lowercase with hyphens"
    );
  }
  const src = path.join(p.extensions, name);
  const html = path.join(src, "index.html");
  const entry = path.join(src, "main.ts");
  for (const [file, what] of [
    [html, "index.html"],
    [entry, "main.ts"],
  ] as const) {
    if (!(await exists(file))) {
      throw new BundleError(
        "no_extension",
        `extensions/${name}/ has no ${what}`,
        "an extension is an index.html and a main.ts — `pewt ext new` writes both"
      );
    }
  }

  const out = path.join(p.build, `${name}.html`);
  const rel = `.pewter/build/${name}.html`;
  const newest = await newestMtime(src);
  const built = await mtime(out);
  if (built !== null && newest !== null && built >= newest) {
    const bytes = await fs.readFile(out);
    return { name, path: rel, bytes: bytes.length, hash: digest(bytes), rebuilt: false };
  }

  const t0 = Date.now();
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    // Nothing is written — the HTML is — but naming an outdir is what makes
    // the in-memory outputs have real names to sort by. Without it esbuild
    // calls the whole result `<stdout>` and the CSS has nowhere to go.
    outdir: p.build,
    // Paths in the bundle's own comments are relative to the pewter rather
    // than to whoever's machine this is. That keeps the hash below a
    // property of the source, so two people with the same pewter get the
    // same bundle.
    absWorkingDir: p.root,
    // Resolve through a linked package as if it lived where it is linked.
    //
    // A pewter's own `node_modules` is the one copy of anything. That is
    // free when every package came from npm, and it stops being free the
    // moment one of them is a `file:` link into a checkout — `create-pewt
    // --link`, which is how this repository is worked on. esbuild follows a
    // symlink to its real path by default, so `pewter-ui`'s own `import
    // "lit"` would resolve out of the *checkout's* node_modules while the
    // extension beside it resolves out of the *pewter's*: two copies of lit
    // and two of the signals graph in one bundle.
    //
    // Two copies is not a size problem, it is a silence problem. A signal
    // written through one graph is not read by a computed in the other, so
    // the screen renders once and then never again — no error, nothing in
    // the console, just a page that stopped. Measured, not feared.
    //
    // Keeping the symlink path makes resolution walk up from where the
    // package is *installed*, which is what a peer dependency means. It
    // changes nothing for a pewter whose packages all came from npm: there
    // are no symlinks in that tree to preserve.
    preserveSymlinks: true,
    // The page is Chromium-only anyway — it needs the File System Access API
    // to exist at all — so there is nothing to transpile down to.
    target: "es2022",
    platform: "browser",
    write: false,
    // An extension is read by whoever wants to know what it does, and an
    // agent wrote some of them. Keep the names.
    minify: false,
    logLevel: "silent",
  });

  const js = result.outputFiles.filter((f) => f.path.endsWith(".js")).map((f) => f.text).join("\n");
  const css = result.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
  const page = inline(await inlineLinks(await fs.readFile(html, "utf8"), src), js, css);

  ensureState(p);
  const bytes = Buffer.from(page, "utf8");
  await fs.writeFile(out, bytes);
  return { name, path: rel, bytes: bytes.length, hash: digest(bytes), rebuilt: true, ms: Date.now() - t0 };
}

/** Replace `<link rel="stylesheet" href="./x.css">` with the file's contents.
 *
 *  An extension is one file, and it has to be: it renders in a sandboxed
 *  iframe from `srcdoc`, at an opaque origin with no base URL, so a relative
 *  href resolves to nothing and the stylesheet silently never arrives. A
 *  `<link>` is the natural way to write a stylesheet, the scaffolded
 *  extension wrote one, and the failure is invisible — an unstyled page that
 *  logs nothing.
 *
 *  Only same-directory relative hrefs are inlined. An absolute or remote one
 *  is left alone: it is a network request, which an extension is allowed to
 *  make, and rewriting it would be this bundler deciding otherwise. */
async function inlineLinks(html: string, dir: string): Promise<string> {
  const links = [...html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi)];
  let out = html;
  for (const [tag] of links) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || /^[a-z]+:|^\/\//i.test(href)) continue;
    const rel = href.replace(/^\.\//, "");
    // Same rule the extension name follows: a path out of the extension's
    // own directory is not a stylesheet this bundler will go and get.
    if (rel.startsWith("/") || rel.split("/").includes("..")) continue;
    const text = await fs.readFile(path.join(dir, rel), "utf8").catch(() => null);
    if (text === null) continue; // missing: esbuild-style silence is worse, but a build failure over a stylesheet is worse still
    // A function, not a string — see `inline()` below for what a string
    // replacement does to somebody else's source.
    out = out.replace(tag, () => `<style>\n${text}\n</style>`);
  }
  return out;
}

/** Put the compiled JavaScript and CSS into the extension's own HTML.
 *
 *  The script tag that pointed at `./main.ts` is replaced in place rather
 *  than appended to the end, so what runs is in the position the author put
 *  it — and so the same index.html stays loadable by a dev server later
 *  (#164: a development harness is not built, and this keeps the door open).
 *  An extension whose HTML has no such tag gets the script before `</body>`,
 *  which is where it would have gone anyway.
 *
 *  **The replacements are functions, not strings, and that is load-bearing.**
 *  `String.replace` reads `$&`, `` $` ``, `$'`, `$$` and `$<name>` out of a
 *  replacement *string* and substitutes pieces of the match for them — so
 *  handing it a compiled bundle rewrites whatever in that bundle happens to
 *  look like one. It is not a hypothetical: lit-html builds its marker as
 *
 *      const o = `lit$${Math.random().toFixed(9).slice(2)}$`;
 *
 *  and through a string replacement that arrives as `` lit$…<the whole page
 *  before the script tag> `` — a syntax error a hundred lines into somebody
 *  else's library, in a file nobody wrote, and an extension frame that comes
 *  up blank. A replacer function is handed the text verbatim and reads
 *  nothing out of it. */
export function inline(html: string, js: string, css: string): string {
  const style = css.trim() ? `<style>\n${css}\n</style>\n` : "";
  const script = `<script type="module">\n${escapeScript(js)}\n</script>`;
  const tag = /<script\b[^>]*\bsrc\s*=\s*["']\.?\/?main\.(ts|js)["'][^>]*>\s*<\/script>/i;
  const withScript = tag.test(html) ? html.replace(tag, () => script) : insertBefore(html, "</body>", script);
  return style ? insertBefore(withScript, "</head>", style) : withScript;
}

/** `</script>` anywhere in the bundle would end the tag early — a string
 *  literal containing one is enough, and an extension that renders HTML is
 *  the likely place to find it. The escape is invisible to JavaScript: `<\/`
 *  and `</` are the same string. */
const escapeScript = (js: string): string => js.replace(/<\/(script)/gi, "<\\/$1");

function insertBefore(html: string, close: string, insert: string): string {
  const at = html.toLowerCase().lastIndexOf(close);
  return at === -1 ? `${html}\n${insert}\n` : `${html.slice(0, at)}${insert}\n${html.slice(at)}`;
}

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex").slice(0, 12);

const exists = (file: string): Promise<boolean> =>
  fs.access(file).then(
    () => true,
    () => false
  );

const mtime = (file: string): Promise<number | null> =>
  fs.stat(file).then(
    (s) => s.mtimeMs,
    () => null
  );

/** The newest mtime anywhere under an extension's directory. Null when the
 *  directory cannot be read at all, which the caller already ruled out.
 *
 *  What this deliberately does not watch: the pewter's `node_modules`. An
 *  extension importing a package that changed under it will not rebuild on
 *  that alone, which is the trade for a check that costs a directory walk
 *  instead of a dependency graph. Deleting `.pewter/build` forces it. */
async function newestMtime(dir: string): Promise<number | null> {
  let newest: number | null = null;
  const walk = async (at: string): Promise<void> => {
    const entries = await fs.readdir(at, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const file = path.join(at, e.name);
      if (e.isDirectory()) {
        await walk(file);
      } else {
        const t = await mtime(file);
        if (t !== null && (newest === null || t > newest)) newest = t;
      }
    }
  };
  await walk(dir);
  return newest;
}
