// Assemble the installable `pewter-ui` artifact, staged in artifact-dist/
// for CI to commit to the `pewter-ui` branch.
//
// Verbatim, on `pewter`'s precedent and for `pewter`'s reason: the .d.ts is
// most of what the JS half is for — the HTMLElementTagNameMap augmentation
// is how `pewt check` and an editor know the elements — and esbuild emits no
// types. The stylesheet is copied as CSS because a pewter's bundler wants it
// as CSS: esbuild collects the import and the host inlines it into the
// tab's one file. Tests and source maps stay behind, as `pewter`'s do.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(pkgRoot, "artifact-dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "dist"), { recursive: true });

const shipped = readdirSync(join(pkgRoot, "dist")).filter((f) => !f.startsWith("test-") && !f.endsWith(".map"));
if (!shipped.some((f) => f === "index.js")) {
  throw new Error("packages/pewter-ui has not been built (no dist/index.js) — run `npm run build` first");
}
for (const file of shipped) {
  cpSync(join(pkgRoot, "dist", file), join(out, "dist", file));
}
cpSync(join(pkgRoot, "style.css"), join(out, "style.css"));

// Version: base from the template, prerelease tag from the commit — so a
// colleague's `npm ls` names the exact build they're running.
const pkg = JSON.parse(readFileSync(join(pkgRoot, "artifact/package.json"), "utf8"));
const sha = (process.env.GITHUB_SHA ?? execSync("git rev-parse HEAD", { cwd: pkgRoot }).toString().trim()).slice(0, 12);
pkg.version = `0.0.0-${sha}`;
writeFileSync(join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

console.log(`artifact-dist/ ready (version ${pkg.version}, ${shipped.length} dist files + style.css, verbatim)`);
