import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: "http://localhost:3100",
        changeOrigin: true,
        configure(proxy) {
          // Local Vite is the browser origin. Core must see this as a same-origin
          // reverse-proxy request, not as an unauthenticated cross-origin client.
          proxy.on("proxyReq", (request) => request.removeHeader("origin"));
        },
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
