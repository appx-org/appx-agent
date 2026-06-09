# agent-server runtime layers: Registry / Runtime / Session

How `ProjectRegistry`, `ProjectRuntime`, and `ProjectSession` relate inside a
single agent-server process, and how a request reaches a runtime now that
routing is always project-scoped (there is no `single`/`multi` mode).

## In simple terms

Three nested layers, each with one job:

| Class | "It owns…" | "There is one per…" |
|---|---|---|
| **`ProjectRegistry`** | The shared org-global state (LLM keys, model catalog, credentials service), the **durable project registry** (`projects.json`), and a directory of project runtimes | **process** |
| **`ProjectRuntime`** | Everything scoped to one project (project dir, sessions dir, the loaded extensions/skills/themes for that project, the in-memory map of live sessions) | **project** |
| **`ProjectSession`** | One conversation with the agent — its `AgentSession`, its event stream, its pending extension-UI prompts, prompt/abort/settings ops | **chat session** |

Said like a Russian doll: **Registry contains Runtimes, Runtime contains
Sessions.** A request always lands on a session, which lives in a runtime, which
is found in the registry.

You can map it 1:1 to the URL surface:

- `/v1/auth/*`, `/v1/custom/*` → **Registry** (org-level)
- `/v1/projects` (POST create, GET list), `/v1/projects/{id}` (GET/DELETE) → **Registry** (project lifecycle)
- `/v1/projects/{id}/sessions` (POST/GET list) → **Runtime** (project-level)
- `/v1/projects/{id}/sessions/{sid}/...` → **Session** (conversation-level)

## Filesystem layout

Everything lives under one mountable root, `WORKSPACE_DIR`:

```
WORKSPACE_DIR/
├── .pi-global/                 # org-global + agent-server state (the Registry tier)
│   ├── auth.json               # Pi auth (keys injected from env at boot, in-memory-first)
│   ├── models.json             # Pi custom providers
│   ├── projects.json           # durable project registry — SOURCE OF TRUTH
│   └── sessions/{id}/          # session transcripts, centralised, namespaced by project id
├── {id}/                       # project working dir = app source + config (the Runtime tier)
│   └── .pi/                    # AGENTS.md, skills/, extensions/, settings.json (committable)
└── {id2}/ ...
```

The Registry's `agentDir` is hardcoded to `WORKSPACE_DIR/.pi-global`. Session
transcripts are deliberately **centralised** under `.pi-global/sessions/{id}/`
rather than inside `{id}/.pi/sessions/`, so each project's `.pi/` stays
config-only (committable) and transcripts live independently on the volume. See
[project-lifecycle-and-workspace-layout.md](./project-lifecycle-and-workspace-layout.md).

## Static structure

```
┌────────────────────────────────────────────────────────────────┐
│  agent-server process (one per organisation)                   │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  ProjectRegistry                                         │  │
│  │  ────────────────────────                                │  │
│  │  • AuthStorage           ┐                               │  │
│  │  • ModelRegistry         │ shared, process-global        │  │
│  │  • AgentCredentialsService                               │  │
│  │  • ProjectStore  ──────────► .pi-global/projects.json    │  │
│  │      (durable id → {name, createdAt}; source of truth)   │  │
│  │                                                          │  │
│  │  • runtimes: Map<id, ProjectRuntime>   (lazy cache)      │  │
│  │      ├─ "eventx"   ───────► ProjectRuntime "eventx"      │  │
│  │      ├─ "todoapp"  ───────► ProjectRuntime "todoapp"     │  │
│  │      └─ ...                                              │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌─── ProjectRuntime "eventx" ────────────────────────────┐    │
│  │  • projectDir  = WORKSPACE_DIR/eventx                  │    │
│  │  • sessionsDir = WORKSPACE_DIR/.pi-global/sessions/eventx│  │
│  │  • piDir       = WORKSPACE_DIR/eventx/.pi              │    │
│  │     (AGENTS.md, skills/, extensions/, settings.json)   │    │
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

Important properties this layout encodes:

1. **`AuthStorage` and `ModelRegistry` live in the Registry, not in any Runtime.**
   Runtimes *hold references* to them but don't own them. That's the technical
   reason a single set of LLM keys covers every project — the registry hands the
   same instances to every `ProjectRuntime` it builds.
2. **The `ProjectStore` (`projects.json`) is the source of truth for which
   projects exist**, not the in-memory `runtimes` map. The map is a lazy cache of
   *built* runtimes; the store is the durable list that survives restarts.
3. **There is no eager runtime.** The registry boots by setting up shared
   services and loading `projects.json`; it builds **zero** `ProjectRuntime`s up
   front. A runtime is constructed lazily the first time something acts on its
   project (`getRuntime(id)`), and cached thereafter.
4. **Runtimes own session *files*; ProjectSessions own session *behaviour*.** The
   runtime can list/load sessions from disk without instantiating a
   `ProjectSession` for each one (cheap listing). It only constructs a
   `ProjectSession` when something actually needs to act on it (`getSession(id)`
   lazily reopens, `createNewSession()` makes a fresh one). The
   `Map<sessionId, ProjectSession>` is the *live* set, not the persisted set.

## Project lifecycle (Registry tier)

Projects are **explicit, persisted resources** — there is no implicit creation
on first request, and no project definition smuggled in request headers.

```
POST /v1/projects { name: "My App" }
  └─ ProjectRegistry.createProject({ name })
       • id = slugify(name)  (immutable; registry key, route param, dir name)
       • mkdir WORKSPACE_DIR/{id}
       • ProjectStore.add({ id, name, createdAt })  → persisted atomically
       • returns { id, name, projectDir, createdAt }   (runtime built later, lazily)
