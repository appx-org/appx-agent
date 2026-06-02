# Builder Container Architecture

The canonical "this is what we're building" reference for Appx's single-admin-user agentic app builder.

## The Goal

Build a system where:

1. Builder agents are isolated from the host system
2. Apps the agents create are also isolated from the host
3. All builder agents share one set of LLM credentials
4. Builder agents can deploy apps via containers

## The Architecture, Drawn Out

```
┌─────────────────────────────────────────────────────────────────┐
│  HOST                                                           │
│                                                                 │
│  Docker (or Podman) — runs ONE outer container                  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  OUTER BUILDER-CONTAINER (unprivileged)                   │  │
│  │  — security boundary against the host                     │  │
│  │  — holds LLM credentials in memory                        │  │
│  │  — has rootless podman + agent-server installed           │  │
│  │                                                           │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │  agent-server (one Node.js process)                 │  │  │
│  │  │  • AuthStorage (LLM keys, runtime-only)             │  │  │
│  │  │  • ModelRegistry                                    │  │  │
│  │  │  • ProjectRegistry                             │  │  │
│  │  │     ├─ ProjectRuntime: project "eventx"             │  │  │
│  │  │     │    └─ ProjectSession (the builder agent for   │  │  │
│  │  │     │       eventx — modifies code, runs podman)    │  │  │
│  │  │     │                                               │  │  │
│  │  │     ├─ ProjectRuntime: project "todoapp"            │  │  │
│  │  │     │    └─ ProjectSession (todoapp's builder agent)│  │  │
│  │  │     │                                               │  │  │
│  │  │     └─ ProjectRuntime: project "crm"                │  │  │
│  │  │          └─ ProjectSession                          │  │  │
│  │  └────────────────────┬────────────────────────────────┘  │  │
│  │                       │ bash tool runs podman             │  │
│  │  ┌────────────────────▼────────────────────────────────┐  │  │
│  │  │  rootless podman                                    │  │  │
│  │  │  storage: ~/.local/share/containers/                │  │  │
│  │  └────────────────────┬────────────────────────────────┘  │  │
│  │                       │                                   │  │
│  │  /workspace/   ← projects mounted here                    │  │
│  │  ├── eventx/                                              │  │
│  │  ├── todoapp/                                             │  │
│  │  └── crm/                                                 │  │
│  │                                                           │  │
│  │  ┌──── inner containers spawned by builder agents ───┐    │  │
│  │  │                                                   │    │  │
│  │  │  ┌────────────────┐  ┌────────────────┐           │    │  │
│  │  │  │ eventx-app     │  │ eventx-db      │           │    │  │
│  │  │  │ (built/run by  │  │ (built/run by  │           │    │  │
│  │  │  │  eventx agent) │  │  eventx agent) │           │    │  │
│  │  │  └────────────────┘  └────────────────┘           │    │  │
│  │  │                                                   │    │  │
│  │  │  ┌────────────────┐                               │    │  │
│  │  │  │ todoapp-app    │  (todoapp agent's outputs)    │    │  │
│  │  │  └────────────────┘                               │    │  │
│  │  │                                                   │    │  │
│  │  │  No keys here. Don't share namespaces with        │    │  │
│  │  │  the builder. Visible only inside outer.          │    │  │
│  │  └───────────────────────────────────────────────────┘    │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘

  Trust zones:
  • Host: trusted, doesn't run app code
  • Outer container: trusted with credentials, runs builder agents
  • Inner containers: untrusted, run LLM-generated code, no creds
```

## Component Mapping

| Concept | What it maps to in code |
|---|---|
| Unprivileged builder-container | Outer container, no `--privileged`, runs as non-root user |
| running agent-server | One Node.js process inside outer container |
| spins up builder agents for each project | `ProjectRegistry.forProject()` creates a `ProjectRuntime` per project; each runtime owns a `Map<sessionId, ProjectSession>` |
| modify app source | `read`/`write`/`edit` tools on `/workspace/<project>/` |
| create app containers using rootless podman | `bash` tool runs `podman build` / `podman run` inside the outer container |
| isolate builder agents and apps from host | Outer container is the host-side security boundary |
| share auth between builder agents | All `ProjectRuntime`s in the registry share the same `AuthStorage` and `ModelRegistry` (already designed this way in `projectRegistry.ts`) |

## Two Subtle Points

### Point 1: "Spins up builder agents" = sessions, not processes

