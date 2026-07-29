---
"@appx-org/agent-protocol": patch
---

Correct the contract version embedded in `openapi.json`.

`0.1.1` published from a commit where the regenerated `openapi.json` hadn't landed yet, so its `info.version` still read `0.1.0` while the package was `0.1.1`. The types and event schema were correct — only the self-reported contract version was stale, which defeats the point of pinning against it. The release checklist (and the `contract.yml` gate) now catch this before publish.
