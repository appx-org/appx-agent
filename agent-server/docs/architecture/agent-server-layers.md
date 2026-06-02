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
│  │  • runtimes: Map<id, ProjectRuntime>                     │  │
│  │      ├─ "default"  ───────► ProjectRuntime (single mode) │  │
│  │      ├─ "eventx"   ───────► ProjectRuntime "eventx"      │  │
│  │      ├─ "todoapp"  ───────► ProjectRuntime "todoapp"     │  │
│  │      └─ ...                                              │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌─── ProjectRuntime "eventx" ────────────────────────────┐    │
│  │  • projectDir = /workspace/eventx                      │    │
│  │  • sessionsDir = /workspace/eventx/.pi/sessions        │    │
│  │  • piDir       = /workspace/eventx/.pi                 │    │
│  │     (AGENTS.md, sessions/, skills/, extensions/)       │    │
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

1. **`AuthStorage` and `ModelRegistry` live in the Registry, not in any Runtime.** Runtimes *hold references* to them but don't own them. That's the technical reason a single set of LLM keys covers every project — the registry hands the same instances to every `ProjectRuntime` it builds via the private `buildRuntime()` helper.
2. **There is no eager `defaultRuntime`.** Single mode boots by awaiting `registry.forProject({ id: "default", projectDir: PROJECT_DIR })` once and mounting routes against the result. Multi mode skips that call entirely — it doesn't need it. Mode awareness lives in `server.ts`'s routing block, not in the registry.
3. **Runtimes own session *files*; ProjectSessions own session *behaviour*.** The runtime can list/load sessions from disk without instantiating a `ProjectSession` for each one (cheap listing). It only constructs a `ProjectSession` when something actually needs to act on it (`getSession(id)` lazily reopens, `createNewSession()` makes a fresh one). The `Map<sessionId, ProjectSession>` is the *live* set, not the persisted set.

## How the modes change this

Punchline up front: **the mode only changes how a request reaches a `ProjectRuntime`. The Registry → Runtime → Session structure is identical.** Mode is a routing concern, not a runtime concern.

### Single mode

```
HTTP request                Hono routing                    Runtime resolution
─────────────────────       ─────────────────────────       ──────────────────────
GET /v1/sessions/abc/...    /v1                             runtime captured at boot via
                              └─ createSessionsApp(           registry.forProject({
                                   defaultRuntime)              id: "default",
                                                                projectDir: PROJECT_DIR
                                                              })
                                                             │
                                                             ▼
                                                       ProjectRuntime "default"
                                                             │
                                                             ▼
                                                       ProjectSession "abc"
```

- Single mode awaits `registry.forProject({ id: "default", projectDir: PROJECT_DIR })` **once at boot** and mounts session routes against the result. The runtime is then cached in `registry.runtimes` under id `"default"`.
- The runtime follows Pi's project convention: it auto-loads `<PROJECT_DIR>/.pi/AGENTS.md` if present, silently skips it if absent. Sessions land in `<PROJECT_DIR>/.pi/sessions/`.
- Every request goes to that same `ProjectRuntime`. There is no per-request runtime resolution.

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
- There is **no eager default runtime built** — multi mode skips that work entirely. The registry just sets up `AuthStorage`/`ModelRegistry`/`AgentCredentialsService` and stops. The first session request for a project lazily builds that project's runtime.
- Per-project runtimes use `<projectDir>/.pi/sessions/` for their session files, keeping each project's chat history self-contained.
- The credentials surface (`/v1/auth/*`, `/v1/custom/*`) is mounted on the registry's `credentials` service directly, identically to single mode — credentials are org-global, not project-scoped, and don't depend on any runtime existing.

### Side-by-side

```
                       SINGLE MODE                          MULTI MODE
                       ─────────────                        ──────────────
Registry layer:        same                                 same
                       (AuthStorage, ModelRegistry,         (AuthStorage, ModelRegistry,
                        AgentCredentialsService)             AgentCredentialsService)

Mounting:              boot: forProject({"default"})       /v1/projects/:projectId/sessions
                       → createSessionsApp(runtime)          │
                       /v1/sessions ─► runtime                ▼  resolver reads x-appx-project-dir
                                                            registry.forProject(...)

Runtimes used:         exactly one (built at boot)          many (one per project, lazy)

Registry's runtime     {"default": runtime}                 {"eventx": ..., "todoapp": ..., ...}
map entries:

AGENTS.md loading:     <PROJECT_DIR>/.pi/AGENTS.md         <projectDir>/.pi/AGENTS.md per project
                       (silent skip if missing)            (silent skip if missing)

Session storage path:  <PROJECT_DIR>/.pi/sessions          <projectDir>/.pi/sessions per project

ProjectRuntime API:    only `createNewSession`,             `forProject(...)` is also used
used                   `getSession`, `listSessions`         (Registry-level)

ProjectSession:        identical                            identical
```

## The mental shortcut

If you only remember one thing:

> **Registry is the org. Runtime is the project. Session is the conversation.**
> **Mode picks how URLs map to Runtimes — not how the layers themselves work.**

That's why the file `projectRegistry.ts` no longer references modes at all. The asymmetry between modes lives entirely in `server.ts` (and its `openapi.ts` mirror): single mode awaits one `forProject()` at boot and mounts against the result; multi mode wires session routes to a per-request `forProject()` resolver. The registry, runtime, and session classes are below the mode boundary.
