# `contract/` — the published API contract

This directory is the **single source of truth for agent-server's typed surface**:
the REST DTOs, the SSE wire-event union, and the machinery that turns them into a
language-neutral `openapi.json`. The generated artifacts land in (and are
published from) [`packages/agent-protocol`](../../../agent-protocol) — everything
a downstream consumer (appx, lanquest, eventx, …) codegens against originates
here and ships there.

The guiding principle: **pi owns its shapes, agent-server owns the contract
sources, `@appx-org/agent-protocol` publishes and versions the artifacts,
consumers codegen from them — nothing is hand-mirrored.**

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
| `openapiEventSchema.ts`      | Merges the event schema into the doc and exposes `buildOpenApiDocument()` — the one function both the live server and the static dump use, so they can't drift. Also defines `OPENAPI_INFO` (title/description; the contract **version** is agent-protocol's package version). |
| `openapi.ts`                 | Build-time dump: mounts the routes and writes `packages/agent-protocol/openapi.json`. Thin wrapper over `buildOpenApiDocument()`.                                                                                            |
| `eventValidation.ts`         | Runtime, tolerant classification of outgoing SSE events against the contract (`valid` / `unknown-type` / `invalid`). Observability/forward-compat only — events are forwarded regardless.                                    |

The generated artifacts (`openapi.json`, `eventSchema.generated.json`, and the
openapi-typescript output) live in `packages/agent-protocol` — committed,
generated, never edited by hand. agent-server itself consumes the event schema
from `@appx-org/agent-protocol` at runtime.

The published document is available two ways, always identical apart from the
`servers` block (the live endpoint advertises its address; the dump stays
host-agnostic):

- **Live:** `GET /openapi.json` (Swagger UI at `/docs`).
- **Static:** the committed `packages/agent-protocol/openapi.json` (ships in the npm tarball).

## Manual commands

Regeneration is **not** part of the normal `tsc` build (typia needs the
ts-patch transform, so it only runs on demand). Run these after the source
types change:

```bash
# After a pi upgrade or ANY contract change (zod schema, route, WireEvent):
# regenerate the whole pipeline from the repo root —
#   gen:event-schema (typia) → openapi dump → openapi-typescript types,
# all landing in packages/agent-protocol.
npm run gen:contract
```

When you make an **intentional** breaking change, bump
`packages/agent-protocol`'s version (via a changeset) so consumers can pin and
upgrade deliberately.

> The normal `npm run build` reads the already-committed artifacts from
> `@appx-org/agent-protocol`; it does **not** regenerate them.

## CI gates

The **Contract artifacts are fresh** step in `.github/workflows/ci.yml`
regenerates the artifacts and fails if the committed copies differ — catching
both "bumped pi or edited a route but forgot to regenerate" and a release that
bumps agent-protocol's version without refreshing `openapi.json`'s
`info.version`.

Not yet enabled: a **breaking-change** gate using
[`oasdiff`](https://github.com/oasdiff/oasdiff) to diff a PR's `openapi.json`
against the base branch and fail on breaking changes (`fail-on: ERR`), turning a
pi-driven shape change into a reviewed, intentional event. Worth adding once the
contract has external consumers pinning against it.

## How downstream consumers use it

The contract is language-neutral, so the canonical path is the same for every
consumer (lanquest, eventx, appx web clients, future non-TS SDKs):

**TypeScript consumers** install `@appx-org/agent-protocol` and import the
generated `paths` / `components` (or the friendly aliases) directly:

```ts
import createClient from "openapi-fetch";
import type { paths, AgentProject, WireEvent, AgentMessage } from "@appx-org/agent-protocol";

const http = createClient<paths>({ baseUrl: "/agent" });
const { data } = await http.GET("/v1/projects"); // typed from the contract
```

> **Reference implementation:** [`packages/agent-client`](../../../agent-client)
> does exactly this — its `core/client.ts` wraps `openapi-fetch` with the
> protocol's `paths`. Every route carries an `operationId`, so the generated
> `operations` map and any future multi-language SDK get stable, human-readable
> names.

**Non-TypeScript consumers** (e.g. appx's Go control plane) codegen from the
JSON artifacts the tarball ships: `@appx-org/agent-protocol/openapi.json` and
`.../eventSchema.generated.json` — or fetch `/openapi.json` from a live server.

## The one rule

Don't hand-write contract types in a consumer, and don't hand-edit the
generated artifacts in `packages/agent-protocol`. Change the source
(`schemas.ts` / `wireEvents.ts`), run `npm run gen:contract`, commit, let the
CI gates classify the change, then release agent-protocol.
