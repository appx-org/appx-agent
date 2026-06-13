import { defineConfig } from "vite";

// Bind to all interfaces so the dev server is reachable from outside the
// container if ever used; the production image is plain nginx and ignores this.
export default defineConfig({
  server: {
    host: "0.0.0.0",
  },
});