```

- **Idempotent on name.** Re-POSTing the same name (e.g. after a restart)
  returns the existing project untouched. A *different* name that slugifies to a
  taken id is a genuine collision and gets a short random suffix so both coexist.
- **Boot reconciliation.** On startup the registry rehydrates the project list
  from `projects.json`. Runtimes are still built lazily, so rehydration is cheap
  (no filesystem walks until a project is actually used).
- **`DELETE /v1/projects/{id}`** evicts the cached runtime, drops the metadata
  record, and removes both on-disk locations — the working dir
  `WORKSPACE_DIR/{id}/` and the transcripts `.pi-global/sessions/{id}/`.

## How a session request reaches a Runtime

Routing is uniform: session routes are mounted at `/v1/projects/:projectId` and
resolve the runtime by a **pure registry lookup** on the path id.

```
HTTP request                              Hono routing                      Runtime resolution
─────────────────────────────────────     ─────────────────────────         ────────────────────────────
GET /v1/projects/eventx/sessions/abc      /v1/projects/:projectId           projectRuntimeFromRequest(c):
                                            └─ createSessionsApp(             registry.getRuntime("eventx")
                                                 projectRuntimeFromRequest)   │
                                                                            ├─ not in projects.json
                                                                            │    → ProjectNotRegisteredError → 404
                                                                            └─ registered
                                                                                 │ (cache miss → build runtime)
                                                                                 ▼
                                                                           ProjectRuntime "eventx"
                                                                                 │
                                                                                 ▼
                                                                           ProjectSession "abc"
```

- The resolver is a **pure lookup** — it never creates a project as a side
  effect. An unknown id raises `ProjectNotRegisteredError`, which the global
  error handler maps to `404`. Projects must be created via `POST /v1/projects`
  first.
- `registry.runtimes` is populated **lazily**: the first session request for a
  registered project builds that project's runtime and caches it.
- The credentials surface (`/v1/auth/*`, `/v1/custom/*`) is mounted on the
  registry's `credentials` service directly — credentials are org-global, not
  project-scoped, and don't depend on any runtime existing.
- A standalone deployment (e.g. a game spawning a Game-Master and a Tutor agent,
  or an eventx-style single app) is just a workspace that happens to hold one or
  a few projects, each created explicitly. There is no special "single" path.

## The mental shortcut

If you only remember one thing:

> **Registry is the org. Runtime is the project. Session is the conversation.**
> **Projects are explicit, persisted, and addressed by id in the URL path; a
> session request is a pure lookup of an already-registered runtime.**

`projectRegistry.ts` owns project identity and the durable registry;
`server.ts` (and its `openapi.ts` mirror) just mounts the credentials app, the
project-lifecycle app, and the session app whose resolver calls
`registry.getRuntime(projectId)`.
