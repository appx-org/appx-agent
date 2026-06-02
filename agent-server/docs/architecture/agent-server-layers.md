# agent-server runtime layers: Registry / Runtime / Session

How `ProjectRegistry`, `ProjectRuntime`, and `ProjectSession` relate inside a single agent-server process, and how the mode (`single` vs `multi`) only affects the routing edge — not the layers themselves.

## In simple terms

Three nested layers, each with one job:

| Class | "It owns…" | "There is one per…" |
|---|---|---|
| **`ProjectRegistry`** | The shared org-global state (LLM keys, model catalog, credentials service) and a directory of project runtimes | **process** |
| **`ProjectRuntime`** | Everything scoped to one project (project dir, sessions dir, the loaded extensions/skills/themes for that project, the in-memory map of live sessions) | **project** |
| **`ProjectSession`** | One conversation with the agent — its `AgentSession`, its event stream, its pending extension-UI prompts, prompt/abort/settings ops | **chat session** |

Said like a Russian doll: **Registry contains Runtimes, Runtime contains Sessions.** A request always lands on a session, which lives in a runtime, which is found in the registry.

You can map it 1:1 to the URL surface:

- `/v1/auth/*`, `/v1/custom/*` → **Registry** (org-level, mode-independent)
- `/v1/.../sessions` (POST/GET list) → **Runtime** (project-level)
- `/v1/.../sessions/{id}/...` → **Session** (conversation-level)

## Static structure (mode-independent)

```
┌────────────────────────────────────────────────────────────────┐
│  agent-server process (one per organisation)                   │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  ProjectRegistry                                    │  │
│  │  ────────────────────────                                │  │
│  │  • AuthStorage           ┐                               │  │
│  │  • ModelRegistry         │ shared, process-global        │  │
│  │  • AgentCredentialsService                               │  │
│  │                                                          │  │
│  │  • defaultRuntime  ─────────► ProjectRuntime "default"   │  │
│  │  • runtimes: Map<id, ProjectRuntime>                     │  │
│  │      ├─ "eventx"   ───────► ProjectRuntime "eventx"      │  │
│  │      ├─ "todoapp"  ───────► ProjectRuntime "todoapp"     │  │
│  │      └─ ...                                              │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌─── ProjectRuntime "eventx" ────────────────────────────┐    │
│  │  • projectDir = /workspace/eventx                      │    │
│  │  • sessionsDir = /workspace/eventx/data/sessions       │    │
│  │  • AgentSessionServices (extensions/skills/themes,     │    │
│  │     loaded once per project, reused across sessions)   │    │
│  │  • SessionManager (reads/writes JSONL session files)   │    │
│  │  • sessions: Map<sessionId, ProjectSession>            │    │
│  │      ├─ "abc-123" ─► ProjectSession                    │    │
│  │      └─ "def-456" ─► ProjectSession                    │    │
│  │                                                        │    │
│  │  exposes: createNewSession() / getSession() /          │    │
│  │           listSessions()                               │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                │
│  ┌─── ProjectSession "abc-123" ───────────────────────────┐    │
│  │  • session: AgentSession  (Pi-SDK object, the actual   │    │
│  │     LLM conversation + tool runner)                    │    │
│  │  • forwards AgentSessionEvents → sseBroker(sessionId)  │    │
│  │  • pending extension-UI requests (Map<reqId, ...>)     │    │
│  │                                                        │    │
│  │  exposes: sendPrompt() / abort() / getMessages() /     │    │
│  │           getModelSettings() / updateModelSettings() / │    │
│  │           resolveExtensionUiRequest()                  │    │
│  └────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────┘
```

Two important properties this layout encodes:

1. **`AuthStorage` and `ModelRegistry` live in the Registry, not in each Runtime.** The Runtime *holds references* to them but doesn't own them. That's the technical reason a single set of LLM keys covers every project — the registry hands the same instances to every `ProjectRuntime` it builds via the private `buildRuntime()` helper.
2. **Runtimes own session *files*; ProjectSessions own session *behaviour*.** The runtime can list/load sessions from disk without instantiating a `ProjectSession` for each one (cheap listing). It only constructs a `ProjectSession` when something actually needs to act on it (`getSession(id)` lazily reopens, `createNewSession()` makes a fresh one). The `Map<sessionId, ProjectSession>` is the *live* set, not the persisted set.

