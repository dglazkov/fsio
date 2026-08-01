// Assemble the npx-installable artifact (#106, modeled on terminal-demo's
// #16 S5): esbuild-bundle the built helper, pair it with
// artifact/package.json, and stage everything in artifact-dist/ for CI to
// push to the `acp-demo` branch (npx github:dglazkov/fsio#acp-demo).
//
// The difference from terminal-demo, and the reason this file is shorter:
// **no native addon**. terminal-demo keeps node-pty external because
// pty.node and spawn-helper must exist on disk, which forces a distribution
// with a real node_modules and a postinstall chmod. acp-demo spawns agents
// with plain child_process.spawn, so every dependency bundles and the
// artifact is two self-contained files with no `dependencies` at all.
//
// Two entry points, not one: the helper resolves the puppet as a sibling
// script (`import.meta.dirname/fixture-agent.js`) and spawns it as a
// separate process, so it cannot be an import. It ships as the labeled test
// asset it is (#102 §5) — the browser loop needs a deterministic agent, and
// it is still the only way to fire the consent surface with nothing
// installed. Not a selling point; a side door with a sign on it.
import { build } from "esbuild";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(pkgRoot, "artifact-dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const name of ["helper", "fixture-agent"]) {
  await build({
    entryPoints: [join(pkgRoot, `dist/${name}.js`)],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: join(out, `${name}.js`),
    banner: {
      js: `// fsio acp-demo ${name} — generated bundle; source: packages/acp-demo (github.com/dglazkov/fsio)`,
    },
    logLevel: "warning",
  });
}

// Version: base from the template, prerelease tag from the commit — so a
// colleague's `npm ls` names the exact build they're running.
const pkg = JSON.parse(readFileSync(join(pkgRoot, "artifact/package.json"), "utf8"));
const sha = (process.env.GITHUB_SHA ?? execSync("git rev-parse HEAD", { cwd: pkgRoot }).toString().trim()).slice(0, 12);
pkg.version = `0.0.0-${sha}`;
writeFileSync(join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

console.log(`artifact-dist/ ready (version ${pkg.version})`);
