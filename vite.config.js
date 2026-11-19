import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [
    svelte({
      onwarn(warning, handler) {
        if (warning.code === "css_unused_selector") {
          throw new Error(`${warning.filename}: ${warning.message}`);
        }
        handler(warning);
      },
    }),
  ],
  resolve: {
    dedupe: ["@codemirror/state", "@codemirror/view", "@codemirror/language"],
  },
  server: {
    port: 38472,
    strictPort: true,
    // object form: the string shorthand sets changeOrigin, which rewrites Host
    // to :38471 so a write from any other vite port (forest-preview's :38473)
    // fails the server's Origin-vs-Host check
    proxy: { "/api": { target: "http://localhost:38471" } },
  },
});
