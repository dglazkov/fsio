import { defineConfig } from "vite";

export default defineConfig({
  // The page lives in web/ so the package root stays the helper's (tsc's)
  // domain; two toolchains, one package, no fighting over dist/.
  root: "web",
  server: {
    // 8767: workbench 8765, terminal demo 8766, this one next — all three
    // dev loops can run at once.
    port: 8767,
    strictPort: true,
  },
  build: {
    outDir: "../dist-web",
    emptyOutDir: true,
    // Chrome-only APIs anyway (File System Access); no legacy transpile.
    target: "es2022",
  },
});
