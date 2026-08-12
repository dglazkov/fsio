// Assemble the installable `@fsio/host` artifact (#224), staged in
// artifact-dist/ for CI to commit to the `host` branch.
//
// Two things this package has in the workspace do not ship, and both omissions
// are the point rather than an economy:
//
//   fsio-host.*  the CLI. #224's consumer embeds `HostServer` in its own Node
//                process and wants a library, not a program. The file is a
//                leaf — index.ts re-exports host-server.js and nothing imports
//                the CLI — so dropping it costs the library nothing.
//   node-pty     never declared. host-server.ts loads it through a *variable*
//                specifier inside a try/catch and falls back to pipes when it
//                is absent, and `HostServerOptions.pty` lets an embedder inject
//                their own module or pass `false` to skip the probe. It sits in
//                packages/host/package.json because the demos in this workspace
//                want a pty — a fact about this tree, not about the package.
//                Declaring it as an optionalDependency here would make every
//                install of a pure library try to build a native addon it may
//                never call.
//
// `@fsio/common` stays external and is declared as the same branch
// `@fsio/client` declares, so a project holding both halves resolves one copy.
// See ../../common/scripts/make-artifact.mjs for why that matters.
import { stageVerbatimArtifact } from "../../../scripts/verbatim-artifact.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version, distFiles } = stageVerbatimArtifact({
  pkgRoot,
  extraFiles: ["README.md"],
  skip: (f) => f.startsWith("fsio-host."),
});

console.log(`artifact-dist/ ready (version ${version}, ${distFiles} dist files + README, verbatim, no CLI)`);
