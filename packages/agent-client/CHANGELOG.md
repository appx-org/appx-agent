# @appx-org/agent-client

## 0.1.3

### Patch Changes

- d053429: Document that `0.1.0` of both packages is broken and should not be installed: those tarballs shipped without `dist/`, so every import fails to resolve. Use `0.1.1` or later (`agent-protocol` needs `0.1.2`+ for a correct `info.version` in `openapi.json`).
- Updated dependencies [d053429]
  - @appx-org/agent-protocol@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [b45b777]
  - @appx-org/agent-protocol@0.1.2

## 0.1.1

### Patch Changes

- 8203e48: Fix the published packages being unusable outside a bundler.

  `0.1.0` shipped `exports` pointing at `dist/`, but no build ran during packing, so the tarballs contained no `dist/` at all and every import failed to resolve. Both packages now build via a `prepack` hook, so a tarball can never ship a missing or stale `dist/`.

  agent-client additionally emitted extensionless relative imports (`./core/client`), which bundlers tolerate but Node's ESM resolver rejects. Its source now writes explicit `.js` specifiers — matching agent-server — so plain-Node consumers (headless services, not just Vite apps) can import the built package. Verified end to end: `npm pack` → install in a scratch project → runtime import and `tsc` both succeed.

  Also fixes a flaky AgentSettings test that asserted the resolved credential mode outside `waitFor` (no runtime behaviour change).

- Updated dependencies [8203e48]
  - @appx-org/agent-protocol@0.1.1
