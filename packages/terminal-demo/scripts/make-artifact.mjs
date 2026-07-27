// Assemble the npx-installable artifact (#16 S5): esbuild-bundle the built
// helper into one file, pair it with artifact/{package.json,postinstall.mjs},
// and stage everything in artifact-dist/ for CI to push to the
// `terminal-demo` branch (npx github:dglazkov/fsio#terminal-demo).
//
// node-pty stays external: it is a native addon (pty.node + spawn-helper
// must exist on disk), which is exactly why the distribution is npx-with-
// a-real-node_modules and not a curl'd single file.
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
  entryPoints: [join(pkgRoot, "dist/helper.js")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["node-pty"],
  outfile: join(out, "helper.js"),
  banner: {
    js: "// fsio terminal-demo helper — generated bundle; source: packages/terminal-demo (github.com/dglazkov/fsio)",
  },
  logLevel: "warning",
});

// Version: base from the template, prerelease tag from the commit — so a
// colleague's `npm ls` names the exact build they're running.
const pkg = JSON.parse(readFileSync(join(pkgRoot, "artifact/package.json"), "utf8"));
const sha = (process.env.GITHUB_SHA ?? execSync("git rev-parse HEAD", { cwd: pkgRoot }).toString().trim()).slice(0, 12);
pkg.version = `0.0.0-${sha}`;
writeFileSync(join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
cpSync(join(pkgRoot, "artifact/postinstall.mjs"), join(out, "postinstall.mjs"));

console.log(`artifact-dist/ ready (version ${pkg.version})`);
