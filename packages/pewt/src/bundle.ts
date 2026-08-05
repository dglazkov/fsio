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
    out = out.replace(tag, `<style>\n${text}\n</style>`);
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
 *  which is where it would have gone anyway. */
export function inline(html: string, js: string, css: string): string {
  const style = css.trim() ? `<style>\n${css}\n</style>\n` : "";
  const script = `<script type="module">\n${escapeScript(js)}\n</script>`;
  const tag = /<script\b[^>]*\bsrc\s*=\s*["']\.?\/?main\.(ts|js)["'][^>]*>\s*<\/script>/i;
  const withScript = tag.test(html) ? html.replace(tag, script) : insertBefore(html, "</body>", script);
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
