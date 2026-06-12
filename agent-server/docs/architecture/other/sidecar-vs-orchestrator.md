I now have a clear picture of both. Note: the sidecar app (`create-appx-app`) actually _consumes_ `@appx/agent-server` — but it wires it in a fundamentally different **topology** than what agent-server was designed for. Here's the comparison.

## First, what the two approaches actually are

**Approach A — Sidecar (create-appx-app):** The builder is _embedded inside the app it builds_. One app = one agent-server pointed at `PROJECT_DIR = its own repo`. The preview pane and the chat dock are sibling React components in the _same_ running app, and the agent edits the _same source files_ that are being served. 1:1:1 — one app, one agent, one project dir.

**Approach B — Orchestrator (agent-server's intended design):** One long-lived agent-server process is a _central control plane_ that manages **many** isolated projects. `ProjectRegistry` → lazily-built `ProjectRuntime` per project → `Map<sessionId, ProjectSession>`. The builder is **separate** from the apps it builds; agents modify code in `WORKSPACE_DIR/<id>/` and spin up the actual apps as **inner containers** (rootless podman) inside an unprivileged outer container. The builder never _is_ the app.

The key structural difference: in A the agent edits the process that hosts the agent UI; in B the agent and the app it produces are different processes (indeed different containers).

---

## Dimension-by-dimension

### 1. Isolation & security

- **Sidecar:** Weak. Agent runs with `PROJECT_DIR` = the live app repo, same filesystem, same trust zone as the served UI. LLM-generated code and the control plane share one process boundary. Fine for a trusted single developer locally; not safe for running untrusted generated code or hostile prompts.
- **Orchestrator:** Strong, by design. Three trust zones (host / trusted outer container with creds / untrusted inner containers running LLM code with **no creds**). Generated apps run nested in podman, can't touch the host, never see LLM keys. This is the whole point of `builder-container-architecture.md`.

**Winner: Orchestrator** (clear, for anything beyond local single-user dev).

### 2. Preview / feedback loop

- **Sidecar:** Tightest possible loop. Agent writes a file → Next.js Fast Refresh → preview updates in-place in milliseconds, _in the same window as the chat_. No build, no container, no port allocation. This is the "build and preview simultaneously" magic.
- **Orchestrator:** Looser. Agent runs `podman build` + `podman run`, allocates a port, you hit the app on a separate URL. Seconds-to-minutes per iteration, and preview is a separate surface from the builder UI.

**Winner: Sidecar** (for iteration speed and the unified build-while-previewing UX).

### 3. Multi-tenancy & scale

- **Sidecar:** None. One app, one agent. To build N apps you run N independent app+agent pairs, each with its own credentials wiring. No shared model registry, no central registry of projects.
- **Orchestrator:** Built for this. Durable `projects.json` registry, lazy per-project runtimes, **one shared `AuthStorage`/`ModelRegistry`** across all projects (set keys once at boot), idempotent project creation, restart-safe via the mounted volume.

**Winner: Orchestrator.**

### 4. Blast radius / self-modification risk

- **Sidecar:** The dangerous one. The agent edits the _same code that renders the agent's own chat UI_. As we discussed, an edit to `app-shell.tsx`, `layout.tsx`, or `pi-runtime-provider.tsx` can break the refresh boundary or introduce a syntax error that takes down the builder UI itself — a chicken-and-egg failure. The `AGENTS.md` prompt explicitly begs the agent to "keep the chat shell working," which is a soft guardrail around a hard structural hazard.
- **Orchestrator:** The builder control plane is physically separate from the built app. A broken generated app crashes its inner container; the agent-server, its UI, and other projects are untouched. (Caveat: all projects share _one_ agent-server process, so an agent-server bug — not an app bug — affects everyone. Documented limitation #3.)

**Winner: Orchestrator** for control-plane safety.

### 5. Credentials handling

- **Sidecar:** Token injected server-side by the Next proxy (`AGENT_SERVER_TOKEN`), keys via env / LiteLLM extension. Decent, but the agent and the LLM keys live in the same trust zone as the served app.
- **Orchestrator:** Keys live only in agent-server's heap in the trusted outer container; inner app containers never receive them unless explicitly passed; defense-in-depth via bash `spawnHook`. Cleaner separation.

**Winner: Orchestrator.**

### 6. Simplicity & developer experience

- **Sidecar:** Dead simple to grasp and run: `pnpm agent:dev` + `pnpm dev`, or one Docker container with a bind mount. No podman, no nested containers, no port broker, no project registry. The repo _is_ the template — clone, point the agent at it, go. Great for "scaffold me an app and let me watch it form."
- **Orchestrator:** More moving parts: outer container, rootless podman, FUSE device, port allocation, project provisioning, registry persistence. More to operate and debug.

**Winner: Sidecar** for low-friction local/single-app use.

### 7. Resource management & failure modes

- **Sidecar:** No shared-resource contention because there's nothing shared — but also no limits and no orchestration; you manage each pair by hand.
- **Orchestrator:** Central place to apply `--memory`/`--cpus`, idle-eviction sweeps, disk quotas. But projects share the outer container's CPU/mem/disk, so a runaway build in one project can starve another (documented limitations #1, #2).

**Roughly even** — different trade-offs.

### 8. Deployment lifecycle

- **Sidecar:** There isn't really one — the "app" is the dev server. Great for prototyping, awkward as a path to a deployable artifact (you'd graduate it out of the sidecar shell).
- **Orchestrator:** Produces real container images via podman — a natural path to deploy/scale (escalates cleanly to per-user containers, k8s pods, Sysbox/microVMs per the escalation table).

**Winner: Orchestrator** for productionization.

---

## How to think about it

They're not really competitors — they're optimized for different points in the lifecycle, and the sidecar is essentially **one constrained configuration** of the orchestrator (single project, `projectDir` = the app, no inner containers, hot-reload instead of podman):

|                      | Sidecar (create-appx-app)                       | Orchestrator (agent-server)                 |
| -------------------- | ----------------------------------------------- | ------------------------------------------- |
| Best for             | Single dev, single app, fast in-place iteration | Many projects, isolation, deployable apps   |
| Preview              | Same window, instant Fast Refresh               | Separate URL, container build               |
| Isolation            | Same process/trust zone                         | Outer + nested inner containers             |
| Multi-project        | No                                              | Yes (registry, shared auth)                 |
| Control-plane safety | Agent can break its own UI                      | Builder separate from built app             |
| Credentials          | Same zone as served app                         | Isolated in outer container heap            |
| Ops complexity       | Minimal                                         | Higher (podman, ports, registry)            |
| Scale path           | Re-architect                                    | Layered escalation (per-user, k8s, microVM) |

**Bottom line:** The sidecar buys an unbeatable build-while-previewing feedback loop and trivial setup, at the cost of isolation, multi-tenancy, and the structural hazard of an agent that can crash its own UI. The orchestrator buys security boundaries, multi-project scale, shared credentials, deployable artifacts, and a clean separation between builder and built — at the cost of a slower loop and more operational machinery.

A pragmatic product often wants **both**: the orchestrator as the backbone (isolation, multi-project, deploy), with a sidecar-style hot-reload preview surface bolted on for the inner-loop UX during active editing.
