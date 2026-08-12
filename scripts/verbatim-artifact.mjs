// Stage a package's built `dist/` as an installable artifact, verbatim.
//
// Five packages now ship this way — `pewter`, `pewter-ui`, and (#224)
// `@fsio/common`, `@fsio/client`, `@fsio/host` — and until this file existed
// they were five copies of the same forty lines. PROCESS.md rule 6 asks for
// extraction at the second consumer, not the fifth; this is the overdue half
// of that.
//
// **Verbatim, rather than bundled.** The other artifacts in this repository
// (`pewt`, the two demos) run esbuild over an entry point and ship one file.
// That is right for a program and wrong for a library: esbuild emits no types,
// and for these packages the .d.ts is most of what a consumer gets. Both the
// editor they are sitting in and any `tsc` they run read it out of
// node_modules.
//
// Two kinds of file are left behind, and neither costs verbatim-ness:
//
//   tests      the package's own. They import node:test, they are not part of
//              the API, and nothing outside this repository runs them. Both
//              naming conventions in this repository count: `test-foo.ts`
//              (pewt, pewter) and `foo.test.ts` (common). Matching only the
//              first shipped common's two test files to consumers before
//              anyone noticed.
//   *.map      source maps resolve to ../src/*.ts, which does not exist on an
//              artifact branch. A map that points at nothing is worse than no
//              map: the editor follows it and lands nowhere.
//
// The version is the template's base with the commit as a prerelease tag, so a
// consumer's `npm ls` names the exact build they are running. It also means
// every push produces a diff on every artifact branch, which is what keeps the
// branches advancing together.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

/**
 * @param {object} opts
 * @param {string} opts.pkgRoot        package directory (the one holding artifact/ and dist/)
 * @param {string[]} [opts.extraFiles] files copied from pkgRoot to the artifact root (README.md, style.css…)
 * @param {(file: string) => boolean} [opts.skip] extra per-file exclusion from dist/
 * @returns {{version: string, distFiles: number}}
 */
export function stageVerbatimArtifact({ pkgRoot, extraFiles = [], skip = () => false }) {
  const out = join(pkgRoot, "artifact-dist");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "dist"), { recursive: true });

  const isTest = (f) => f.startsWith("test-") || /\.test\.(js|d\.ts)$/.test(f);
  const shipped = readdirSync(join(pkgRoot, "dist")).filter((f) => !isTest(f) && !f.endsWith(".map") && !skip(f));
  if (!shipped.includes("index.js")) {
    throw new Error(`${pkgRoot} has not been built (no dist/index.js) — run \`npm run build\` first`);
  }
  for (const file of shipped) cpSync(join(pkgRoot, "dist", file), join(out, "dist", file));

  for (const file of extraFiles) {
    const from = join(pkgRoot, file);
    // A missing extra is a packaging bug, not a nothing: the README is the
    // only documentation that reaches the artifact branch, and silently
    // shipping without it is how a consumer gets code and no prose.
    if (!existsSync(from)) throw new Error(`${pkgRoot}: ${file} is listed as an artifact file but does not exist`);
    cpSync(from, join(out, file));
  }

  const pkg = JSON.parse(readFileSync(join(pkgRoot, "artifact/package.json"), "utf8"));
  const sha = (process.env.GITHUB_SHA ?? execSync("git rev-parse HEAD", { cwd: pkgRoot }).toString().trim()).slice(0, 12);
  pkg.version = `0.0.0-${sha}`;
  writeFileSync(join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  return { version: pkg.version, distFiles: shipped.length };
}
