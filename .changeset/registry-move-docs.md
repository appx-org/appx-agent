---
"@appx-org/agent-protocol": patch
"@appx-org/agent-client": patch
---

Document the move to the public npm registry.

`agent-protocol`'s README had no install section at all, and the root README still
described both packages as shipping to GitHub Packages. Both now state that
installs need no `.npmrc` and no token, and note that `0.1.4` and earlier came
from GitHub Packages so existing consumers know to drop their
`@appx-org:registry` line.

Docs only — no runtime or contract change. This release also exercises the new
trusted-publishing pipeline end to end, which `0.1.5` could not: the packages did
not exist on npmjs yet when that release ran, so its publish step failed and was
completed by hand.
