---
"@appx-org/agent-protocol": patch
"@appx-org/agent-client": patch
---

Publish to the public npm registry instead of GitHub Packages.

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
