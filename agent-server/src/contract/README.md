# `contract/` — the published API contract

This directory is the **single source of truth for agent-server's typed surface**:
the REST DTOs, the SSE wire-event union, and the machinery that turns them into a
language-neutral `openapi.json`. Everything a downstream consumer (appx, lanquest,
eventx, …) codegens against originates here.

The guiding principle: **pi owns its shapes, agent-server owns and versions the
published contract, consumers codegen from `openapi.json` — nothing is
hand-mirrored.**

## How the types flow

```
pi TypeScript types ──┐
 (AgentSessionEvent,  │   typia (compile-time)        ┌─ openapi.json ─┐   openapi-typescript
  AssistantMessage…)  ├─▶ eventSchema.generated.json ─┤   (published   ├─▶ generated TS types
                      │                               │    contract)   │   + openapi-fetch client
 zod REST schemas ────┘   @hono/zod-openapi           └────────────────┘   (consumer side)
 (schemas.ts)
```

Two halves merge into one document:

1. **REST surface** — authored as zod in [`schemas.ts`](./schemas.ts) and turned
   into OpenAPI paths by `@hono/zod-openapi`. These schemas double as **runtime
   request/response validation** in the route handlers, so the contract and the
   validation can't diverge.
2. **SSE surface** — the `WireEvent` union in [`wireEvents.ts`](./wireEvents.ts)
   (= pi's `AgentSessionEvent` + the events agent-server injects). It is **not**
   hand-authored as a schema: `scripts/genEventSchema.ts` runs
   [typia](https://typia.io) over the TypeScript type to emit
   [`eventSchema.generated.json`](./eventSchema.generated.json) (committed), which
   [`openapiEventSchema.ts`](./openapiEventSchema.ts) merges into the document.

## Files

| File                         | Role                                                                                                                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemas.ts`                 | zod REST DTOs — runtime validation **and** OpenAPI source.                                                                                                                                                                   |
| `wireEvents.ts`              | The `WireEvent` SSE union (pi composition). The typia input — the SSE contract's source of truth.                                                                                                                            |
| `eventSchema.generated.json` | typia output for `WireEvent`. **Committed, generated — never edit by hand.**                                                                                                                                                 |
| `openapiEventSchema.ts`      | Merges the event schema into the doc and exposes `buildOpenApiDocument()` — the one function both the live server and the static dump use, so they can't drift. Also defines `OPENAPI_INFO` (title/**version**/description). |
| `openapi.ts`                 | Build-time dump: mounts the routes and writes the repo-root `openapi.json`. Thin wrapper over `buildOpenApiDocument()`.                                                                                                      |
| `eventValidation.ts`         | Runtime, tolerant classification of outgoing SSE events against the contract (`valid` / `unknown-type` / `invalid`). Observability/forward-compat only — events are forwarded regardless.                                    |

The published document is available two ways, always identical apart from the
`servers` block (the live endpoint advertises its address; the dump stays
host-agnostic):

- **Live:** `GET /openapi.json` (Swagger UI at `/docs`).
- **Static:** the committed `openapi.json` at the repo root.

## Manual commands

Regeneration is **not** part of the normal `tsc` build (typia needs the
ts-patch transform, so it only runs on demand). Run these after the source
types change:

```bash
# 1. After a pi upgrade OR any change to WireEvent (wireEvents.ts):
#    re-emit the typia event schema (needs ts-patch via `tspc`).
npm run gen:event-schema      # → src/contract/eventSchema.generated.json

# 2. After ANY contract change (zod schema, route, or step 1):
#    rebuild and dump the merged document.
npm run openapi               # → ./openapi.json
```

When you make an **intentional** breaking change, also bump `OPENAPI_INFO.version`
in `openapiEventSchema.ts` so consumers can pin and upgrade deliberately.

> The normal `npm run build` reads the already-committed
> `eventSchema.generated.json` (and copies it into `dist/`); it does **not**
> regenerate it.

## CI gates

`.github/workflows/contract.yml` protects `main` so drift is never silent:

- **Freshness** — regenerates both artifacts and fails if the committed
  `openapi.json` / `eventSchema.generated.json` are stale (i.e. you bumped pi or
  edited a route but forgot to regenerate + commit).
- **Breaking changes** — [`oasdiff`](https://github.com/oasdiff/oasdiff) diffs the
  PR's `openapi.json` against the base branch and fails on breaking changes,
  turning a pi-driven shape change into a reviewed, intentional event.

## How downstream consumers use it

The contract is language-neutral, so the canonical path is the same for every
consumer (lanquest, eventx, appx web clients, future non-TS SDKs):

**1. Vendor the contract** (commit the snapshot for reproducible builds):

```bash
# from a live server:
curl -s http://127.0.0.1:4001/openapi.json -o openapi/agent-server.json
# or copy the committed dump:
cp /path/to/agent-server/openapi.json openapi/agent-server.json
```

**2. Generate types** with [`openapi-typescript`](https://openapi-ts.dev):

```bash
openapi-typescript openapi/agent-server.json -o src/agent-server.generated.ts
```

**3. Consume** — reference the generated types and (for REST) drive a typed
client from the same `paths`, so request/response shapes are inferred and
contract-checked:

```ts
import createClient from "openapi-fetch";
import type { paths, components } from "./agent-server.generated";

const http = createClient<paths>({ baseUrl: "/agent" });
const { data } = await http.GET("/v1/projects"); // typed from the contract

type WireEvent = components["schemas"]["WireEvent"]; // SSE events (EventSource)
type AgentMessage = components["schemas"]["AgentMessage"];
```

> **Reference implementation:** `lanquest`'s `agent-chat-ui` package does exactly
> this — `npm run gen:api` regenerates the types, `core/types.ts` re-exports clean
> aliases over `components['schemas']`, and `core/client.ts` wraps `openapi-fetch`.
> Every route carries an `operationId`, so the generated `operations` map and any
> future multi-language SDK get stable, human-readable names.

**Node embedders** (hosts that mount agent-server's routes in their own process,
e.g. appx) can instead import types straight from the package — `src/index.ts`
re-exports the runtime DTOs and pi's `AgentSessionEvent`. Prefer the
`openapi.json` path for browser/SDK clients; it keeps consumers decoupled from
agent-server's internal TypeScript and enables non-TS SDKs.

## The one rule

Don't hand-write contract types in a consumer, and don't hand-edit
`eventSchema.generated.json`. Change the source (`schemas.ts` / `wireEvents.ts`),
regenerate, commit, let the CI gates classify the change, then re-vendor
downstream.
