import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  server: { port: 8768, strictPort: true },
  build: { outDir: "../dist-web", emptyOutDir: true, target: "es2022" },
});