In agent-server's design, all "builder agents" are **`ProjectSession` instances within the same `agent-server` Node.js process** — not separate processes. Each `ProjectSession` wraps an `AgentSession` plus per-session ExtensionUIContext / SSE plumbing; sessions belonging to the same project share a `ProjectRuntime`, and all projects share the process-global `AuthStorage` / `ModelRegistry`. They differ only in:

- Which project directory they operate over (`projectDir`)
- Which session file persists their conversation
- Which extensions/skills they have loaded

```typescript
// What "spins up a builder agent for a project" actually is:
const runtime = registry.forProject({ id: "eventx", projectDir: "/workspace/eventx" });
const session = await runtime.createNewSession();
await session.sendPrompt("scaffold a Next.js app");
```

There's no fork, no new process, no separate auth context. It's a `Map<projectId, ProjectRuntime>` lookup, and the runtime owns a `Map<sessionId, ProjectSession>`.

**Why this is fine:** in the single-admin-user scenario, all projects belong to the same human. There's no inter-tenant trust boundary to enforce. Sharing one process is the natural fit.

**When it stops being fine:** if multiple end-users (Alice, Bob, etc.) are added later, "builder agents share a process" means a bug in Alice's session could potentially interfere with Bob's. At that point, graduate to per-user outer containers or per-user systemd units (the patterns from `systemd-isolation.md`).

For now, "spins up builder agents" is a logical operation — calling `forProject(...)` to get (or create) the `ProjectRuntime`, then `createNewSession()` to get a `ProjectSession` — not a process operation.

### Point 2: Auth sharing happens automatically

Because all builder agents are sessions within one process, sharing auth is trivial:

```typescript
// At outer container startup (agent-server bootstrap):
authStorage.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY);
authStorage.setRuntimeApiKey("openai", process.env.OPENAI_API_KEY);
// That's it.

// Every project's ProjectRuntime, every session, every LLM call:
// uses these in-memory keys. No further plumbing needed.
```

The keys come in via the `docker run -e ANTHROPIC_API_KEY=...` flag on the outer container, get pushed to `AuthStorage` once at startup, and every builder agent uses them naturally because they're all reading from the same `AuthStorage` instance.

**What this means for credentials never reaching app containers:** when the builder agent runs `podman run myapp`, the inner container inherits whatever env vars the agent passes via `-e ...`. The agent doesn't (and shouldn't) pass `ANTHROPIC_API_KEY` to the inner app. Even if the LLM tried to be clever and write the key into a Dockerfile, the key would only be in *the file*, not in the running app's environment unless deliberately wired in.

For defense in depth, configure agent-server's bash tool with a `spawnHook` that strips LLM keys from the env before running any command — but in practice it doesn't tend to happen because the keys aren't in env vars at the bash level; they're in the agent-server process's heap.

## Runtime Walkthrough

Concrete walkthrough of "user creates eventx and prompts the agent":

```
1. User (admin) → POST /v1/projects { id: "eventx", projectDir: "/workspace/eventx" }
   appx control logic creates the dir, registers the project

2. User → POST /v1/projects/eventx/sessions
   agent-server: registry.forProject("eventx").createNewSession()
   → Creates ProjectRuntime for eventx (or returns existing)
   → Creates AgentSession bound to that runtime
   → Returns sessionId

3. User → POST /v1/projects/eventx/sessions/:id/prompt
        body: "scaffold a Next.js app and run it on port 3000"

4. agent-server's ProjectSession.sendPrompt() → AgentSession.prompt()
   → LLM call (using shared AuthStorage's anthropic key)
   → LLM emits tool calls:
     - write Dockerfile          → writes to /workspace/eventx/Dockerfile
     - bash "podman build -t..." → outer container's podman builds image
     - bash "podman run -d..."   → outer container's podman starts inner container
   → Each tool result feeds back into the LLM
   → Tool execution events stream over SSE to the user

5. User → curl http://localhost:3000
   Host port 3000 → outer container port 3000 → inner container :3000 → Next.js app
```

No host-level work happens for any of this beyond running the outer container. **All multi-project orchestration, auth, building, deploying happens inside the outer container.**

## What Already Exists

- ✅ `ProjectRegistry` — handles multi-project
- ✅ Shared `AuthStorage` / `ModelRegistry` across projects
- ✅ Per-session HTTP+SSE API
- ✅ Pluggable bash via `BashOperations` / `customTools`
- ✅ Project-scoped routes (`/v1/projects/:id/sessions/...`)

## What Needs to Be Built

