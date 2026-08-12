// Assemble the installable `@fsio/client` artifact (#224), staged in
// artifact-dist/ for CI to commit to the `client` branch.
//
// The package ships exactly as it is built. Its public .d.ts is deliberately
// lib-agnostic — the FS dependency is a structural type and the internals are
// ES #private fields precisely so no DOM type reaches the surface — so a
// consumer compiles it with or without lib.dom and nothing here has to be
// rewritten for the trip.
//
// `@fsio/common` stays external and is declared as the same branch `@fsio/host`
// declares, so a project holding both halves resolves one copy. See
// ../../common/scripts/make-artifact.mjs for why that matters.
//
// No `engines` field: this half runs in a browser, and the Node version that
// bundles it is not something this package has an opinion about.
import { stageVerbatimArtifact } from "../../../scripts/verbatim-artifact.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version, distFiles } = stageVerbatimArtifact({ pkgRoot, extraFiles: ["README.md"] });

console.log(`artifact-dist/ ready (version ${version}, ${distFiles} dist files + README, verbatim)`);
