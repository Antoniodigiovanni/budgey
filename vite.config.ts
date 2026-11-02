import { defineConfig } from "vite";
export default defineConfig({
  build: { outDir: "dist/public" },
  server: { host: "127.0.0.1", hmr: false },
});
