# @appx-org/agent-protocol

## 0.1.2

### Patch Changes

- b45b777: Correct the contract version embedded in `openapi.json`.

  `0.1.1` published from a commit where the regenerated `openapi.json` hadn't landed yet, so its `info.version` still read `0.1.0` while the package was `0.1.1`. The types and event schema were correct — only the self-reported contract version was stale, which defeats the point of pinning against it. The release checklist (and the `contract.yml` gate) now catch this before publish.

## 0.1.1

### Patch Changes

- 8203e48: Fix the published packages being unusable outside a bundler.

  `0.1.0` shipped `exports` pointing at `dist/`, but no build ran during packing, so the tarballs contained no `dist/` at all and every import failed to resolve. Both packages now build via a `prepack` hook, so a tarball can never ship a missing or stale `dist/`.

  agent-client additionally emitted extensionless relative imports (`./core/client`), which bundlers tolerate but Node's ESM resolver rejects. Its source now writes explicit `.js` specifiers — matching agent-server — so plain-Node consumers (headless services, not just Vite apps) can import the built package. Verified end to end: `npm pack` → install in a scratch project → runtime import and `tsc` both succeed.

  Also fixes a flaky AgentSettings test that asserted the resolved credential mode outside `waitFor` (no runtime behaviour change).
