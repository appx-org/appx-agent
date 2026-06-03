# Project Lifecycle & Workspace Layout

Status: **adopted** (supersedes the header-driven `projectRuntimeFromRequest` model)

## Why this exists

The previous design created a `ProjectRuntime` lazily as a side effect of the
first session request, reading the project's *definition* (`x-appx-project-dir`,
`x-appx-project-name`) from trusted proxy headers on **every** request. That
conflated two distinct concepts:

| Concept | What it is | Where it used to live | Where it lives now |
|---|---|---|---|
| Project **identity** ("which project") | `id` | URL path param | URL path param (unchanged) |
| Project **definition** ("what it is, where it lives") | `name`, `projectDir` | smuggled in headers, per request | request body of a one-time `POST /v1/projects`, persisted |

agent-server is the orchestration core of the
[builder-container architecture](./builder-container-architecture.md): it spawns
builder agents per project and is reused standalone (e.g. the LanQuest game
spawns a Game-Master agent and a Tutor agent through the same surface). To be a
self-contained orchestrator it must **own** what a project is and where it lives,
and that ownership must survive a container restart.

## Decisions

1. **`id` is the slug.** `id = slugify(name)` (with a short random suffix only on
   collision). It is immutable, and is simultaneously the registry key, the route
   param, and the on-disk directory name. `name` is a free-form, mutable display
   label stored only in metadata — it never touches the filesystem. A rename never
   moves a directory.

2. **Name-only input.** The API accepts `name`, never a `projectDir`. The
   directory is derived by convention. Because the only path input is a slugified
   name, path traversal is structurally impossible (OWASP).

3. **`WORKSPACE_DIR` replaces `PROJECT_DIR`.** One root holds everything:

   ```
   WORKSPACE_DIR/
   ├── .pi-global/                 # org-global + agent-server state
   │   ├── auth.json               # Pi auth (keys are injected from env at boot,
   │   │                           #   in-memory-first; this file is not the secret of record)
   │   ├── models.json             # Pi custom providers
   │   ├── projects.json           # agent-server project registry (SOURCE OF TRUTH)
   │   └── sessions/
   │       └── {id}/               # session JSONL transcripts, namespaced by project id
   ├── {id}/                       # project working dir = app source + config
   │   └── .pi/                    # AGENTS.md, skills/, extensions/, settings.json (committable)
   └── {id2}/ ...
   ```

   - `agentDir` is hardcoded to `WORKSPACE_DIR/.pi-global`. `GLOBAL_AGENT_DIR` is
     removed.
   - **Sessions are centralised** under `.pi-global/sessions/{id}/` rather than
     `{id}/.pi/sessions/`. This separates *config* (input, committable, lives with
     the project) from *transcripts* (runtime output). Deleting a project must
     remove **both** locations.

4. **Single mode is collapsed.** There is no `AGENT_SERVER_MODE`. Routing is always
   project-scoped (`/v1/projects/{id}/...`). A "standalone" deployment is just a
   workspace that happens to hold one project. **No project is auto-created** —
   callers create their projects explicitly.

5. **Idempotent registration + boot reconciliation.** `projects.json` is the
   source of truth. On boot the registry rehydrates from it (metadata only;
   runtimes are still built lazily on first use). `POST /v1/projects` is an
   idempotent upsert: if the slug already exists (e.g. after a restart, the
   upstream caller re-POSTs), nothing is recreated — the existing, already
   initialised project is returned unchanged. Writes to `projects.json` are atomic
   (temp file + `rename`).

6. **Reserved slugs.** `.pi-global` is reserved; empty/leading-dot slugs are
   rejected.

## HTTP surface

Mounted under `/v1`:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/projects` | Create-or-get a project. Body `{ "name": string }`. Returns `{ id, name, projectDir, createdAt }`. Idempotent on the derived slug. |
| `GET` | `/v1/projects` | List registered projects. |
| `GET` | `/v1/projects/{id}` | Get one project's metadata. 404 if unknown. |
| `DELETE` | `/v1/projects/{id}` | Evict the runtime, drop the metadata entry, and remove `WORKSPACE_DIR/{id}/` + `.pi-global/sessions/{id}/`. |
| `*` | `/v1/projects/{id}/sessions...` | Session routes. Resolve the runtime by path `id` via a **pure lookup**; `404 project not registered` if the project was never created. No more `x-appx-*` headers, no lazy creation. |

## Persistence & containers

- Mount `WORKSPACE_DIR` as a **named Docker volume**. Both project working data
  (`{id}/.pi/`, app source) and global state (`.pi-global/`) then survive
  `docker rm` / image upgrades with no code involvement.
- **LLM credentials are not persisted to the volume.** They are injected via env
  at startup and held in `AuthStorage` in memory (see builder-container doc).
- **App/agent domain state is not agent-server's concern.** LanQuest's inventory,
  game state, and "user progress memories" stored as rows belong to the app's own
  DB; the agent touches them through the app's CLI/tools. The only agent-owned
  memory is the session transcript, which lives in `.pi-global/sessions/{id}/` on
  the volume.

## How appx integrates

appx demotes from "owner of project filesystem layout" to a **control plane**
keyed by the shared project id:

- appx project **names already satisfy the slug grammar**
  (`^[a-z][a-z0-9-]{0,61}[a-z0-9]$`), so `slugify(name) == name`. agent-server's
  `id` therefore equals appx's project **name**, and the proxy uses `proj.Name`
  as the agent-server project id in the path.
- `Manager.Create` calls `POST /v1/projects { name }` (agent-server creates the
  dir + registers + persists), then appx layers its own product concerns
  (port/subdomain assignment in appx's SQLite, git init, scaffolding) into the
  returned `projectDir`.
- `Manager.Delete` calls `DELETE /v1/projects/{name}`.
- On boot, appx calls `Manager.ReconcileAgentProjects`, which idempotently
  re-registers every known project. This registers projects that predate
  agent-server ownership and makes an agent-server restart transparent (the
  in-memory registry is rebuilt from appx's DB without operator action).
- The reverse proxy **stops injecting** `X-Appx-Project-Dir` / `X-Appx-Project-Name`;
  the path's project id is sufficient because agent-server resolves the directory
  from its own persisted registry.
- appx keeps a SQLite row per project only for things agent-server has no business
  knowing (assigned port, subdomain, owning user, health). Two bounded contexts
  sharing a key is intentional, not duplication.

For deployments where appx and agent-server share a host/volume, appx's
`projectRoot` must equal agent-server's `WORKSPACE_DIR` so appx's scaffolding and
agent-server's directory ownership refer to the same path.
