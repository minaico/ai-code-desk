import { defineConfig } from "vite";

/**
 * Where the real app is. `npm run dev` only builds the frontend; the sessions,
 * the history and the WebSocket all live in server/server.js on 8080.
 */
const target = `http://127.0.0.1:${process.env.PORT || 8080}`;

export default defineConfig({
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    /**
     * Without this, the dev server answers /api and /terminal itself - with
     * index.html, because that is what a SPA dev server does with a path it
     * does not know. The UI then loads perfectly, every API call parses HTML as
     * JSON, the WebSocket never opens, and the screen says it cannot reach the
     * server and shows no terminals. Nothing is actually wrong with the app, and
     * nothing in the page says which port you are on, so it reads exactly like
     * every session being gone.
     *
     * changeOrigin stays false on purpose: server.js compares the Origin header
     * against Host and rejects the upgrade when they differ. Rewriting Host to
     * 127.0.0.1:8080 while the browser still sends Origin localhost:5173 is
     * precisely that mismatch, so the proxy has to leave Host alone.
     */
    proxy: {
      "/api": { target, changeOrigin: false },
      "/health": { target, changeOrigin: false },
      "/terminal": { target, ws: true, changeOrigin: false },
    },
  },
});
