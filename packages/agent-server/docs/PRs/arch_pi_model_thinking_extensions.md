# Arch Doc — Pi Model, Thinking, Extensions, and Multi-Project Routing

> Branch: `codex/pi-model-thinking-extensions` vs `main`
> Scope: 12 commits, ~6,000 lines added across 14 files
> Generated: 2026-05-25

---

## Table of Contents

- [Arch Doc — Pi Model, Thinking, Extensions, and Multi-Project Routing](#arch-doc--pi-model-thinking-extensions-and-multi-project-routing)
  - [Table of Contents](#table-of-contents)
  - [1. Overview (plain-English)](#1-overview-plain-english)
    - [What was deliberately _not_ done](#what-was-deliberately-not-done)
  - [2. System Map](#2-system-map)
    - [2.1 High-level data flow](#21-high-level-data-flow)
    - [2.2 Mode comparison](#22-mode-comparison)
    - [2.3 New \& changed API endpoints](#23-new--changed-api-endpoints)
    - [2.4 OAuth subscription flow state machine](#24-oauth-subscription-flow-state-machine)
  - [3. Code Review Guide](#3-code-review-guide)
    - [3.1 `src/runtime.ts` — the heart of the change](#31-srcruntimets--the-heart-of-the-change)
    - [3.2 `src/runtimeRegistry.ts` (new)](#32-srcruntimeregistryts-new)
    - [3.3 `src/litellm.ts` (new)](#33-srclitellmts-new)
    - [3.4 `src/schemas.ts`](#34-srcschemasts)
    - [3.5 `src/routes.ts`](#35-srcroutests)
    - [3.6 `src/server.ts`](#36-srcserverts)
    - [3.7 `src/openapi.ts`, `src/index.ts`](#37-srcopenapits-srcindexts)
  - [4. Testing Guide](#4-testing-guide)
    - [4.1 Automated coverage (`test/server.test.ts`)](#41-automated-coverage-testservertestts)
    - [4.2 Manual verification checklist](#42-manual-verification-checklist)
  - [5. Architecture \& Code Pitfalls](#5-architecture--code-pitfalls)
  - [6. Fixed Pitfalls](#6-fixed-pitfalls)
  - [7. TODOs \& Future Improvements](#7-todos--future-improvements)

---

## 1. Overview (plain-English)

This PR turns `agent-server` from a **single-tenant Pi wrapper** into a **multi-tenant agent runtime hub** that powers both standalone apps (Eventx-style, one process per project) _and_ a shared Appx host (one process serving many project workspaces).

The work decomposes into five conceptually distinct features that landed in sequence:

1. **Model + thinking-level controls.** Sessions can now switch between models and adjust the Pi "thinking level" (`off → xhigh`) at runtime. The runtime exposes which models are available, which thinking levels each model supports, and clamps unsupported requests to the nearest valid level. A new `PATCH /v1/sessions/{id}/settings` endpoint drives this from the frontend, rejected with `409` while the agent is streaming.

2. **Pi extension bridge.** Pi extensions can request UI interactions (`select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`, `setTitle`, …). The runtime forwards these as `extension_ui_request` events on the session SSE stream, and the browser answers via `POST /v1/sessions/{id}/extension-ui/{requestId}/response`. Resource overlays (`PI_EXTENSION_PATHS`, `PI_SKILL_PATHS`, `PI_PROMPT_PATHS`, `PI_THEME_PATHS`) and discovery toggles (`PI_NO_*`) let app hosts pin or sandbox what Pi loads at startup.

3. **Provider auth, OAuth flows, and custom providers.** What used to be "drop your `ANTHROPIC_API_KEY` in env" is now a full credential surface: list providers, store/delete API keys, run an OAuth subscription login (Anthropic, OpenAI Codex, etc.), and define custom OpenAI-compatible providers in `models.json`. The OAuth flow is a small in-memory state machine with progress, prompt, and manual-redirect-paste callbacks; subscription tokens never leave the server.

4. **LiteLLM integration.** Setting `LITELLM_BASE_URL` (+ `LITELLM_*` env vars) registers a `litellm` Pi provider with hardcoded presets for `openai/gpt-5.5`, `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash`. Per-model thinking maps, default thinking levels, and OpenAI-compatible quirks (`thinkingFormat`, `supportsReasoningEffort`, `maxTokensField`) are all configurable via env JSON.

5. **Multi-project mode.** `AGENT_SERVER_MODE=multi` adds a route split: shared auth/model state stays at `/v1/{auth,custom,...}`, per-project sessions live under `/v1/projects/{projectId}/...`, and the project's working directory is supplied by Appx via the `X-Appx-Project-Dir` header (trusted because Appx validates `projectId` first). An `AgentRuntimeRegistry` lazily creates one `AgentRuntime` per project, all sharing one `AuthStorage` + `ModelRegistry`, but each with its own `sessionsDir` (`<projectDir>/data/sessions`) and `.pi/AGENTS.md` system prompt.

The unifying design choice: **one shared credentials/model surface, many project-scoped session runtimes**. This is what makes Appx workable — users authenticate Anthropic once, but their sessions remain isolated per project workspace.

### What was deliberately _not_ done

- Pi's `AgentSessionEvent` union is **not** locked into a Zod schema. Pi owns that contract; duplicating it here would drift. The SSE endpoint is documented as opaque `text/event-stream`.
- The OAuth flow does not persist state across restarts. Flows are short-lived (10 min expiry) and live entirely in memory; this matches Pi's own login UX where pressing F5 cancels.
- The custom-provider `models.json` writer doesn't merge — it replaces a provider's entire entry on `PUT`. Calling code must re-send all models.

---

## 2. System Map

### 2.1 High-level data flow

```
                                              ┌────────────────────────┐
                                              │  Pi SDK                │
                                              │  - AuthStorage         │
                                              │  - ModelRegistry       │
                                              │  - AgentSession        │
                                              │  - SessionManager      │
                                              │  - ResourceLoader      │
                                              └───────────┬────────────┘
                                                          │
                                                          ▼
┌─────────────┐  HTTP   ┌─────────────┐    ┌─────────────────────────────┐
│ Frontend /  │────────▶│ server.ts   │───▶│ AgentRuntimeRegistry  [NEW] │
│ Appx host   │  SSE    │ (entrypoint)│    │  - shared AuthStorage       │
└─────────────┘◀────────│  [UPDATED]  │    │  - shared ModelRegistry     │
                        └──────┬──────┘    │  - default + per-project    │
                               │           │    AgentRuntime instances   │
                               │           └──────────────┬──────────────┘
                               │                          │
                               ▼                          ▼
                        ┌─────────────┐          ┌──────────────────────┐
                        │ routes.ts   │─────────▶│ AgentRuntime         │
                        │ [UPDATED]   │          │  [HEAVILY UPDATED]   │
                        │ - sessions  │          │  - sessions/models   │
                        │ - auth      │          │  - extension UI      │
                        │ - custom    │          │  - OAuth flows       │
                        │ - extension │          │  - custom providers  │
                        │   UI        │          │  - thinking clamp    │
                        └──────┬──────┘          └──────────┬───────────┘
                               │                            │ events
                               ▼                            ▼
                        ┌──────────────┐            ┌───────────────┐
                        │ sseBroker.ts │◀───────────│  publish()    │
                        │ (unchanged)  │            └───────────────┘
                        └──────────────┘
```

### 2.2 Mode comparison

```
SINGLE MODE  (AGENT_SERVER_MODE=single, default)
─────────────────────────────────────────────────────────
   /v1/sessions              → defaultRuntime
   /v1/sessions/{id}/...     → defaultRuntime
   /v1/auth/...              → defaultRuntime
   /v1/custom/...            → defaultRuntime
   /v1/healthz               → defaultRuntime

MULTI MODE   (AGENT_SERVER_MODE=multi)
─────────────────────────────────────────────────────────
   /v1/auth/...              → defaultRuntime  (shared creds)
   /v1/custom/...            → defaultRuntime  (shared models.json)
   /v1/healthz               → defaultRuntime
   /v1/projects/{id}/sessions...
                             → registry.forProject({
                                  id, projectDir: header
                                })
                             → per-project AgentRuntime
                                (own sessionsDir,
                                 own AGENTS.md,
                                 shared AuthStorage,
                                 shared ModelRegistry)
```

### 2.3 New & changed API endpoints

All endpoints are mounted under `/v1` (or `/v1/projects/{projectId}` in multi mode for session-scoped routes).

| Method     | Path                                                   | Tag        | Purpose                                                           |
| ---------- | ------------------------------------------------------ | ---------- | ----------------------------------------------------------------- |
| GET        | `/sessions`                                            | sessions   | List sessions (existed; extended to merge in-memory + on-disk)    |
| POST       | `/sessions`                                            | sessions   | Create new session (existed)                                      |
| GET        | `/sessions/{id}`                                       | sessions   | Persisted history (existed)                                       |
| GET        | `/sessions/{id}/events`                                | sessions   | SSE stream (existed; now also delivers extension UI requests)     |
| POST       | `/sessions/{id}/prompt`                                | sessions   | Send user prompt (existed; new `steer` semantics while streaming) |
| POST       | `/sessions/{id}/abort`                                 | sessions   | Abort run (existed)                                               |
| **GET**    | **`/sessions/models`**                                 | models     | List all models with availability + thinking metadata             |
| **GET**    | **`/sessions/{id}/settings`**                          | models     | Active model + thinking level                                     |
| **PATCH**  | **`/sessions/{id}/settings`**                          | models     | Switch model and/or thinking level (409 if streaming)             |
| **GET**    | **`/sessions/{id}/extension-ui`**                      | extensions | Pending extension UI requests (catch-up after reconnect)          |
| **POST**   | **`/sessions/{id}/extension-ui/{requestId}/response`** | extensions | Resolve extension UI request                                      |
| **GET**    | **`/auth/providers`**                                  | auth       | Non-secret provider auth status                                   |
| **PUT**    | **`/auth/providers/{provider}/api-key`**               | auth       | Store API key in Pi auth storage                                  |
| **DELETE** | **`/auth/providers/{provider}`**                       | auth       | Remove stored credential                                          |
| **POST**   | **`/auth/providers/{provider}/subscription/start`**    | auth       | Begin OAuth login flow                                            |
| **GET**    | **`/auth/subscription/{flowId}`**                      | auth       | Read OAuth flow state                                             |
| **POST**   | **`/auth/subscription/{flowId}/continue`**             | auth       | Submit prompt input or pasted redirect URL                        |
| **DELETE** | **`/auth/subscription/{flowId}`**                      | auth       | Cancel OAuth flow                                                 |
| **GET**    | **`/custom/providers`**                                | models     | List `models.json` custom providers                               |
| **PUT**    | **`/custom/providers`**                                | models     | Create/update custom provider                                     |
| **DELETE** | **`/custom/providers/{provider}`**                     | models     | Remove custom provider                                            |
| GET        | `/healthz`                                             | meta       | Liveness + per-channel SSE counts (existed)                       |

**Bold** = new in this PR.

### 2.4 OAuth subscription flow state machine

```
   ┌──────────┐
   │ starting │  flow created, awaiting Pi callback
   └─────┬────┘
         │ Pi calls onAuth(url, instructions)
         ▼
   ┌──────┐                      onPrompt(prompt)
   │ auth │──────────────────────────────────────────┐
   └──┬───┘                                           ▼
      │                                       ┌────────────┐
      │ user pastes manual redirect URL       │   prompt   │
      │ (or Pi's local callback returns)      │ (input req)│
      │                                       └─────┬──────┘
      ▼                                             │
   ┌─────────┐                                      │
   │ waiting │◀─────────────────────────────────────┘
   └────┬────┘     POST /continue resolves
        │
        │ Pi login() resolves → Pi writes auth.json
        ▼
   ┌──────────┐    on error: ┌───────┐    on cancel: ┌───────────┐
   │ complete │              │ error │               │ cancelled │
   └──────────┘              └───────┘               └───────────┘
        │                        │                        │
        └────────────┬───────────┴────────────────────────┘
                     ▼
              60s cleanup timer (10min for inactive flows)
              flow evicted from `pendingOAuthFlows`
```

`activeOAuthFlowForProvider()` short-circuits a re-entrant `start` if a non-terminal, non-expired flow already exists for that provider — fixes the "second start kills first" footgun (commit `edd6d6f`).

---

## 3. Code Review Guide

Walk top-to-bottom. Each file's section starts with **why it changed**, then key decisions, then specific things to verify.

### 3.1 `src/runtime.ts` — the heart of the change

**Size:** 305 → 1257 lines. This is where ~75% of the new logic lives.

**Why it changed.** The runtime grew four new responsibilities: (a) model/thinking-level management with clamping; (b) extension UI bridge; (c) provider auth + OAuth flow management; (d) custom-provider `models.json` CRUD.

**Key decisions:**

- **Shared `AuthStorage` / `ModelRegistry`.** The constructor now accepts `authStorage` and `modelRegistry` from the registry instead of always allocating its own. This is what makes "one shared credential surface" work: every per-project runtime points at the same auth file, so `PUT /auth/providers/anthropic/api-key` once and every project sees it (`runtime.ts:320, 349`).

- **Thinking-level clamping** (`runtime.ts:368–391`). Pi advertises which thinking levels a model supports via `thinkingLevelMap` (`null` means unsupported). When the user requests `xhigh` on a model that only supports up to `high`, we clamp upward first, then downward. The default for a non-reasoning model is always `["off"]`. **Verify:** the search order (`requestedIndex → end`, then `requestedIndex-1 → 0`, then `available[0]`) — does it ever return `undefined` if the model has zero supported levels? It guards with `?? "off"` at line 390, but reasoning models with `thinkingLevelMap: { off: null, ... }` could plausibly return `[]`. Worth a defensive test.

- **`makeResourceLoader()` per session** (`runtime.ts:445–471`). Pi's SDK builds a default loader if you don't pass one. We always pass our own so we can suppress ancestor `AGENTS.md` discovery (`noContextFiles: this.systemPrompt !== undefined`). A new loader per session is fine — Pi creates one anyway. **Verify:** is `loader.reload()` cheap enough on every `createNewSession` / `ensureSession`? If extension/skill paths are large this could matter.

- **Extension UI bridge** (`runtime.ts:473–621`). `createExtensionUiContext` returns the full `ExtensionUIContext` Pi expects. Blocking dialogs (`select`, `confirm`, `input`, `editor`) build a Promise, register in `pendingExtensionUi`, publish an `extension_ui_request` SSE event, and resolve when the browser POSTs back. Non-blocking effects (`notify`, `setStatus`, `setWidget`, `setTitle`, `pasteToEditor`, `setEditorText`) are fire-and-forget publishes. Theme/working-message/footer/header are stubbed because the agent-server has no UI of its own.

- **`createDialogPromise` cleanup is defensive** (`runtime.ts:486–515`). Both `timeout` and `signal` cancel paths route through the same `finish` lambda, which checks `pendingExtensionUi.has(id)` before resolving — this prevents the same Promise from resolving twice if the timeout and the response race.

- **OAuth flow state machine** (`runtime.ts:869–1062`). One `PendingOAuthFlow` entry per active flow. `version` increments on every state mutation; `waitForOAuthFlowUpdate` resolves the next time `version` advances or after 15s. This is what makes the GET-state polling pattern work without thundering retries.

- **`activeOAuthFlowForProvider`** (`runtime.ts:900–909`). When the user re-clicks "Sign in with Anthropic" while a flow is already in flight, we return the existing flow instead of starting a new one. **Why:** Pi's `login()` opens a local HTTP listener on a fixed port — calling it twice gets `EADDRINUSE`. Without this, the second click would kill the first flow.

- **`oauthLoginErrorMessage`** (`runtime.ts:911–917`). String-matches `EADDRINUSE` to produce a friendlier message. **Fragile by design** — Pi or Node could change the message format. There's a test for the current format (`server.test.ts:462`).

- **`models.json` permissions** (`runtime.ts:1078–1081`). Writes are followed by `chmodSync(..., 0o600)`. Pi expects this for credential files; without it, Pi may refuse to load. **Verify on Windows:** `chmodSync` is a no-op on NTFS, but neither is the world-readable threat — fine in practice, worth knowing.

- **Prompt steering** (`runtime.ts:1228–1242`). When the agent is mid-stream, `prompt()` is called with `streamingBehavior: "steer"`. This interrupts the current assistant turn at the next tool boundary instead of waiting for it to fully stop (`"followUp"`). Equivalent to `session.steer(text)`. The comment in the code is critical context for anyone reading this for the first time.

**What to verify in this file:**

- Concurrency: two simultaneous `setSessionModel()` calls on the same id — both check `isStreaming` first, but neither holds a lock. Could one set the model and the other get a stale `false` for `isStreaming` before sending a prompt? Mitigated because Pi's `setModel` is sync-ish and `isStreaming` flips inside Pi's prompt path, but worth thinking through.
- The `live` map (`runtime.ts:290`) has no eviction. Long-running multi-project hosts will accumulate sessions. The `// todo: rename to liveSessions` is a hint there's pending work here.
- `assertProviderId` (`runtime.ts:857–861`) regex `^[a-zA-Z0-9_.:-]+$` — note `:` is allowed for provider URIs like `npm:foo`. Anthropic-style ids only need `a-z0-9-`. The regex is the right level of permissive but reviewer should confirm there's no path injection risk via crafted provider names downstream.

### 3.2 `src/runtimeRegistry.ts` (new)

121 lines. The simplest "factory + cache" pattern for the multi-project mode.

**What it does:**

- Builds one `AuthStorage` + one `ModelRegistry` for the host (line 57–62).
- Eagerly creates a `defaultRuntime` against the configured `projectDir`.
- Lazily creates per-project runtimes on `forProject({ id, projectDir })`, keyed by `id`.

**Key decisions:**

- `defaultAgentsFile: false` lets multi-project hosts opt out of loading an `AGENTS.md` for the default runtime — useful when the host's `PROJECT_DIR` is just a placeholder root and only project-scoped runtimes have real prompts (`runtimeRegistry.ts:52, 87–91`).
- Project session dirs are forced under `<projectDir>/data/sessions` rather than the global `sessionsDir`. The default runtime keeps its configured `sessionsDir` (line 104–107).
- `projectExtensionPaths` defaults to `[".pi/extensions/appx-guardrails.ts"]` — a forward-looking convention so Appx can ship a permission-gating extension into every project without each app having to opt in (line 52, 92–95). Currently a no-op unless the file exists.

**What to verify:**

- Cache key is just `context.id` (line 76). If two requests claim the same `id` but different `projectDir`, the second creates a new runtime and replaces the cached one (line 77 `existing?.projectDir === projectDir`). Trust here flows from "Appx validates `projectId` first" — if that ever changes, this cache could be poisoned via header. Worth a sanity check in the Appx middleware.
- No eviction of unused project runtimes. Long-lived processes will hold one set of session maps per project ever touched.

### 3.3 `src/litellm.ts` (new)

495 lines. Translates `LITELLM_*` env vars into a Pi provider config.

**What it does:** lazily resolves a `ResolvedLiteLlmConfig` from environment, registers a `litellm` provider with the `ModelRegistry`, and seeds the runtime's default model + thinking level.

**Key decisions:**

- **Module-level cache** (`cachedConfig`). Mutated in tests via `resetLiteLlmConfigForTests`. Idempotent at startup so `logLiteLlmStartupConfig()` and `litellmRuntimeConfig()` don't re-parse.
- **Hardcoded presets** for `openai/gpt-5.5` and DeepSeek V4 (lines 131–161). These bake in non-trivial provider quirks (thinkingFormat, max_tokens field name, OpenAI Responses API vs Completions). Reasonable for this stage but coupling — a new model means editing this file.
- **Compat layering** (`modelCompat`, line 199): provider compat → preset compat → model compat. Each layer overrides earlier. This is how `LITELLM_COMPAT_JSON` (provider-wide) interacts with `LITELLM_MODELS_JSON` (per-model `compat` field).
- **`litellmRequestHint`** (lines 339–372) is a debug aid that prints the actual thinking field that will be sent on the wire (`reasoning.effort=high`, `enable_thinking=true`, etc.) for each thinkingFormat. Logged at startup so on-call can see whether the env produces the expected request shape.

**What to verify:**

- Throws thrown from `parseModels` (line 311–313 in `LITELLM_MODELS_JSON` parsing) crash startup. This is intentional — bad config should fail loudly — but the surrounding `logLiteLlmStartupConfig()` wraps a single `resolveLiteLlmConfig()` so the throw bubbles. Confirmed: `server.ts:113` is called _before_ the registry, so a bad config exits cleanly.
- `clampThinkingLevel` is duplicated here (lines 250–263) and in `runtime.ts` (`clampThinkingLevelForModel`). Logic is identical. Acceptable duplication for module decoupling, but a refactor opportunity.

### 3.4 `src/schemas.ts`

92 → 267 lines. New Zod schemas for every new endpoint listed in §2.3. No surprises — they mirror the runtime types in `runtime.ts`.

The one thing worth noting: `ExtensionUiResponseRequestSchema` is a Zod **union** of three exclusive shapes:

```ts
z.union([
  z.object({ value: z.string() }),
  z.object({ confirmed: z.boolean() }),
  z.object({ cancelled: z.literal(true) }),
]);
```

This means `{ cancelled: false }` is rejected — the response schema only accepts `cancelled: true`. The runtime's `ExtensionUiResponse` type is wider than the wire schema; the schema is intentionally narrow. **Verify:** the frontend doesn't ever send `{ cancelled: false }` thinking that means "not cancelled".

### 3.5 `src/routes.ts`

298 → 866 lines. Mostly mechanical: each new schema gets a `createRoute` definition + a thin handler that calls into the runtime.

**Key decisions:**

- `AgentRuntimeResolver` (`routes.ts:76`). The runtime can be passed as a function `(c: Context) => AgentRuntime | Promise<AgentRuntime>` instead of an instance — this is what powers project-scoped routes that derive the runtime from request headers (`server.ts:133`).
- `CreateSessionsAppOptions` (`routes.ts:77–87`). Three booleans toggle whole route groups: `credentialRoutes`, `sessionRoutes`, `healthRoute`. In multi mode, `/v1` mounts with `sessionRoutes: false` and `/v1/projects/:projectId` mounts with `credentialRoutes: false, healthRoute: false`. This lets the same factory build both ends of the split.
- `settingsErrorStatus` (`routes.ts:95–101`) maps runtime errors to HTTP codes by **string-matching** `"not found"` / `"running"` / `"No API key"`. Fragile, see §5.
- The PATCH settings handler (`routes.ts:564–571`) does its own input validation — `provider` and `modelId` must come together, and at least one of `provider`/`thinkingLevel` must be present. The Zod schema doesn't express this XOR, so it lives in the handler.
- The SSE endpoint stays a plain Hono handler (lines 802–862) with `openAPIRegistry.registerPath` for documentation only. The streaming queue/wakeup pattern is unchanged from before — events queue while the writer is parked, the writer drains on each wakeup.
- After connecting, the SSE handler immediately replays `pendingExtensionUiRequests(id)` (line 834). This matters because the agent may have raised an extension dialog before the browser reconnected; without replay the user would see no prompt.

**What to verify:**

- Prompt is fire-and-forget (`routes.ts:708`). Errors only log to console — they don't reach the SSE stream. If the agent throws synchronously inside `sendPrompt` after passing `ensureExtensionsReady`, the user sees nothing. Pi events should cover the streaming-error path, but a synchronous throw before stream start could be silent.
- `abort` returns 404 on any error (`routes.ts:741`). If the runtime throws "session not found" the 404 is right; any other error also gets 404. Probably wrong but low-impact.

### 3.6 `src/server.ts`

122 → 237 lines. New responsibilities: parse `AGENT_SERVER_MODE`, parse all the new `PI_*` env lists, choose between single-mount and split-mount.

**Key decisions:**

- `parseMode` accepts aliases (`single`/`standalone`, `multi`/`multi-project`/`appx`). Defensive but not strictly necessary — could simplify.
- `projectRuntimeFromRequest` reads `X-Appx-Project-Dir` and `X-Appx-Project-Name` headers. These are **trusted** because the comment at line 13 explicitly says Appx validates `projectId` first. The error handler (line 167–173) maps any thrown "project context required" to a 400.
- LiteLLM startup is logged before registry construction (line 113) so the operator can see model/thinking config independently of whether the registry succeeds.
- The root handler (line 210–223) advertises which session path applies (`/v1/sessions` vs `/v1/projects/:projectId/sessions`) — useful for consumers that hit `/` to discover.

**What to verify:**

- If `AGENT_SERVER_TOKEN` is set, the bearer middleware applies to **all** `/v1/*` including the project-scoped routes. Confirmed at line 153–162. Good.
- The hard-coded magic header `x-appx-project-dir` is referenced in three places (`server.ts:135`, `runtimeRegistry.ts` indirectly, `test/server.test.ts`). Worth a `const APPX_PROJECT_DIR_HEADER` if it grows further.

### 3.7 `src/openapi.ts`, `src/index.ts`

Both small, mechanical updates:

- `openapi.ts` now respects `AGENT_SERVER_MODE` so `npm run openapi` can emit either spec variant (lines 18–44). This is what consumers like eventx-backend run at build time.
- `index.ts` re-exports `AgentRuntimeRegistry`, `litellm` helpers, and the new types so library-mode embedders (the Hono-style example in the README) can wire it up.

---

## 4. Testing Guide

### 4.1 Automated coverage (`test/server.test.ts`)

The single test file gained ~520 lines. Five describe blocks:

| Block                     | What it covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LiteLLM config`          | Parse `LITELLM_MODELS_JSON`, verify preset compat (gpt-5.5 → openai-responses, reasoning=true, thinkingFormat=openai), confirm default thinking is clamped (`high → xhigh` for gpt-5.5). Restores env between tests via a `Map<key, prev>` snapshot (good pattern).                                                                                                                                                                                                                                                                                             |
| `REST surface`            | Health, list/create sessions, models endpoint, **provider auth API** (PUT key, list, DELETE — asserts secrets never appear in any response body), **OAuth flow** (start, continue with manual code, complete; asserts access tokens never leak), **OAuth flow reuse** (two starts return the same flowId; `loginCalls === 1`), **OAuth port-conflict error message**, **custom provider CRUD**, **PATCH settings** (happy path + 400 on incomplete pairs), 404 on unknown id, 400 on empty prompt body, OpenAPI doc paths, extension-ui pending/response stubs. |
| `project-scoped runtimes` | Multi-mode route split: confirms `/v1/sessions` 404s when `sessionRoutes: false`, project auth routes 404 when `credentialRoutes: false`, project-scoped sessions are isolated by `X-Appx-Project-Dir`.                                                                                                                                                                                                                                                                                                                                                         |
| `bearer auth seam`        | 401 without/wrong token, 200 with right token, `/openapi.json` stays open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `SSE`                     | Connect → "connected to" frame, publish synthetic event, fan-out to two subscribers. Heartbeat path is implicitly covered by the connected-frame timing.                                                                                                                                                                                                                                                                                                                                                                                                        |

**Helpful test infra:** `makeProject()` builds a scratch tmpdir with `.pi/AGENTS.md` and `data/sessions/`. `pickPort()` binds to 0 to grab a free port. The runtime is constructed with a no-op logger to keep test output clean.

**Coverage gaps worth noting:**

- No test for `xhigh → high` clamping when switching to a model that doesn't advertise xhigh.
- No test for the `setSessionModelInternal` fallback that auto-picks the new model's default thinking when the previous level is unsupported.
- No test for the SSE replay of pending extension UI requests on reconnect.
- No test for two simultaneous `PATCH settings` while `isStreaming` is true (race).

### 4.2 Manual verification checklist

Run `PROJECT_DIR=/some/test/repo npm run dev` in one terminal. Use a second terminal for curl.

```
[ ] 1. GET /v1/healthz → { ok: true, channels: {} }
[ ] 2. GET /v1/auth/providers → list includes anthropic, openai, etc.
[ ] 3. PUT /v1/auth/providers/anthropic/api-key { key: "sk-ant-..." } → ok
[ ] 4. GET /v1/auth/providers → anthropic.configured=true, source="stored"
[ ] 5. POST /v1/sessions → returns { id, createdAt }
[ ] 6. GET /v1/sessions/{id}/settings → returns model+thinking metadata
[ ] 7. PATCH .../settings { thinkingLevel: "high" } → 200, level=high
[ ] 8. PATCH .../settings { thinkingLevel: "xhigh" } on a model w/o xhigh
       → 200, level clamped to highest supported
[ ] 9. POST .../prompt { text: "hello" } → 200, then GET .../events sees
       message_start / text_delta frames within ~5s
[ ] 10. While step 9 is streaming, POST another prompt → succeeds via "steer"
[ ] 11. PATCH .../settings while streaming → 409 conflict
[ ] 12. POST .../abort while streaming → 200, stream emits abort/end events
[ ] 13. DELETE /v1/auth/providers/anthropic → ok
[ ] 14. POST /v1/auth/providers/anthropic/subscription/start → status="auth"
        with authUrl. Open the URL, complete login. (Or: paste a fake URL via
        /continue to reach error="…" path)
[ ] 15. POST /v1/auth/providers/anthropic/subscription/start a second time
        before the first finishes → returns the SAME flowId (reuse path)
[ ] 16. PUT /v1/custom/providers { provider: "litellm-test", baseUrl: ...,
        api: "openai-completions", apiKey: "...", models: [{ id: "..." }] }
        → 200, listed in /v1/custom/providers, model appears in
        /v1/sessions/models with available=true
[ ] 17. GET /openapi.json → contains all 18 paths from the test assertion
[ ] 18. AGENT_SERVER_MODE=multi run, then GET /v1/sessions → 404
        GET /v1/projects/foo/sessions with X-Appx-Project-Dir header → 200
[ ] 19. AGENT_SERVER_TOKEN=secret restart, GET /v1/sessions without auth → 401
        with `Authorization: Bearer secret` → 200
        GET /openapi.json without auth → 200 (codegen surface stays open)
```

For the extension UI bridge, the easiest manual test is to install Pi's
`permission-gate` example via `PI_EXTENSION_PATHS` and trigger a confirm
dialog — the SSE stream should emit an `extension_ui_request` and the
runtime should accept the response POST.

---

## 5. Architecture & Code Pitfalls

| #   | Location                                                | Severity | Problem                                                                                                                                                                                                                                                                                         | Fix sketch                                                                                                                                |
| --- | ------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `routes.ts:95–101` `settingsErrorStatus`                | medium   | Maps errors to HTTP codes via `message.includes("not found")`, `"running"`, `"No API key"`. Fragile against runtime message tweaks.                                                                                                                                                             | Throw typed errors (e.g. `class SessionNotFoundError extends Error`) and switch on instance.                                              |
| 2   | `routes.ts:741` abort handler                           | low      | Any error from `abortSession` becomes 404, even if the cause is internal.                                                                                                                                                                                                                       | Pattern-match on the message like settings does, or distinguish via typed errors.                                                         |
| 3   | `runtime.ts:911–917` `oauthLoginErrorMessage`           | medium   | String-matches `EADDRINUSE` from Node's error message. If Node changes the format, the friendly message disappears (the test at `server.test.ts:506` then breaks).                                                                                                                              | Inspect `error.code` if available; keep substring as fallback.                                                                            |
| 4   | `runtime.ts:1189–1196` `setSessionModel`                | medium   | `isStreaming` is checked then `setModel` is called without a lock. Concurrent PATCH + prompt requests could observe stale state.                                                                                                                                                                | Add a per-session async mutex around all state mutations.                                                                                 |
| 5   | `runtimeRegistry.ts:76–82` cache                        | low      | Cache key is `context.id` only; replacing a runtime via different `projectDir` orphans old in-memory sessions.                                                                                                                                                                                  | Reject mismatched `projectDir` for the same `id`, or include `projectDir` in the key. Trust assumption is documented but worth hardening. |
| 6   | `runtime.ts:290` `live` map                             | low      | Never evicted. Long-running multi-project hosts grow without bound.                                                                                                                                                                                                                             | LRU or idle-timeout eviction; preserve session JSONL on disk so reopening is cheap.                                                       |
| 7   | `runtime.ts:1078–1081` `writeModelsJson`                | low      | Truncates and rewrites the entire file on every upsert. Concurrent writes (two PUTs at once) interleave.                                                                                                                                                                                        | Use a per-file mutex or atomic rename (`writeFileSync` to tmp + `renameSync`).                                                            |
| 8   | `runtime.ts:708` (createNewSession returns `createdAt`) | low      | `createdAt: new Date().toISOString()` is generated client-side here, not by Pi. The `listSessions` merge later sorts by ISO string but on-disk metadata uses Pi's own `info.created`. Sub-second skew between server boot and Pi's `Date.now()` is harmless, but be aware these are two clocks. | Acceptable; document the contract.                                                                                                        |
| 9   | `litellm.ts` clamp duplication                          | low      | `clampThinkingLevel` exists here and in `runtime.ts`.                                                                                                                                                                                                                                           | Move to a shared `thinking.ts` helper.                                                                                                    |
| 10  | `runtime.ts:368–391` `supportedThinkingLevelsForModel`  | low      | A reasoning model whose `thinkingLevelMap` sets every level to `null` returns `[]`. The clamping function falls back to `"off"` even though `"off"` was explicitly disabled.                                                                                                                    | Validate at registration: a reasoning model must support at least one non-null level.                                                     |
| 11  | Hardcoded `x-appx-project-dir` header                   | low      | Spelled inline in `server.ts` and `test/server.test.ts`. Easy to typo.                                                                                                                                                                                                                          | Extract `const APPX_PROJECT_DIR_HEADER = "x-appx-project-dir"` and import.                                                                |
| 12  | `routes.ts:708` fire-and-forget prompt                  | medium   | `runtime.sendPrompt(id, text).catch(console.error)` — if it throws synchronously before the SSE loop sees any event, the user gets no signal.                                                                                                                                                   | Capture the error and publish it as a synthetic event onto the session channel.                                                           |

---

## 6. Fixed Pitfalls

These were caught during this PR's commit history. Listed because the resulting code looks odd without context.

> **Problem (`6839e4e`):** Extensions started loading inside `createAgentSession`, but Pi's `createAgentSession` returns _before_ `bindExtensions` finishes. A racing prompt could be sent before extensions were ready.
> **Fix:** `bind()` records `extensionsReady: Promise<void>` (`runtime.ts:646–671`); `sendPrompt` awaits it (`runtime.ts:1231`).

> **Problem (`edd6d6f`):** Calling `POST /auth/providers/{p}/subscription/start` twice for the same provider tried to start a second Pi `login()`, which triggered `EADDRINUSE` on the OAuth callback port.
> **Fix:** `activeOAuthFlowForProvider` (`runtime.ts:900–909`) returns the existing flow for non-terminal, non-expired flows. Tested at `server.test.ts:387`.

> **Problem (`aa3851e`):** `GET /v1/sessions/{id}` with an unknown id returned 200 with `messages: []` because `getSessionMessages` couldn't distinguish "no session" from "empty session".
> **Fix:** Return `null` when the session doesn't exist; the route maps `null` → 404 (`routes.ts:606`).

> **Problem (`5e93fae`):** `npm exec agent-server` failed because `dist/server.js` wasn't marked executable in the npm package, even though `bin` was set in `package.json`.
> **Fix:** Add the shebang `#!/usr/bin/env node` (`server.ts:1`) so npm marks it executable on install.

> **Problem (`6112c2b`):** Pi SDK floats minor versions; an upstream patch broke `bindExtensions` signature mid-development.
> **Fix:** Pin to `0.75.4` exactly in `package.json:26`.

---

## 7. TODOs & Future Improvements

**Explicit TODOs in code:**

- `runtime.ts:290` — `// todo: rename to liveSessions`. Trivial cosmetic.

**Known limitations (deliberate):**

- OAuth flows don't survive process restart. Acceptable because flows are short-lived (10 min), but if Appx ever wants resumable login it'll need a small JSON store.
- `models.json` writes aren't atomic. Single-user assumption holds; concurrent UI edits are not a current scenario.
- Extension UI bridge has no audit log. If an extension prompts the user for sensitive input, no record exists outside Pi's own session JSONL.
- Multi-project mode trusts `X-Appx-Project-Dir` header completely. Documented contract: Appx must validate `projectId` before forwarding. Worth re-checking when this is integrated.

**Forward-looking scaffolding present but inactive:**

- `projectExtensionPaths: [".pi/extensions/appx-guardrails.ts"]` (`runtimeRegistry.ts:52`) is a forward hook for a future Appx-shipped permission gate. No-op until that file lands.
- `index.ts` re-exports `subscribe`, `publish`, `channelStats` from the SSE broker (`index.ts:34`). This is for hosts that want to publish their own events on session channels (e.g. cron updates, telegram messages — see broker comment).

**Suggested next steps (post-merge):**

1. Replace string-match error mapping with typed errors (Pitfall #1, #2, #3).
2. Add an idle-eviction policy to the live-session map (Pitfall #6).
3. Atomic write for `models.json` (Pitfall #7).
4. Extract a `thinking.ts` shared helper for clamp/levels logic (Pitfall #9).
5. Plumb `prompt`-handler errors back as synthetic SSE events (Pitfall #12).
6. Consider adding a small integration test that drives a real Pi extension's `confirm` dialog through the bridge end-to-end.
