import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rawBase = (process.env.NOOK_CONSOLE_BASE_PATH || "/console").replace(/\/+$/, "");
const base = rawBase ? `${rawBase}/` : "/";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "web"),
  base,
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/web"),
    emptyOutDir: true,
  },
  server: {
    port: 5179,
    proxy: {
      "/console/api": "http://127.0.0.1:4790",
      "/console/ws": {
        target: "ws://127.0.0.1:4790",
        ws: true,
      },
    },
  },
});
