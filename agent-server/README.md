# @appx/agent-server

Pi-SDK-based agent orchestration. A standalone HTTP/SSE service that wraps the
[pi coding agent SDK](https://github.com/earendil-works/pi) into a stable
REST + SSE contract.

One process serves one organisation and orchestrates many **projects** — each an
isolated agent workspace (its own directory, config, and chat sessions) sharing
one set of LLM credentials. Projects are explicit, persisted resources: create
them via `POST /v1/projects`, then drive sessions under
`/v1/projects/{id}/sessions/*`. See
[`docs/architecture/project-lifecycle-and-workspace-layout.md`](docs/architecture/project-lifecycle-and-workspace-layout.md).

## Run it

```bash
npm install
npm run build
WORKSPACE_DIR=/abs/path/to/workspace npm start
# → listening on http://127.0.0.1:4001
# → docs at  http://127.0.0.1:4001/docs
# → spec at  http://127.0.0.1:4001/openapi.json
```

Dev with watch: `WORKSPACE_DIR=/abs/path/to/workspace npm run dev`.

## Configuration

All via env vars (see `.env.example`):

| Var                  | Required | Default     | Notes                                                                                                                         |
| -------------------- | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `WORKSPACE_DIR`      | yes      | —           | Root holding every project dir plus `.pi-global/`. Must exist. Mount as a Docker volume for restart-safe projects + registry. |
| `ANTHROPIC_API_KEY`  | no       | —           | Injected into Pi's `AuthStorage` at boot; otherwise relies on `.pi-global/auth.json`.                                         |
| `PI_EXTENSION_PATHS` | no       | —           | Comma-separated Pi extension/package sources (`npm:`, `git:`, or paths).                                                      |
| `PI_SKILL_PATHS`     | no       | —           | Comma-separated Pi skill file/directory paths.                                                                                |
| `PI_PROMPT_PATHS`    | no       | —           | Comma-separated Pi prompt template paths.                                                                                     |
| `PI_THEME_PATHS`     | no       | —           | Comma-separated Pi theme paths.                                                                                               |
| `PI_NO_EXTENSIONS`   | no       | `false`     | `"true"` disables extension discovery except `PI_EXTENSION_PATHS`.                                                            |
| `PI_NO_SKILLS`       | no       | `false`     | `"true"` disables skill discovery.                                                                                            |
| `PI_NO_PROMPTS`      | no       | `false`     | `"true"` disables prompt template discovery.                                                                                  |
| `PI_NO_THEMES`       | no       | `false`     | `"true"` disables theme discovery.                                                                                            |
| `LITELLM_BASE_URL`   | no       | —           | When set, registers a `litellm` provider from `LITELLM_*` envs (see below).                                                   |
| `AGENT_SERVER_HOST`  | no       | `127.0.0.1` | Bind host.                                                                                                                    |
| `AGENT_SERVER_PORT`  | no       | `4001`      | Bind port.                                                                                                                    |
| `AGENT_SERVER_TOKEN` | no       | —           | If set, `/v1/*` requires `Authorization: Bearer <token>`.                                                                     |

Auth is opt-in: loopback-only single-user dev can leave `AGENT_SERVER_TOKEN`
unset. Set it for shared hosts or any deployment where another local process
could reach the port.

## Filesystem layout

Everything lives under `WORKSPACE_DIR`, so a single mounted volume makes projects
and the registry restart-safe:

```
WORKSPACE_DIR/
├── .pi-global/                 # org-global + agent-server state
│   ├── auth.json               # Pi auth (keys are injected from env at boot, in-memory-first)
│   ├── models.json             # Pi custom providers
│   ├── projects.json           # durable project registry — source of truth
│   └── sessions/{id}/          # session transcripts, namespaced by project id
└── {id}/                       # project working dir = app source + config
    └── .pi/                    # AGENTS.md, skills/, extensions/, settings.json (committable)
```

- `{id}` is the project slug (`id = slugify(name)`), immutable and used as the
  registry key, route param, and directory name.
- Project `.pi/` holds **config only** and is committable. Session **transcripts**
  are centralised under `.pi-global/sessions/{id}/`, so they never leak into a
  project's git history and survive independently on the volume.
- A project with no `.pi/AGENTS.md` starts with no pinned prompt (silent skip);
  Pi's normal context-file discovery then applies.
- LLM credentials are injected from env into memory at startup and are **not** the
  job of the volume to persist (`auth.json` holds only non-secret/OAuth state).

## API

REST routes are defined with [Zod](https://zod.dev) via `@hono/zod-openapi`; the
OpenAPI 3.1 doc (`/openapi.json`) is the contract surface, and consumer types are
generated from it (see "Consuming from another app").

**Org-global** (`/v1`):

| Method   | Path                                               | Description                                         |
| -------- | -------------------------------------------------- | --------------------------------------------------- |
| `GET`    | `/v1/sessions/models`                              | List selectable models and auth availability        |
| `GET`    | `/v1/auth/providers`                               | List provider auth status without secrets           |
| `PUT`    | `/v1/auth/providers/{provider}/api-key`            | Store a provider API key                            |
| `DELETE` | `/v1/auth/providers/{provider}`                    | Remove a stored provider credential                 |
| `POST`   | `/v1/auth/providers/{provider}/subscription/start` | Start a subscription OAuth flow                     |
| `GET`    | `/v1/auth/subscription/{flowId}`                   | Read subscription flow state                        |
| `POST`   | `/v1/auth/subscription/{flowId}/continue`          | Continue a prompt/code step                         |
| `DELETE` | `/v1/auth/subscription/{flowId}`                   | Cancel a pending flow                               |
| `GET`    | `/v1/custom/providers`                             | List custom `models.json` providers without secrets |
| `PUT`    | `/v1/custom/providers`                             | Create or update a custom provider                  |
| `DELETE` | `/v1/custom/providers/{provider}`                  | Remove a custom provider                            |
| `GET`    | `/v1/healthz`                                      | Liveness + per-channel SSE subscriber counts        |

**Project lifecycle** (`/v1/projects`):

| Method   | Path                | Description                                                                                               |
| -------- | ------------------- | --------------------------------------------------------------------------------------------------------- |
| `POST`   | `/v1/projects`      | `{ name }` — create-or-get a project (idempotent on name). Returns `{ id, name, projectDir, createdAt }`. |
| `GET`    | `/v1/projects`      | List registered projects                                                                                  |
| `GET`    | `/v1/projects/{id}` | Get one project's metadata                                                                                |
| `DELETE` | `/v1/projects/{id}` | Remove the runtime, metadata, working dir, and transcripts                                                |

**Sessions** (under `/v1/projects/{projectId}`):

| Method  | Path                                                | Description                             |
| ------- | --------------------------------------------------- | --------------------------------------- |
| `GET`   | `…/sessions`                                        | List sessions (persisted + live)        |
| `POST`  | `…/sessions`                                        | Create a new session                    |
| `GET`   | `…/sessions/{id}`                                   | Persisted message history               |
| `GET`   | `…/sessions/{id}/settings`                          | Active model/thinking settings          |
| `PATCH` | `…/sessions/{id}/settings`                          | Switch model and/or thinking while idle |
| `GET`   | `…/sessions/{id}/events`                            | SSE stream of pi `AgentSessionEvent`s   |
| `GET`   | `…/sessions/{id}/extension-ui`                      | Pending extension UI requests           |
| `POST`  | `…/sessions/{id}/extension-ui/{requestId}/response` | Resolve an extension UI request         |
| `POST`  | `…/sessions/{id}/prompt`                            | `{ text }` — send a user prompt         |
| `POST`  | `…/sessions/{id}/abort`                             | Abort the in-flight run (no-op if idle) |

Session routes resolve their runtime by a pure lookup on the path `id`; a request
for a project that was never created returns `404`.

Plus `GET /openapi.json` (OpenAPI 3.1) and `GET /docs` (Swagger UI).

### SSE wire format

Each SSE event is `data: <json>` carrying a `WireEvent` — pi's `AgentSessionEvent`
plus the `extension_ui_request` / `extension_error` events agent-server injects.
The schema is **generated from pi's TypeScript types** (via typia,
`scripts/genEventSchema.ts`) and merged into `openapi.json` as `WireEvent`, so
clients codegen the event + message types (`ToolCall`, `AssistantMessage`, …)
from the same contract as the REST surface — no hand-mirroring, no importing pi
in clients. Regenerate after a pi upgrade with `npm run gen:event-schema`; the
resulting `eventSchema.generated.json` is committed.

Non-JSON lines also occur and should be ignored: an initial `connected to <id>`
line and periodic `heartbeat` keepalives (every 15s). Outgoing events are
classified server-side against the contract (forward-compatible: an unmodeled
`type` is forwarded with a soft log; the stream is never broken).

Handle `message_update.assistantMessageEvent` by `contentIndex`: text blocks use
`text_start`/`text_delta`/`text_end`, tool-call blocks use
`toolcall_start`/`toolcall_delta`/`toolcall_end`, and thinking blocks may be
emitted without being shown in the transcript.

Extension UI requests arrive on the same stream as
`{ "type": "extension_ui_request", ... }`. Blocking requests (`select`, `confirm`,
`input`, `editor`) are held until the browser answers
`POST …/sessions/{id}/extension-ui/{requestId}/response` with one of
`{ "value": "…" }`, `{ "confirmed": true }`, or `{ "cancelled": true }`. After
connecting/reconnecting, call `GET …/sessions/{id}/extension-ui` so requests
created before the SSE connection aren't missed.

## Models and thinking

`GET /v1/sessions/models` returns non-secret Pi model metadata (provider, id,
display name, API family, reasoning support, auth availability, context window,
max output tokens, default thinking level).

`PATCH …/sessions/{id}/settings` accepts:

```json
{
  "provider": "anthropic",
  "modelId": "claude-sonnet-4-5",
  "thinkingLevel": "high"
}
```

`thinkingLevel` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
Changes during streaming return `409`; Pi clamps unsupported levels to the
model's supported set and returns the effective level.

### LiteLLM

When `LITELLM_BASE_URL` is set, the server registers a Pi provider named
`litellm`. Useful envs: `LITELLM_API_KEY`, `LITELLM_DEFAULT_MODEL`,
`LITELLM_MODELS` (comma-separated ids), `LITELLM_MODELS_JSON` (full per-model
config: `reasoning`, `thinkingLevelMap`, `defaultThinkingLevel`, `compat`, `api`,
token limits), `LITELLM_DEFAULT_THINKING`, and `LITELLM_API`
(`openai-completions` | `openai-responses` | `anthropic-messages`). Presets exist
for `openai/gpt-5.5`, `deepseek/deepseek-v4-pro`, and `deepseek/deepseek-v4-flash`.

The same shape can be managed at runtime via `PUT /v1/custom/providers`; records
are written to `.pi-global/models.json` with `0600` perms and reloaded
immediately. Responses only report whether a key exists, never the key.

### Provider auth

`GET /v1/auth/providers` merges Pi model availability, stored API keys,
runtime/env credentials, `models.json` keys, and registered OAuth providers into
one non-secret status list. Use `PUT /v1/auth/providers/{provider}/api-key` for
API keys, or `POST /v1/auth/providers/{provider}/subscription/start` for
subscription auth (some providers, e.g. OpenAI Codex / Anthropic, require pasting
the browser's final localhost redirect back through
`POST /v1/auth/subscription/{flowId}/continue`).

## Extensions

Pi packages and extensions execute code in the agent process. Keep configuration
conservative, review package source before enabling, and prefer project-local
`.pi/settings.json` or `PI_EXTENSION_PATHS` over global installs. For first-party
app bundles, put prompt/skill/extension assets under the project's `.pi/` and let
Pi discover them; the `PI_*_PATHS` vars are for temporary overlays or package
sources that shouldn't be committed to the workspace.

## Regenerating `openapi.json`

`openapi.json` is the published contract — REST routes (described by
`@hono/zod-openapi`) **and** the SSE `WireEvent` schema, which is generated from
pi's TypeScript types via typia rather than hand-authored.

```bash
# only needed after a pi upgrade or a change to WireEvent — regenerates
# src/http/eventSchema.generated.json (the committed event schema).
npm run gen:event-schema

# always: rebuild and dump the merged contract to ./openapi.json
npm run build
npm run openapi
```

`gen:event-schema` requires the typia compiler transform ( ts-patch / `tspc`,
already wired via `tsconfig.gen.json`); the resulting JSON is committed so the
normal `build`/`openapi`/runtime never need it. The live server serves the same
merged document at `/openapi.json`.

## Consuming from another app

Feed the generated `openapi.json` to `openapi-typescript` (or any generator) to
get typed REST DTOs **and** the SSE event/message types (`WireEvent`, `ToolCall`,
`AssistantMessage`, …) — so consumers never re-derive pi's shapes or import pi:

```bash
# in the consuming app
npx openapi-typescript ../../agent-server/openapi.json -o src/generated/agent-server.d.ts
```

Then use a typed client; SSE is consumed separately (native `EventSource`, or
piped through the consumer backend with `fetch().body` streaming):

```ts
import createClient from "openapi-fetch";
import type { paths } from "./generated/agent-server.js";

const client = createClient<paths>({ baseUrl: "http://127.0.0.1:4001" });
const { data } = await client.POST("/v1/projects", {
  body: { name: "my-app" },
});
```

## Library mode (advanced)

To embed the runtime in your own Hono app. `ProjectRegistry.create` is async (it
sets up shared auth/model state and rehydrates the project registry from
`projects.json`); runtimes are built lazily on first use.

```ts
import { Hono } from "hono";
import {
  ProjectRegistry,
  createCredentialsApp,
  createProjectsApp,
  createSessionsApp,
} from "@appx/agent-server";

const registry = await ProjectRegistry.create({ workspaceDir });
const app = new Hono();

app.route("/v1", createCredentialsApp(registry.credentials)); // org-global auth/custom/models
app.route("/v1", createProjectsApp(registry)); // project lifecycle
app.route(
  "/v1/projects/:projectId",
  createSessionsApp(async (c) => {
    const runtime = await registry.getRuntime(c.req.param("projectId"));
    if (!runtime) throw new Error("project not registered"); // map to 404 in onError
    return runtime;
  }),
);
```

Projects are created with `registry.createProject({ name })`; each runtime derives
its working dir (`WORKSPACE_DIR/{id}`), centralised sessions
(`.pi-global/sessions/{id}`), AGENTS.md, skills, and extensions automatically. The
registry holds only org-shared state (auth, models, credentials, project registry).
The standalone server (`src/server.ts`) is the primary deployment; this exists for
tests and embedded hosts.
