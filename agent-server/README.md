# @appx/agent-server

Pi-SDK-based agent orchestration. Standalone HTTP/SSE service, one process per Appx app.

This is the **Agent Server Source** from the Appx App Anatomy: a self-contained
TypeScript service that wraps the [pi coding agent SDK](https://github.com/earendil-works/pi)
into a stable REST + SSE contract. Each Appx app launches its own
agent-server (single-tenant per process) and talks to it over loopback.

## Run it

```bash
npm install
npm run build
PROJECT_DIR=/abs/path/to/your/app npm start
# → listening on http://127.0.0.1:4001
# → docs at  http://127.0.0.1:4001/docs
# → spec at  http://127.0.0.1:4001/openapi.json
```

For dev with watch:

```bash
PROJECT_DIR=/abs/path/to/your/app npm run dev
```

## Configuration

All via env vars (see `.env.example`):

| Var                  | Required | Default                      | Notes                                                                 |
| -------------------- | -------- | ---------------------------- | --------------------------------------------------------------------- |
| `PROJECT_DIR`        | yes      | —                            | cwd handed to pi; `.pi/skills/` discovery is rooted here              |
| `SESSIONS_DIR`       | no       | `$PROJECT_DIR/data/sessions` | where pi writes session JSONL files                                   |
| `AGENT_DIR`          | no       | Pi default                   | pi config/auth/models dir; falls back to `PI_CODING_AGENT_DIR` / `~/.pi/agent` |
| `AGENTS_FILE`        | no       | `.pi/AGENTS.md`              | system prompt file (relative to `PROJECT_DIR` or absolute)            |
| `ANTHROPIC_API_KEY`  | no       | —                            | injected into pi's AuthStorage; falls back to `~/.pi/agent/auth.json` |
| `PI_EXTENSION_PATHS` | no       | —                            | comma-separated temporary Pi extension/package sources (`npm:`, `git:`, or paths) |
| `PI_NO_EXTENSIONS`   | no       | false                        | disables project/global extension discovery except `PI_EXTENSION_PATHS` |
| `PI_NO_SKILLS`       | no       | false                        | disables project/global skill discovery                               |
| `PI_NO_PROMPTS`      | no       | false                        | disables project/global prompt template discovery                     |
| `PI_NO_THEMES`       | no       | false                        | disables project/global theme discovery                               |
| `LITELLM_BASE_URL`   | no       | —                            | when set, registers a `litellm` provider from `LITELLM_*` model envs  |
| `AGENT_SERVER_HOST`  | no       | `127.0.0.1`                  | bind host                                                             |
| `AGENT_SERVER_PORT`  | no       | `4001`                       | bind port                                                             |
| `AGENT_SERVER_TOKEN` | no       | —                            | if set, `/v1/*` requires `Authorization: Bearer <token>`              |

Auth is opt-in. Loopback-only + single-user dev → unset is fine. Set
`AGENT_SERVER_TOKEN` for shared hosts or any deployment where another local
process could reach the port.

## API

REST routes are defined with [Zod](https://zod.dev) via `@hono/zod-openapi`.
The OpenAPI 3.1 doc is the contract surface for consumers; types are
generated from it (see "Consuming from another app" below).

Mounted under `/v1`:

| Method | Path                       | Description                                           |
| ------ | -------------------------- | ----------------------------------------------------- |
| `GET`  | `/v1/sessions`             | List sessions (persisted + in-memory not yet flushed) |
| `POST` | `/v1/sessions`             | Create a new session                                  |
| `GET`  | `/v1/sessions/models`      | List selectable models and auth availability          |
| `GET`  | `/v1/sessions/{id}`        | Persisted message history                             |
| `GET`  | `/v1/sessions/{id}/settings` | Active model/thinking settings                      |
| `PATCH` | `/v1/sessions/{id}/settings` | Switch model and/or thinking while idle             |
| `GET`  | `/v1/sessions/{id}/events` | SSE stream of pi `AgentSessionEvent`s                 |
| `GET`  | `/v1/sessions/{id}/extension-ui` | Pending extension UI requests                    |
| `POST` | `/v1/sessions/{id}/extension-ui/{requestId}/response` | Resolve extension UI request     |
| `POST` | `/v1/sessions/{id}/prompt` | `{ text }` — send a user prompt                       |
| `POST` | `/v1/sessions/{id}/abort`  | Abort the in-flight run (no-op if idle)               |
| `GET`  | `/v1/healthz`              | Liveness + per-channel SSE subscriber counts          |

Plus:

- `GET /openapi.json` — OpenAPI 3.1 document
- `GET /docs` — Swagger UI

### SSE wire format

Each SSE event is `data: <json>` carrying a pi `AgentSessionEvent`. The
agent-server intentionally does not lock down a Zod schema for the union —
pi owns that contract, and consumers (the eventx frontend reducer)
interpret it directly. A `heartbeat` named event is sent every 15s; clients
using `EventSource` with a default `onmessage` handler ignore it.

Extension UI requests are also delivered on the same session SSE stream as
`{ "type": "extension_ui_request", ... }`. Blocking requests (`select`,
`confirm`, `input`, `editor`) are kept in memory until the browser answers
`POST /v1/sessions/{id}/extension-ui/{requestId}/response` with one of:

```json
{ "value": "chosen text" }
```

```json
{ "confirmed": true }
```

```json
{ "cancelled": true }
```

Clients should call `GET /v1/sessions/{id}/extension-ui` after connecting or
reconnecting so UI requests created before the SSE connection are not missed.

## Models and Thinking

`GET /v1/sessions/models` returns public, non-secret Pi model metadata:
provider, id, display name, API family, reasoning support, auth availability,
context window, max output tokens, and any configured default thinking level.

`PATCH /v1/sessions/{id}/settings` accepts:

```json
{ "provider": "anthropic", "modelId": "claude-sonnet-4-5", "thinkingLevel": "high" }
```

`thinkingLevel` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
The runtime rejects changes while a session is streaming with HTTP `409`.
Pi clamps valid but unsupported thinking levels to the selected model's
supported set and returns the effective level in the response.

### LiteLLM

When `LITELLM_BASE_URL` is set, the server registers a Pi provider named
`litellm`. Useful env vars:

- `LITELLM_API_KEY`
- `LITELLM_DEFAULT_MODEL`
- `LITELLM_MODELS` — comma-separated model ids
- `LITELLM_MODELS_JSON` — full per-model config, including `reasoning`,
  `thinkingLevelMap`, `defaultThinkingLevel`, `compat`, `api`, and token limits
- `LITELLM_DEFAULT_THINKING`
- `LITELLM_API` — `openai-completions`, `openai-responses`, or
  `anthropic-messages`

The runtime includes presets for `openai/gpt-5.5`,
`deepseek/deepseek-v4-pro`, and `deepseek/deepseek-v4-flash` so Appx-style
model/thinking controls work without project-local Pi `models.json` files.

## Extensions

Pi packages and extensions execute code in the agent process. Keep the default
configuration conservative, review package source before enabling it, and prefer
project-local `.pi/settings.json` or `PI_EXTENSION_PATHS` over global installs
for Appx-managed runtimes.

Practical candidates to close the OpenCode gap:

- `pi-webaio` — web search/fetch/crawl tooling, including Brave-style search,
  useful for app-building agents that need current docs.
- `@juicesharp/rpiv-web-tools` — web search/fetch with pluggable providers
  including Brave, Tavily, Serper, Exa, Jina, and Firecrawl.
- `rytswd/pi-agent-extensions/permission-gate` — a small permission-gate
  example for dangerous commands; use with the extension UI bridge.
- `@gotgenes/pi-permission-system` — permission enforcement package to review
  if Appx wants a fuller policy engine instead of a custom extension.

## Consuming from another app

Generate the static `openapi.json` once after a build, then feed it to
`openapi-typescript` (or any other generator) in the consuming app:

```bash
# in this repo
npm run build
npm run openapi          # writes ./openapi.json

# in the consuming app
npx openapi-typescript ../../agent-server/openapi.json -o src/generated/agent-server.d.ts
```

Then use `openapi-fetch` (or any client of your choice) with the generated
types. Example (eventx-backend):

```ts
import createClient from "openapi-fetch";
import type { paths } from "./generated/agent-server.js";

const client = createClient<paths>({ baseUrl: "http://127.0.0.1:4001" });
const { data, error } = await client.GET("/v1/sessions");
```

SSE is consumed separately (native `EventSource` in the browser, or piped
through the consumer backend with `fetch().body` streaming).

## Library mode (advanced)

If you'd rather embed the runtime inside your own Hono app:

```ts
import { Hono } from "hono";
import { AgentRuntime, createSessionsApp } from "@appx/agent-server";

const runtime = new AgentRuntime({ projectDir, sessionsDir, agentsFile });
const app = new Hono();
app.route("/v1", createSessionsApp(runtime));
```

This exists for tests and for hosts that have a strong reason to share a
process. The standalone server is the primary deployment.

## Pi specifics

See `apps/eventx/CLAUDE.md` "Pi specifics" section for the gotchas. Headlines:

- Pi writes session JSONL files lazily (on first `message_end`), so listing
  merges disk + live in-memory sessions.
- `text_delta` events carry chunks in `delta`; `partial` is the full message
  object, not a string.
- Tool result messages have `role: "toolResult"` and arrive after the
  tool-using assistant's `message_end`.

## Why Hono?

Schema-first OpenAPI (Zod is the single source of truth for validation,
types, and the published spec) and first-class SSE (`streamSSE` handles
abort propagation and keepalives properly). Plus one piece of forward-
looking leverage:

**Runtime portability.** Hono speaks Web Standards (`Request` /
`Response` / `ReadableStream`) and runs on Node, Bun, Deno, Workers, and
edge. Today we run on Node only via `@hono/node-server`. The realistic
future is **Bun**, because pi has first-class Bun support (`bun-binary`
install mode, `bun build --compile` recipe in pi's own `package.json`,
runtime detection via `isBunBinary` / `isBunRuntime`, WASM-path patching
for compiled binaries). That unlocks shipping pi + agent-server + an
app's skills as a single static executable per app, no Node on the host.

To migrate when we want it, replace the `serve()` call in
`src/server.ts` with a runtime-detect:

```ts
if (typeof globalThis.Bun !== "undefined") {
  globalThis.Bun.serve({ fetch: root.fetch, hostname: host, port });
} else {
  const { serve } = await import("@hono/node-server");
  serve({ fetch: root.fetch, hostname: host, port });
}
```

Plus a `dev:bun` script. Routes, schemas, runtime, and the broker are
already runtime-agnostic. Workers / Deno / edge are out regardless: pi
needs a filesystem to persist session JSONL.
