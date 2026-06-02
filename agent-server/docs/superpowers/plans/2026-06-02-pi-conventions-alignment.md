# Plan: Align agent-server with Pi's project conventions

**Date:** 2026-06-02
**Status:** Drafted

## Goal

Eliminate the special-casing around the "default" runtime by adopting Pi's
two-tier filesystem convention uniformly across every `ProjectRuntime`
(default and per-project). This:

1. Removes the `defaultAgentsFile` flag and the `context.id === "default"`
   branch in `buildRuntime()`.
2. Reduces env-var surface — operators set `PROJECT_DIR` and we derive
   everything else from `<projectDir>/.pi/`.
3. Fixes the existing FIXME in `projectRegistry.ts` about sessions
   landing in `data/sessions/` instead of under `.pi/`.
4. Makes single and multi modes structurally identical at the registry
   level. The only remaining mode difference is *where `projectDir`
   comes from* (boot env vs request header) — the actual trust-boundary
   distinction we want to keep.

## Convention

| Tier | Location | Owner | Contents |
|---|---|---|---|
| **Org-shared (`agentDir`)** | `~/.pi/agent/` | process-global, every runtime references the same instances | `auth.json`, `models.json` |
| **Project (`piDir`)** | `<projectDir>/.pi/` | per-runtime — **including the default runtime** | `AGENTS.md`, `sessions/`, `skills/`, `extensions/`, `settings.json` |

Key point: agent-server's contract has only **two locations** — a
shared org tier (just credentials + model registry, the genuinely
org-scoped state) and a per-runtime project tier. Everything
project-local, even for the default runtime, lives under that
runtime's `<projectDir>/.pi/`. Pi additionally auto-discovers
user-level resources from `~/.pi/agent/skills/`, `~/.agents/skills/`,
etc. if a user has them lying around — agent-server inherits that for
free but does not prescribe or rely on it.

The default runtime is no longer structurally special — its `projectDir`
just happens to be set from boot env (`PROJECT_DIR`) instead of a
request header. In multi mode the host root's `.pi/` is typically
empty; nothing loads, the org-shared tier handles auth/models, and the
runtime is never routed to anyway.

## Semantic change worth flagging

`agentsFile` semantics split into "explicit" vs "convention default":

- **Explicitly configured** (`config.agentsFile` set, or test fixture
  passes a path): missing file is a **fatal** startup error. Preserves
  "misconfiguration is loud".
- **Convention default** (`config.agentsFile` unset, falls back to
  `<projectDir>/.pi/AGENTS.md`): missing file is a **silent skip**. The
  runtime starts with no pinned prompt and Pi's normal context-file
  discovery (suppressed only when a prompt is pinned) takes over.

This replaces the current `defaultAgentsFile: false` kill switch.

## Code changes

### `src/runtime/projectRuntime.ts`

- `ProjectRuntimeConfig.sessionsDir` → optional. Default
  `<projectDir>/.pi/sessions/`.
- `ProjectRuntimeConfig.agentsFile` stays optional but with two-mode
  semantics above.
- `readPinnedSystemPrompt()` → `resolveSystemPrompt()`: when explicit,
  read & throw on missing; when default, `existsSync` check first,
  return `undefined` if absent. Doc the split.

### `src/runtime/projectRegistry.ts`

- Drop `defaultAgentsFile` field on `ProjectRegistryConfig`.
- Drop `projectExtensionPaths` field — Pi already auto-discovers
  `.pi/extensions/` from `cwd`, so the
  `[".pi/extensions/appx-guardrails.ts"]` default is redundant. Keep
  the comment elsewhere if we ever need to re-add explicit injection.
- Drop the `context.id === "default"` branches in `buildRuntime()` for
  both `agentsFile` and `sessionsDir`. Default and per-project runtimes
  call `ProjectRuntime.create()` with identical config shape.
- `sessionsDir` no longer threaded through the registry — runtime
  derives.

### `src/config.ts`

Clean break (private package, controlled consumers):

- Drop env vars: `SESSIONS_DIR`, `AGENTS_FILE`.
- Keep: `PROJECT_DIR` (required), `AGENT_DIR` (test/CI override of the
  global tier), `PI_EXTENSION_PATHS` / `PI_SKILL_PATHS` /
  `PI_PROMPT_PATHS` / `PI_THEME_PATHS` (operator-level *additional*
  overlays, distinct from auto-discovery), `PI_NO_*`, server vars.
- Drop `agentsFile`, `sessionsDir` fields on `ServerConfig`.

### `src/server.ts`

- Stop passing `agentsFile`, `sessionsDir`, `defaultAgentsFile` to
  `ProjectRegistry.create()`.
- Update startup logs to reflect the convention (log
  `<projectDir>/.pi/` once instead of separate paths).
- Mode-branching for route mounting unchanged (`/v1/sessions` vs
  `/v1/projects/:projectId/sessions`).

### `src/openapi.ts`

- Drop `defaultAgentsFile: false`. Stub registry only needs
  `projectDir` + a silent logger.

## Tests

### `test/server.test.ts`

- `startServer()`: drop `sessionsDir` and `agentsFile`. Keep
  `agentDir: <project>/.pi-agent` for per-test global-tier isolation.
- Multi-mode test (line 765+): drop `defaultAgentsFile: false` and
  `sessionsDir`. The host-root `.pi/AGENTS.md` happens to exist in
  `makeProject()` so the default runtime will load a prompt — that's
  fine, it's never routed to.
- Project-isolation test (line 814+): drop `sessionsDir` and
  `agentsFile`.
- Per-project session storage test now uses `<projectDir>/.pi/sessions`
  (transparent to the test — it just hits the API).

### `test/projectRuntimeServices.test.ts`

- Drop explicit `sessionsDir` and `agentsFile` from happy-path tests
  (rely on convention).
- Keep the `agentsFile: ".pi/does-not-exist.md"` test — it validates
  the **explicit-override fatal** path.
- Add: convention-default silent-skip test. Build a project *without*
  `.pi/AGENTS.md`, assert `ProjectRuntime.create()` succeeds and
  `services.diagnostics` doesn't contain a prompt-load error.

## Docs

- README.md: env table loses `SESSIONS_DIR`, `AGENTS_FILE`. Add a short
  "Filesystem layout" subsection. Update library-mode example (drop
  `defaultAgentsFile`, drop `sessionsDir`).
- `docs/architecture/agent-server-layers.md`: update the table that
  mentions `PROJECT_DIR/data/...` for sessions.
- `docs/misc/other/single-vs-multi-mode.md`: simplify the registry-API
  table — no more `defaultAgentsFile` row.

## Migration note for operators

Existing deployments with sessions under `<projectDir>/data/sessions/`
will appear to lose history after upgrade because the runtime now
reads from `<projectDir>/.pi/sessions/`. One-line migration:

```bash
mkdir -p "$PROJECT_DIR/.pi"
mv "$PROJECT_DIR/data/sessions" "$PROJECT_DIR/.pi/sessions"
```

To call out in README. `AGENTS.md` placement is unchanged
(`.pi/AGENTS.md` was already the documented default).

## Out of scope

- Renaming `agentDir` (Pi's term, kept).
- Touching extension discovery beyond removing the redundant
  `projectExtensionPaths` default.
- Project-creation endpoint (separate FIXME on `server.ts:63`).
