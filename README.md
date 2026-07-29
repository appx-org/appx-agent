# appx-agent

Monorepo for the appx agent stack — a Pi-SDK-based agent orchestration server,
its published API contract, and a customizable React UI for it.

| Package                                          | What it is                                                                                       | Ships as                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------- |
| [`packages/agent-server`](packages/agent-server) | HTTP/SSE orchestration server wrapping the [pi coding agent SDK](https://github.com/earendil-works/pi) | Docker image (private npm package)    |
| [`packages/agent-protocol`](packages/agent-protocol) | The published API contract: `openapi.json`, SSE event schema, generated TS types                 | `@appx-org/agent-protocol` (GitHub Packages) |
| [`packages/agent-client`](packages/agent-client) | Customizable React chat UI for agent-server                                                       | `@appx-org/agent-client` (GitHub Packages) |

Dependency direction: `agent-server → agent-protocol ← agent-client`. External
consumers (the appx Go control plane, other appx-like services) depend on the
published protocol package or the docker image — never on this repo's
internals.

## Development

```bash
npm install          # installs all workspaces
npm run build        # protocol → server → client
npm run typecheck    # tsc --noEmit in every workspace
npm test             # all workspace test suites
npm run check        # biome format + lint (writes safe fixes)
```

Run the server locally: see [packages/agent-server](packages/agent-server).

## The contract pipeline

agent-server's zod schemas + pi's TypeScript types are the source of truth.
Generated artifacts land in `packages/agent-protocol` and are committed:

```bash
npm run gen:contract
# = gen:event-schema (typia)     → packages/agent-protocol/eventSchema.generated.json
#   openapi (zod-openapi dump)   → packages/agent-protocol/openapi.json
#   gen:types (openapi-typescript) → packages/agent-protocol/src/schema.generated.ts
```

The pre-commit hook regenerates these when agent-server source is staged, and
CI (`contract.yml`) fails if the committed artifacts are stale. Details in
[packages/agent-server/src/contract/README.md](packages/agent-server/src/contract/README.md).

## Releasing

Versioning is driven by [changesets](https://github.com/changesets/changesets):

```bash
npx changeset        # describe the change, pick bump levels
```

Merging to main with pending changesets opens a "Version Packages" PR; merging
that publishes `agent-protocol` + `agent-client` to GitHub Packages
(`release.yml`). `agent-protocol`'s version **is** the wire-contract version —
agent-server's `/openapi.json` reports it, and consumers pin against it.
