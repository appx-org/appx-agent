---
"@appx-org/agent-server": patch
"@appx-org/agent-protocol": patch
---

Reap a project's app containers when it is deleted.

`DELETE /v1/projects/{id}` removed a project's metadata, working dir and
transcripts but left the containers the deploy-app skill created **running**,
still holding their published ports. Since control planes gap-fill freed ports, a
later project could be allocated a port an orphan already held — surfacing as an
opaque container-start failure in a different project than the delete that caused
it. Orphans also survived outer-container restarts, so they were durable.

Deleting a project now reaps its containers, networks, volumes and images before
dropping the metadata (containers first: one may hold a bind mount into the
working dir). Resources are found by the `appx.project=<id>` label, which the
deploy-app skill now stamps on everything it creates, with a fallback to the
`<id>-app-{dev,prod}` naming convention for containers deployed before the label
existed. Container removal passes `-v` so anonymous volumes — which carry no
label and would otherwise be unreachable — go too.

Runtime failures are logged and the delete still succeeds: leaving a project
undeletable is worse than leaking a resource. Callers see an unchanged
`{"ok": true}`, so check server logs to detect a partial reap.

`.pi/deployment.json` gains a `project` key carrying the project's canonical id,
and is now written for every project rather than only those with deployment
metadata. The generated prompt section states the same id. This gives the agent
one exact string to label with instead of inferring it, so labelling and reaping
cannot disagree. The key is server-derived and absent from the `Deployment`
request schema.
