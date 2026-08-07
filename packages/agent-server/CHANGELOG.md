# @appx-org/agent-server

## 0.1.7

### Patch Changes

- 263b201: Bake the tailored seccomp profile into the agent-server image at
  `/opt/appx/seccomp-builder.json`.

  The profile is a host-side `docker run --security-opt seccomp=<path>` argument,
  so consumers that supervise the outer container previously had to vendor their
  own copy of it — a duplicate of the security boundary that could silently drift
  from `container/seccomp-builder.json`. Shipping it in the image lets a consumer
  extract it (`docker create` + `docker cp`) and be sure the profile it applies is
  the one the image was built with.

- 3318a9e: Reap a project's app containers when it is deleted.

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

- Updated dependencies [3318a9e]
  - @appx-org/agent-protocol@0.1.7

## 0.1.6

### Patch Changes

- Updated dependencies [a8ac671]
  - @appx-org/agent-protocol@0.1.6

## 0.1.5

### Patch Changes

- Updated dependencies [aedd0d4]
  - @appx-org/agent-protocol@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [c3b2fb5]
  - @appx-org/agent-protocol@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [d053429]
  - @appx-org/agent-protocol@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [b45b777]
  - @appx-org/agent-protocol@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [8203e48]
  - @appx-org/agent-protocol@0.1.1
