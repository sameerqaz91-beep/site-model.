import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// SINGLE=1 inlines everything into one index.html (used to publish a self-contained page).
export default defineConfig({
  base: "./",
  plugins: [react(), ...(process.env.SINGLE ? [viteSingleFile()] : [])],
});
