// Assemble the installable `pewter` artifact (#181) — the API an extension
// imports, staged in artifact-dist/ for CI to commit to the `pewter` branch.
//
// **This one is not bundled, and that is the whole point of it.** The other
// three artifacts run esbuild over a built entry point and ship one file;
// esbuild emits no types, and types are most of what this package is for. An
// extension's `import { pewt } from "pewter"` is typechecked twice — once by
// `pewt check`, once by the editor the author is sitting in — and both read
// the .d.ts out of node_modules/pewter. A bundle would leave them with an
// untyped import and no signal until runtime, which is the opposite of the
// reason NARRATIVE.md gives for an extension being TypeScript at all.
//
// So `dist/` is copied verbatim. There is nothing to bundle in regardless:
// this package has no dependencies, and its own source imports nothing but
// its siblings.
//
// Two things are left out, and neither is verbatim-ness lost:
//
//   test-*     the package's own tests. They import node:test, they are not
//              part of the API, and nothing outside this repository runs
//              them.
//   *.map      source maps resolve to ../src/*.ts, which does not exist on
//              the artifact branch. A map that points at nothing is worse
//              than no map: the editor follows it and lands nowhere.
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
  throw new Error("packages/pewter has not been built (no dist/index.js) — run `npm run build` first");
}
for (const file of shipped) {
  cpSync(join(pkgRoot, "dist", file), join(out, "dist", file));
}

// Version: base from the template, prerelease tag from the commit — so a
// colleague's `npm ls` names the exact build they're running.
const pkg = JSON.parse(readFileSync(join(pkgRoot, "artifact/package.json"), "utf8"));
const sha = (process.env.GITHUB_SHA ?? execSync("git rev-parse HEAD", { cwd: pkgRoot }).toString().trim()).slice(0, 12);
pkg.version = `0.0.0-${sha}`;
writeFileSync(join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

console.log(`artifact-dist/ ready (version ${pkg.version}, ${shipped.length} files, verbatim)`);
