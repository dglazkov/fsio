import { defineConfig } from "vite";

export default defineConfig({
  // The gallery only. This package ships through `tsc` and an artifact
  // branch; vite is here for looking at the elements, not for building them.
  root: "gallery",
  server: {
    // 8770: after the workbench (8765), /terminal (8766), /acp (8767),
    // /actuator (8768) and the shell (8769), so every loop can run at once.
    port: 8770,
    strictPort: true,
  },
});
