import { defineConfig } from "vite";

export default defineConfig({
  // Workbench dev server. Port matches the old serve.js so the URL muscle
  // memory (and docs) survive: http://localhost:8765/
  server: {
    port: 8765,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    // The protocol work targets current Chrome (File System Access API);
    // no reason to transpile for older targets.
    target: "es2022",
  },
});
