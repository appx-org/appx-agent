---
"@appx-org/agent-server": minor
---

**Breaking (agent-server):** the LiteLLM model list now comes from one place — a
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
