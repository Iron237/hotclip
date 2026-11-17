import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
export default defineConfig({
  root: resolve(__dirname, "src/studio"),
  plugins: [react()],
  build: { outDir: resolve(__dirname, "dist-studio"), emptyOutDir: true },
  server: { host: "127.0.0.1" },
});
