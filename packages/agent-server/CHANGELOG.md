# @appx-org/agent-server

## 0.2.0

### Minor Changes

- 336a997: **Breaking (agent-server):** the LiteLLM model list now comes from one place — a
  JSON file named by `LITELLM_MODELS_PATH`.

  Configuring models previously meant choosing between three overlapping tiers
  (`LITELLM_MODELS_JSON` → `LITELLM_MODELS` csv → `LITELLM_DEFAULT_MODEL` alone),
  with four more env vars supplying the per-model values the csv tier could not
  express. The structured tier was the only one a control plane actually used, and
  it required cramming a multi-kilobyte JSON document onto a single env line —
  undiffable, uncommentable, and awkward to generate.

  `LITELLM_MODELS_PATH` points at a JSON array of the same entries. Everything else
  stays a scalar: `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `LITELLM_API`,
  `LITELLM_DEFAULT_MODEL`.

  Removed, and now **rejected at startup** with a message naming the replacement
  rather than silently ignored:

  - `LITELLM_MODELS_JSON` → move the array into the file
  - `LITELLM_MODELS` → list the models in the file
  - `LITELLM_CONTEXT_WINDOW`, `LITELLM_MAX_TOKENS`, `LITELLM_REASONING` → per-model
    `contextWindow` / `maxTokens` / `reasoning`
  - `LITELLM_COMPAT_JSON` → per-model `compat`
  - `LITELLM_DEFAULT_THINKING` → `defaultThinkingLevel` on the default entry

  Rejecting is the point: a stale value would leave the provider unregistered,
  which presents as "the agent has no models" with nothing indicating why. The
  other failure modes are loud for the same reason — an unreadable path, malformed
  JSON, a non-array, or an entry without an `id` all throw at startup.

  `modelPreset()` is unchanged and still supplies the dialect for `openai/gpt-5.5`
  and the DeepSeek models (`thinkingLevelMap`, `defaultThinkingLevel`,
  `compat.thinkingFormat`). File entries override presets field by field, so a bare
  `{"id": "openai/gpt-5.5"}` still gets the full preset — including DeepSeek's
  `null` mappings, which mark levels the model cannot do and drive clamping.

  Adds 22 tests covering file loading, default-model selection, preset precedence,
  every failure mode, and each removed variable.

### Patch Changes

- @appx-org/agent-protocol@0.2.0

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
