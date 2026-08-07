---
"@appx-org/agent-server": patch
---

Bake the tailored seccomp profile into the agent-server image at
`/opt/appx/seccomp-builder.json`.

The profile is a host-side `docker run --security-opt seccomp=<path>` argument,
so consumers that supervise the outer container previously had to vendor their
own copy of it — a duplicate of the security boundary that could silently drift
from `container/seccomp-builder.json`. Shipping it in the image lets a consumer
extract it (`docker create` + `docker cp`) and be sure the profile it applies is
the one the image was built with.
