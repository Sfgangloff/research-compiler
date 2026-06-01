import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API = process.env.RC_API ?? "http://localhost:4317";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5317,
    proxy: { "/api": { target: API, changeOrigin: true } },
  },
  build: { outDir: "dist" },
});
