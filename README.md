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

> Note: with no pending changesets, `release.yml` falls back to publishing any
> package whose local version isn't in the registry. Always land a changeset
> with a change you intend to release, so the version bump is deliberate.

#### Before merging a Version Packages PR

`changeset version` only rewrites `package.json` files and changelogs. Two
committed artifacts derive from those versions and must be refreshed in the
same PR, or the merge publishes from a stale tree:

```bash
git checkout changeset-release/main
npm install --package-lock-only   # lockfile records workspace versions
npm run gen:contract              # openapi.json embeds agent-protocol's version
git commit -am "Refresh lockfile + contract for the release"
```

Both are enforced in CI (`ci.yml` lockfile check, `contract.yml` freshness
gate), so a forgotten refresh fails the PR rather than reaching the registry.
Note that `npm ci` alone does **not** catch lockfile drift for workspace
packages — they're symlinks, so it installs happily and the unsatisfied link
only surfaces later, mid-publish.

#### The `RELEASE_TOKEN` secret

The org forbids GitHub Actions from creating pull requests, so opening the
"Version Packages" PR needs a token that acts as a *user*. `release.yml` uses
the `RELEASE_TOKEN` repo secret: a **fine-grained PAT**, scoped to this
repository only, with exactly two repository permissions:

| Permission      | Access       | Why                                       |
| --------------- | ------------ | ----------------------------------------- |
| Contents        | Read & write | Commit + push the `changeset-release/main` branch |
| Pull requests   | Read & write | Open and update the Version Packages PR   |

Deliberately **not** granted: package write (the default `GITHUB_TOKEN` handles
registry publishing), and anything resembling PR *approval* — so branch review
can never be self-served by CI.

If the secret is missing or expired, releases degrade gracefully rather than
break: version-mode still pushes `changeset-release/main`, and only the PR
creation fails, so you can open the PR by hand:

```bash
gh pr create --base main --head changeset-release/main --title "Version Packages"
```

### The agent-server image

`docker.yml` publishes `ghcr.io/appx-org/agent-server` on every push to main:

| Tag             | When                                              |
| --------------- | ------------------------------------------------- |
| `edge`          | every push to main — the tip of trunk             |
| `sha-<short>`   | every push — immutable, for rollback              |
| `X.Y.Z`, `X.Y`, `latest` | only when `packages/agent-server/package.json`'s version changes |

agent-server is `private: true`, so changesets bumps its version (and writes its
changelog) without publishing an npm tarball — the manifest version is what
promotes an image from `edge` to a semver release.

```bash
docker pull ghcr.io/appx-org/agent-server:edge      # trunk
docker pull ghcr.io/appx-org/agent-server:0.1.0     # pinned release
```
