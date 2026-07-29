import { defineConfig } from "vitest/config";

/**
 * The core (client/store/reducer) is framework-agnostic and needs no DOM, so the
 * default `node` environment keeps tests fast. Components that touch the DOM can
 * opt into `jsdom` per-file via a `// @vitest-environment jsdom` pragma.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
