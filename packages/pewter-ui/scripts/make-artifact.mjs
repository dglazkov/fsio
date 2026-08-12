// Assemble the installable `pewter-ui` artifact, staged in artifact-dist/ for
// CI to commit to the `pewter-ui` branch.
//
// Verbatim, on `pewter`'s precedent and for `pewter`'s reason: the .d.ts is
// most of what the JS half is for — the HTMLElementTagNameMap augmentation is
// how `pewt check` and an editor know the elements — and esbuild emits no
// types. The stylesheet is copied as CSS because a pewter's bundler wants it as
// CSS: esbuild collects the import and the host inlines it into the tab's one
// file. The staging itself is shared with the other verbatim artifacts; see
// scripts/verbatim-artifact.mjs.
import { stageVerbatimArtifact } from "../../../scripts/verbatim-artifact.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version, distFiles } = stageVerbatimArtifact({ pkgRoot, extraFiles: ["style.css"] });

console.log(`artifact-dist/ ready (version ${version}, ${distFiles} dist files + style.css, verbatim)`);
