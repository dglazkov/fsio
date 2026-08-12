// Assemble the installable `@fsio/common` artifact (#224), staged in
// artifact-dist/ for CI to commit to the `common` branch.
//
// Nobody installs this one directly: it arrives as a dependency of
// `@fsio/client` and `@fsio/host`, which both declare the same branch so that
// npm resolves **one** copy. That is the whole reason it is a branch of its own
// rather than a bundled-in copy on each side. `RpcError` is a class and
// `FrameType` is an enum, so two copies means two identities, and a consumer
// using both halves — the case #224 exists for — gets `instanceof` returning
// false with no other symptom.
import { stageVerbatimArtifact } from "../../../scripts/verbatim-artifact.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version, distFiles } = stageVerbatimArtifact({ pkgRoot, extraFiles: ["README.md"] });

console.log(`artifact-dist/ ready (version ${version}, ${distFiles} dist files + README, verbatim)`);
