import { defineConfig } from "vite";

export default defineConfig({
  // The page lives in web/ so the package root stays tsc's domain: helper,
  // CLI and page are three toolchain outputs of one package.
  root: "web",
  server: {
    // 8768: after the workbench (8765), /terminal (8766) and /acp (8767),
    // so every dev loop can run at once.
    port: 8768,
    strictPort: true,
  },
  build: {
    outDir: "../dist-web",
    emptyOutDir: true,
    target: "es2022",
  },
});
