# @appx-org/agent-client

> **Do not use `0.1.0`.** That tarball shipped without `dist/`, so every import
> fails to resolve. Install `0.1.1` or later.

A customizable React UI for the [appx **agent-server**](../agent-server)
— streaming chat, session management, tool-call cards, extension-UI prompts, and
model/thinking controls. Transport-agnostic and themeable, so the same package
powers different apps (lanquest, quest, appx, …) with project-specific styling
and layout.

Lives in the **appx-agent monorepo** next to [agent-server](../agent-server)
and [@appx-org/agent-protocol](../agent-protocol) (the published contract this
package's types come from). Consumers depend on it by version from the
registry (CI/prod), and link it locally for live editing during development
(see **Local development across repos** below).

## Install

Published to GitHub Packages under the `@appx-org` scope. Consumers add a scope
registry mapping (`.npmrc`):

```
@appx-org:registry=https://npm.pkg.github.com
```

then `npm i @appx-org/agent-client`. Peer deps: `react >=18`, `react-dom >=18`.

## Local development across repos

The package builds to `dist/` (`exports` → `dist`, types included) but still
ships `src/` in the tarball for source maps and IDE navigation. To edit it live
from a sibling app (e.g. lanquest) without publishing, point the app at this
checkout with a `file:` dependency (run `npm run build` here after edits, or
`tsc -w`):

```jsonc
// consumer app package.json (path relative to that package.json)
"@appx-org/agent-client": "file:../../../../appx-dir/appx-agent/packages/agent-client"
```

Because `react`/`react-dom` are **peer** deps, the consumer must dedupe React so
the symlink doesn't pull a second copy (which breaks hooks). In Vite:

```ts
resolve: { dedupe: ['react', 'react-dom'] }
```

Edits to `src/` are then picked up on the consumer's next build/HMR — no
republish, no reinstall. For CI/prod, swap the `file:` spec back to a semver
range (`^0.1.0`).

## Quick start

```tsx
import { AgentChatProvider, AgentChat } from 'agent-client';
import 'agent-client/styles.css';

export function App() {
  return (
    <AgentChatProvider config={{ baseUrl: '/agent', pathPrefix: '/v1' }}>
      <AgentChat projectId="my-project" />
    </AgentChatProvider>
  );
}
```

`baseUrl` + `pathPrefix` point at the agent-server `/v1` contract. Use the
agent-server origin directly (`baseUrl: 'http://127.0.0.1:4001'`) or, recommended,
a same-origin reverse proxy that mirrors `/v1` (so the bearer token and cookies
stay server-side — see lanquest's backend).

## Architecture

Two layers:

- **`core/`** (framework-agnostic) — `AgentClient` (configurable transport,
  backed by [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/) so request
  bodies, path params, and response types are inferred from the contract),
  `SessionStore` (shared SSE pool + reducer dispatch), and the pure
  `sessionReducer` that turns SSE events / REST history into `UiMessage[]`.
  Contract types come from
  [`@appx-org/agent-protocol`](../agent-protocol) — **generated** from
  agent-server's `openapi.json`, never hand-written — and are re-exported via
  `core/types.ts` alongside the UI-derived types.
- **`react/`** — `AgentChatProvider` (DI for client + store + theme),
  `useAgentSession` hook, and components: `AgentChat`, `ChatPanel`,
  `SessionList`, `ToolCallCard`, `ExtensionRequestPanel`, `Markdown`.

## Regenerating the agent-server types

The REST DTOs and the SSE event/message types (`WireEvent`, `ToolCall`,
`AssistantMessage`, …) come from `@appx-org/agent-protocol`, codegen'd from
agent-server's `openapi.json`, so they stay in sync with the contract and
there's no field-name guessing in the reducer. After an agent-server contract
change, regenerate from the repo root:

```bash
npm run gen:contract   # typia event schema → openapi.json → openapi-typescript types
```

If a committed contract field changed, the generated types shift and
`core/types.ts`, the reducer, or the `AgentClient` REST calls fail to compile —
the intended drift signal. Because the REST methods are typed against the
generated `paths` via `openapi-fetch`, a changed response/param/body shape
surfaces directly at the call site (no hand-written return types to keep in
sync). Run `npm run typecheck` to surface it. Every route also carries an
`operationId`, so the generated `operations` map and any future SDK codegen get
stable, human-readable names.

## Customization

1. **CSS variables** — every value resolves to an `--ac-*` custom property.
   Re-theme by redefining them on a wrapper:
   ```css
   .agent-client-root { --ac-accent: #c084fc; --ac-bg: #1a1226; }
   ```
2. **`classNames` / `labels`** — pass per-slot class names and string overrides
   to `AgentChatProvider`.
3. **Render slots** — `ChatPanel` accepts `renderMessage`, `renderEmpty`,
   `showHeader`, `showModelControls`.
4. **Composition** — for fully bespoke layouts, drop `AgentChat` and compose
   `SessionList` + `ChatPanel`, or build directly on `useAgentSession`.

## Client config

```ts
createAgentClient({
  baseUrl?: string;        // default '' (same origin)
  pathPrefix?: string;     // default '/v1'
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  fetch?: typeof fetch;
  eventSourceFactory?: (url: string) => EventSourceLike;
  onUnauthorized?: () => void;
});
```
