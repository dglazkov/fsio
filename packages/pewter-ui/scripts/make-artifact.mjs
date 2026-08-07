// Assemble the installable `pewter-ui` artifact, staged in artifact-dist/
// for CI to commit to the `pewter-ui` branch.
//
// There is nothing to build and nothing to bundle: the package IS its
// stylesheet, and a pewter's bundler wants the CSS as CSS — esbuild collects
// the import and the host inlines it into the tab's one file. So the
// artifact is the stylesheet and a package.json, both copied, on `pewter`'s
// verbatim precedent rather than the bundled ones.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(pkgRoot, "artifact-dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(pkgRoot, "style.css"), join(out, "style.css"));

// Version: base from the template, prerelease tag from the commit — so a
// colleague's `npm ls` names the exact build they're running.
const pkg = JSON.parse(readFileSync(join(pkgRoot, "artifact/package.json"), "utf8"));
const sha = (process.env.GITHUB_SHA ?? execSync("git rev-parse HEAD", { cwd: pkgRoot }).toString().trim()).slice(0, 12);
pkg.version = `0.0.0-${sha}`;
writeFileSync(join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

console.log(`artifact-dist/ ready (version ${pkg.version}, verbatim)`);
