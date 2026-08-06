// Restore the exec bit on node-pty's prebuilt spawn-helper (npm's unpack
// drops it; without it every pty spawn dies with `posix_spawnp failed`).
//
// Resolution-based on purpose: under `npx github:…` this package lives
// INSIDE node_modules and node-pty is a sibling, so the repo-root variant
// (`chmod node_modules/node-pty/…`) silently no-ops — measured in the S0
// probe on https://github.com/dglazkov/fsio/issues/16.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readdirSync, chmodSync } from "node:fs";

try {
  const require = createRequire(import.meta.url);
  const ptyRoot = dirname(require.resolve("node-pty/package.json"));
  const prebuilds = join(ptyRoot, "prebuilds");
  for (const d of readdirSync(prebuilds)) {
    try {
      chmodSync(join(prebuilds, d, "spawn-helper"), 0o755);
    } catch {}
  }
} catch {}
