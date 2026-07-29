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
npm run gen:contract # regenerate the published contract from agent-server's schemas
```

Run the server locally: see [packages/agent-server](packages/agent-server). How
the contract is generated and versioned:
[packages/agent-server/src/contract/README.md](packages/agent-server/src/contract/README.md).

## Releasing

Make a change, run `npx changeset`, commit both together. When you want to ship,
merge the "Version Packages" PR the bot keeps updated and accumulates the
changes into.

Merging it publishes `agent-protocol` + `agent-client` to GitHub Packages and
tags the agent-server image (`release.yml`, `docker.yml`).
`agent-protocol`'s version **is** the wire-contract version — agent-server's
`/openapi.json` reports it, and consumers pin against it.

> With no pending changesets, `release.yml` falls back to publishing any package
> whose local version isn't in the registry. Always land a changeset with a
> change you intend to release, so the version bump is deliberate.

### The agent-server image

`docker.yml` publishes `ghcr.io/appx-org/agent-server` on pushes to main that
touch code (docs-only commits are skipped):

| Tag             | When                                              |
| --------------- | ------------------------------------------------- |
| `edge`          | every code push to main — the tip of trunk        |
| `sha-<short>`   | every code push — immutable, for rollback         |
| `X.Y.Z`, `X.Y`, `latest` | only when `packages/agent-server/package.json`'s version changes |

agent-server is `private: true`, so changesets bumps its version (and writes its
changelog) without publishing an npm tarball — the manifest version is what
promotes an image from `edge` to a semver release.

```bash
docker pull ghcr.io/appx-org/agent-server:edge      # trunk
docker pull ghcr.io/appx-org/agent-server:0.1.3     # pinned release
```