## How the modes change this

Punchline up front: **the mode only changes how a request reaches a `ProjectRuntime`. The Registry → Runtime → Session structure is identical.** Mode is a routing concern, not a runtime concern.

### Single mode

```
HTTP request                Hono routing                    Runtime resolution
─────────────────────       ─────────────────────────       ──────────────────────
GET /v1/sessions/abc/...    /v1                             registry.defaultRuntime
                              └─ createSessionsApp(           (built eagerly at boot
                                   registry.defaultRuntime)    from PROJECT_DIR)
                                                             │
                                                             ▼
                                                       ProjectRuntime "default"
                                                             │
                                                             ▼
                                                       ProjectSession "abc"
```

- `registry.defaultRuntime` is **built eagerly in `ProjectRegistry.create()`** from the boot-time `PROJECT_DIR`.
- `registry.runtimes` map is **never populated** in single mode (you can think of it as dead code in this configuration).
- `defaultAgentsFile` falls through to `agentsFile` (`.pi/AGENTS.md`), so the default runtime auto-loads the project's prompt.
- Every request goes to the same `ProjectRuntime`. There is no per-request runtime resolution.

### Multi mode

```
HTTP request                              Hono routing                     Runtime resolution
─────────────────────────────────────     ─────────────────────────        ────────────────────────────
GET /v1/projects/eventx/sessions/abc      /v1/projects/:projectId          registry.forProject({
   x-appx-project-dir: /workspace/eventx    └─ createSessionsApp(            id: "eventx",
                                                projectRuntimeFromRequest)   projectDir: header
                                                                           })
                                                                            │
                                                                            ▼  (cache miss → buildRuntime)
                                                                          ProjectRuntime "eventx"
                                                                            │
                                                                            ▼
                                                                          ProjectSession "abc"
```

- `registry.runtimes` is populated **lazily** as projects are first touched.
- `registry.defaultRuntime` still exists but **isn't reached by session routes** — it's effectively a placeholder that owns the shared services config. Credential routes don't need it (they go through `registry.credentials` directly).
- `defaultAgentsFile: false` is set, so the default runtime is built without auto-loading an `AGENTS.md`. Each per-project runtime loads its own from `<projectDir>/.pi/AGENTS.md` instead.
- Per-project runtimes use `<projectDir>/data/sessions` for their session files (see `buildRuntime`'s `sessionsDir` ternary), keeping each project's chat history self-contained.
- The credentials surface (`/v1/auth/*`, `/v1/custom/*`) is still mounted on the registry's `credentials` service, identically to single mode — credentials are org-global, not project-scoped.

### Side-by-side

```
                       SINGLE MODE                          MULTI MODE
                       ─────────────                        ──────────────
Registry layer:        same                                 same
                       (AuthStorage, ModelRegistry,         (AuthStorage, ModelRegistry,
                        AgentCredentialsService)             AgentCredentialsService)

Mounting:              /v1/sessions  ─►  defaultRuntime     /v1/projects/:projectId/sessions
                                                              │
                                                              ▼  resolver reads x-appx-project-dir
                                                            registry.forProject(...)

Runtimes used:         exactly one (defaultRuntime)         many (one per project, lazy)

defaultRuntime         project root (PROJECT_DIR)           a host-root placeholder, unused
points at:                                                  by session routes

AGENTS.md loading:     default runtime auto-loads it        default runtime skips it;
                       (defaultAgentsFile: undefined)       each per-project runtime loads
                                                            its own (defaultAgentsFile: false)

Session storage path:  config.sessionsDir                   <projectDir>/data/sessions per project
                       (typically PROJECT_DIR/data/...)

ProjectRuntime API:    only `createNewSession`,             `forProject(...)` is also used
used                   `getSession`, `listSessions`         (Registry-level)

ProjectSession:        identical                            identical
```

## The mental shortcut

If you only remember one thing:

> **Registry is the org. Runtime is the project. Session is the conversation.**
> **Mode picks how URLs map to Runtimes — not how the layers themselves work.**

That's why the file `projectRegistry.ts` is the only one that actually has different behavior between modes (via the `defaultRuntime` vs `forProject` split and the `defaultAgentsFile` flag), and why `projectRuntime.ts` and `projectSession.ts` don't even reference modes — they're purely below the mode boundary.
