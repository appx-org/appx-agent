---
"@appx-org/agent-client": patch
"@appx-org/agent-protocol": patch
---

Ship LICENSE and NOTICE in the published tarballs. Both packages declared MIT in `package.json` but shipped no license text, because npm only auto-includes `LICENSE` from a package's own directory and ours lived only at the repo root. The tarballs now carry both files, and NOTICE records the third-party attribution MIT requires (notably the Pi SDKs, which declare MIT but ship no license file of their own).

agent-server is now MIT too — it previously declared no license at all, which blocks consumers that run license-compliance checks.
