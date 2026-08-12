// Assemble the installable `pewter` artifact (#181) — the API an extension
// imports, staged in artifact-dist/ for CI to commit to the `pewter` branch.
//
// **This one is not bundled, and that is the whole point of it.** An
// extension's `import { pewt } from "pewter"` is typechecked twice — once by
// `pewt check`, once by the editor the author is sitting in — and both read the
// .d.ts out of node_modules/pewter, which esbuild would not have emitted. The
// staging itself is shared with the other verbatim artifacts; the reasoning
// lives in scripts/verbatim-artifact.mjs.
//
// There is nothing to bundle in regardless: this package has no dependencies,
// and its own source imports nothing but its siblings.
import { stageVerbatimArtifact } from "../../../scripts/verbatim-artifact.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version, distFiles } = stageVerbatimArtifact({ pkgRoot });

console.log(`artifact-dist/ ready (version ${version}, ${distFiles} files, verbatim)`);
