import { defineConfig } from "vite";

export default defineConfig({
  // The page lives in web/ so the package root stays the helper's (tsc's)
  // domain; two toolchains, one package, no fighting over dist/.
  root: "web",
  server: {
    // 8766: one above the workbench's 8765 — both dev loops can run at once.
    port: 8766,
    strictPort: true,
  },
  build: {
    outDir: "../dist-web",
    emptyOutDir: true,
    // Chrome-only APIs anyway (File System Access); no legacy transpile.
    target: "es2022",
  },
});
