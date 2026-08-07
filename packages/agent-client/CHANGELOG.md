# @appx-org/agent-client

## 0.1.7

### Patch Changes

- Updated dependencies [3318a9e]
  - @appx-org/agent-protocol@0.1.7

## 0.1.6

### Patch Changes

- a8ac671: Document the move to the public npm registry.

  `agent-protocol`'s README had no install section at all, and the root README still
  described both packages as shipping to GitHub Packages. Both now state that
  installs need no `.npmrc` and no token, and note that `0.1.4` and earlier came
  from GitHub Packages so existing consumers know to drop their
  `@appx-org:registry` line.

  Docs only — no runtime or contract change. This release also exercises the new
  trusted-publishing pipeline end to end, which `0.1.5` could not: the packages did
  not exist on npmjs yet when that release ran, so its publish step failed and was
  completed by hand.

- Updated dependencies [a8ac671]
  - @appx-org/agent-protocol@0.1.6

## 0.1.5

### Patch Changes

- aedd0d4: Publish to the public npm registry instead of GitHub Packages.

  `npm.pkg.github.com` requires an authentication token even for public packages,
  unlike ghcr.io (which serves the public agent-server image anonymously). That
  made every consumer — CI jobs, Docker builds, and developers — need registry
  credentials just to install a public, MIT-licensed package, and a cross-org
  consumer could not authenticate at all with its own repo's token.

  These packages now publish to `registry.npmjs.org` with `access: public`, so
  `npm install @appx-org/agent-client` works with no setup. Consumers should drop
  their `@appx-org:registry` mapping and any associated token plumbing.

  Publishing uses npm trusted publishing (OIDC) rather than a long-lived token, so
  this repo holds no publish secret and each release carries a provenance
  attestation.

- Updated dependencies [aedd0d4]
  - @appx-org/agent-protocol@0.1.5

## 0.1.4

### Patch Changes

- c3b2fb5: Ship LICENSE and NOTICE in the published tarballs. Both packages declared MIT in `package.json` but shipped no license text, because npm only auto-includes `LICENSE` from a package's own directory and ours lived only at the repo root. The tarballs now carry both files, and NOTICE records the third-party attribution MIT requires (notably the Pi SDKs, which declare MIT but ship no license file of their own).

  agent-server is now MIT too — it previously declared no license at all, which blocks consumers that run license-compliance checks.

- Updated dependencies [c3b2fb5]
  - @appx-org/agent-protocol@0.1.4

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