1. **The outer container's Dockerfile** — Ubuntu/Alpine + podman + nodejs + agent-server (~10 lines, draft in `rootless-podman-isolation.md`)
2. **A run script / docker-compose** that launches the outer container with the right flags (`--device /dev/fuse`, port forwards, volume mount, env vars)
3. **Project provisioning logic** — when admin creates a new project, ensure `/workspace/<id>/` exists and call `registry.forProject(...)` to register it
4. **System prompt for the builder agent** — telling it that `podman` is available, where projects live, how to expose ports
5. **(Optional) An idle-eviction sweep** — if many projects exist and stopping unused `ProjectRuntime`s would free memory; not needed for one admin user

That's it. Maybe 1-2 days of work for the outer container + provisioning, plus prompt engineering iteration on point 4.

## What This Architecture Buys You

| Goal | How it's met |
|---|---|
| **Isolate builder agents and apps from host** | Outer container is unprivileged + user-namespaced. Inner containers are nested in the outer's namespaces. Host can't be touched. |
| **Share auth between builder agents** | All sessions live in one process with one shared `AuthStorage`. Trivial. |
| **Builder agents can modify code** | Pi's `write`/`edit`/`read` tools, with `/workspace` mounted from host. |
| **Builder agents can spin up app containers** | `bash` tool runs `podman` commands. Inner containers are children of the outer. |
| **App containers don't have LLM keys** | Keys live in `AuthStorage` in agent-server's memory. They never enter the env of inner containers unless deliberately passed. |
| **One sandbox to manage, scale, debug** | One outer container = one PID to monitor on the host. |
| **Single-admin scenario is simple** | No multi-user complexity, no per-user systemd units, no namespace-per-tenant. |

## Known Limitations

These aren't blockers for the stated case, just worth knowing:

1. **All projects share the outer container's memory and CPU.** A runaway build in eventx can starve todoapp's session. Add `--memory` and `--cpus` limits on the outer container; rely on user behavior within.
2. **All projects share the outer container's filesystem quota.** One project filling `/workspace` affects everyone. Disk quota or per-project mount points if it matters.
3. **No process-level isolation between projects.** A bug in agent-server affects all projects. For single-admin, fine.
4. **First-time podman storage init is slow.** Add `podman info` to the entrypoint to warm up.
5. **Inner container ports must be allocated.** Either expose a port range (`-p 3000-3010:3000-3010`) and let the agent pick, or have a registry that hands out ports. The latter scales better.
6. **Outer container restart kills inner containers.** Inner Podman state lives in the outer container's filesystem. If you `docker restart builder`, all running apps die. Mount Podman storage as a volume if you want persistence: `-v podman-storage:/home/builder/.local/share/containers`.

None of these are dealbreakers; just trade-offs to be aware of.

## Escalation Paths (For Later)

When the single-admin scenario outgrows this design, here's how the architecture composes:

| Future need | Escalation |
|---|---|
| Multiple end-users with strong isolation | One outer container per user; appx routes by user → container (see `systemd-isolation.md`) |
| Cross-host scaling | Each outer container becomes a k8s pod; namespace per user (see `hosted-platform-migration.md` if added later) |
| Stronger isolation for hostile workloads | Sysbox runtime for the outer container; or microVMs (Firecracker/Kata) |
| Anonymous public users (untrusted) | Pattern 5 from `builder-agent-isolation.md`: platform Build/Deploy API with ephemeral sandboxes |

None of these invalidate this design — they layer on top. The "one outer container with agent-server + rootless podman + projects mounted" core pattern remains the unit of deployment.

## TL;DR

```
┌─────────────────────────────────────────────────────────────┐
│  ONE outer container, unprivileged, user-namespaced         │
│  ├── ONE agent-server process                               │
│  │   ├── shared AuthStorage (LLM keys live here)            │
│  │   ├── per-project ProjectRuntime                         │
│  │   └── per-project AgentSession (the "builder agent")     │
│  ├── rootless podman                                        │
│  └── inner containers (the actual apps the agents build)    │
└─────────────────────────────────────────────────────────────┘
```

This satisfies all four requirements:

1. ✅ Builder agents isolated from host (outer container boundary)
2. ✅ Apps isolated from host (inner containers nested in outer)
3. ✅ Shared auth across builder agents (one AuthStorage in one process)
4. ✅ Builder agents can deploy apps via containers (podman in their bash tool)

For one admin user with many projects, **this is the entire architecture**. Everything more elaborate — per-user systemd units, k8s namespaces, Sysbox, microVMs — is escalation paths for when this is outgrown. None of those changes invalidate the design; they layer on top.
