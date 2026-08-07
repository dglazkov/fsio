// Assemble the installable `create-pewt` artifact (#181), on acp-demo's
// #106 template — the no-native-addon case, and the simplest of the four.
//
// Everything bundles: this package depends on nothing, and its source
// imports node builtins and its own scaffold.ts. So the artifact is the
// bundled cli.js, the package.json, and templates/ copied verbatim — the
// extension files the scaffolder lays into a new pewter, shipped as the
// files they are so `templatesDir()` finds them beside the bundle.
//
// Run as `npx github:dglazkov/fsio#create-pewt <dir>`. It is not `npm create
// pewt`, and cannot be until this publishes to a registry — `npm create X`
// resolves X as a registry name, which is a different mechanism from a git
// dependency. The scaffolded pewter is unaffected either way: it declares
// `pewt` and `pewter` as ordinary dependencies (#181), so it restores with
// `git clone && npm i` and needs no fsio checkout at all.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(pkgRoot, "artifact-dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(pkgRoot, "dist/cli.js")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: join(out, "cli.js"),
  // No shebang here: dist/cli.js already carries one and esbuild hoists it
  // above the banner, so writing a second produces a file node refuses to
  // parse.
  banner: {
    js: "// create-pewt — generated bundle; source: packages/create-pewt (github.com/dglazkov/fsio)",
  },
  logLevel: "warning",
});

cpSync(join(pkgRoot, "templates"), join(out, "templates"), { recursive: true });

// Version: base from the template, prerelease tag from the commit — so a
// colleague's `npm ls` names the exact build they're running.
const pkg = JSON.parse(readFileSync(join(pkgRoot, "artifact/package.json"), "utf8"));
const sha = (process.env.GITHUB_SHA ?? execSync("git rev-parse HEAD", { cwd: pkgRoot }).toString().trim()).slice(0, 12);
pkg.version = `0.0.0-${sha}`;
writeFileSync(join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

console.log(`artifact-dist/ ready (version ${pkg.version})`);
