---
"@appx-org/agent-server": patch
---

Build app templates with relative asset URLs (`base: "./"`).

Vite defaults to root-absolute asset paths, so a built app emitted
`<script src="/assets/index-abc.js">` and its chunks referenced each other the
same way. That only works when the app is served from the root of its own origin.

A control plane that previews a running app by proxying it under a sub-path —
`/apps/<id>/preview/` — then gets the HTML back correctly and the browser asks for
`/assets/index-abc.js` at the *proxy's* root, which 404s. The result is a blank
frame with no obvious cause. Rewriting the HTML in the proxy does not fix it,
because the emitted JS chunks resolve sibling assets absolutely too, and
code-split apps compute some of those URLs at runtime.

`base: "./"` makes every emitted reference relative, so the app works unchanged at
its own origin, on a subdomain, or under an arbitrary prefix, and a proxy can stay
a plain byte pipe.

Verified with a real build of the template: `dist/index.html` emits
`./assets/index-…js`, and serving `dist/` from `/api/apps/<id>/preview/` resolves
that asset with a 200.

Existing projects pick this up on their next DEV rebuild, which the deploy-app
skill does on every refinement.
