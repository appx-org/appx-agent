# @appx-org/agent-protocol

The published API contract for [agent-server](../agent-server): the OpenAPI 3.1
document, the SSE wire-event JSON schema, and TypeScript types generated from
them. Anything that talks to agent-server over the wire — the React UI package
([agent-client](../agent-client)), the appx control plane, or any new
appx-like service — codegens or imports from this package instead of
hand-mirroring shapes.

## What's inside

| Export                                            | What it is                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| `paths`, `components`, `operations`               | Raw [openapi-typescript](https://github.com/openapi-ts/openapi-typescript) output — plug `paths` into `openapi-fetch` for a fully typed client. |
| `AgentProject`, `AgentSessionInfo`, `AgentModel`, … | Friendly aliases for the REST DTOs.                                             |
| `WireEvent`, `AssistantMessageEvent`, `AgentMessage`, … | The SSE event union and transcript shapes.                                      |
| `@appx-org/agent-protocol/openapi.json`           | The OpenAPI document itself — codegen for non-TS consumers (Go, Python, …).     |
| `@appx-org/agent-protocol/eventSchema.generated.json` | The typia-generated SSE event schema collection (root ref: `WireEvent`).        |

## Where the contents come from

Nothing in this package is hand-authored except the alias names in
`src/types.ts`. The pipeline (run from the repo root):

```
packages/agent-server zod schemas + pi types
  → npm run gen:contract           # at the repo root:
      gen:event-schema (typia)     # → eventSchema.generated.json (here)
      openapi (zod-openapi dump)   # → openapi.json (here)
      gen:types (openapi-typescript) # → src/schema.generated.ts (here)
```

All three artifacts are committed; CI regenerates them and fails if the
committed copies are stale, so what's published always matches what
agent-server serves at `/openapi.json`.

## Versioning

This package's semver version **is** the contract version. agent-server
declares which version it implements; consumers declare which they require.
