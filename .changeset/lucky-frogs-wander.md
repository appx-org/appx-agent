---
"@appx-org/agent-client": patch
"@appx-org/agent-protocol": patch
---

Document that `0.1.0` of both packages is broken and should not be installed: those tarballs shipped without `dist/`, so every import fails to resolve. Use `0.1.1` or later (`agent-protocol` needs `0.1.2`+ for a correct `info.version` in `openapi.json`).
