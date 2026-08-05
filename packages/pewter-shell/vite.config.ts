import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  server: {
    // 8769: after the workbench (8765), /terminal (8766), /acp (8767) and
    // /actuator (8768), so every dev loop can run at once.
    port: 8769,
    strictPort: true,
  },
  build: {
    outDir: "../dist-web",
    emptyOutDir: true,
    // Chromium-only anyway: the shell needs the File System Access API to
    // exist at all.
    target: "es2022",
  },
});
