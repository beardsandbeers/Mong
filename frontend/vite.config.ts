import { defineConfig } from "vitest/config";

const FLASK = "http://127.0.0.1:5050";

export default defineConfig({
  build: {
    outDir: "../src/mong/web/dist",
    emptyOutDir: true,
    assetsDir: "assets",
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: FLASK,
        changeOrigin: true,
        configure(proxy) {
          // Flask refuses writes whose Origin differs from its own host.
          proxy.on("proxyReq", (req) => {
            if (req.getHeader("origin")) req.setHeader("origin", FLASK);
          });
        },
      },
    },
  },
  test: {
    include: ["test/**/*.test.{js,ts}"],
    environment: "node",
  },
});
