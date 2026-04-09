// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root:    "src/client",
  plugins: [react()],
  build: {
    outDir:    "../../dist/client",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/session": "http://localhost:3000",
      "/chat":    "http://localhost:3000",
    },
  },
});
