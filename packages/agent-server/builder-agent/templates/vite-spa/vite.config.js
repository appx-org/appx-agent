import { defineConfig } from "vite";

export default defineConfig({
  // Emit relative asset URLs ("./assets/x.js") rather than root-absolute ones
  // ("/assets/x.js"), so the built app works wherever it is served from — its
  // own origin, or a sub-path of a control plane that proxies it for a preview.
  //
  // With the default absolute paths, an app served under a prefix returns its
  // HTML fine and then asks for /assets/... at the *proxy's* root, which 404s:
  // a blank page. Rewriting the HTML does not fix it either, because the emitted
  // JS chunks reference each other the same absolute way.
  base: "./",
  // Bind to all interfaces so the dev server is reachable from outside the
  // container if ever used; the production image is plain nginx and ignores this.
  server: {
    host: "0.0.0.0",
  },
});
