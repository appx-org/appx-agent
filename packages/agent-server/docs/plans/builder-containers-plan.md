# Plan: Containerised Apps — agent-server Side

**Date:** 2026-06-11 (updated 2026-06-12 with Stage 3 results)
**Status:** Stage 0 ✅ done · Stage 1 ✅ code-complete + unit-tested (manual e2e pending) · Stage 2 ✅ smoke-green · Stage 3 ✅ done (appx-side, smoke-green) · Stage 4 ✅ done (appx-side, productionized + reboot-soaked) · Stage 5 (hardening) pending
**Scope:** Deployment metadata contract (dev + prod), app template seeding, two-container (dev/prod) deploy model, builder deploy skill/prompt, outer container image (nested rootless podman), smoke tests
**Canonical architecture:** `docs/architecture/important/builder-container-architecture.md`
**Sibling plan:** appx repo, `docs/plans/phase_9_plan.md` (control plane: port allocation, container supervision, subdomain routing)

---

## Goal

Implement agent-server's half of the containerised apps architecture:

1. appx starts ONE outer container at boot (agent-server + rootless podman inside).
2. User creates a project in the appx UI; appx allocates **two ports** (a DEV and a PROD port) and registers the project here **with deployment metadata** (both ports + their public URLs).
3. New projects are **seeded from a baked-in app template**, so they start as a runnable, containerised app (a lean multi-stage Dockerfile — no framework dev-server).
4. The builder agent builds **one image** and runs it as **two inner podman containers** — DEV (iterate) and PROD (stable/shared) — each publishing its reserved port. DEV and PROD are the **same build** ("what you see is what ships").
5. The user iterates against the DEV URL; refinements rebuild + redeploy DEV. When happy, the agent **promotes** (rebuilds PROD from current source). Both are real `https://…<domain>` URLs exposed by appx.

## Division of labour

| Concern | Owner |
|---|---|
| Port allocation (**two ports/project**), subdomain proxy (**dev + prod**), outer container lifecycle, host deploy scripts | appx |
| Project registry + deployment metadata persistence, surfacing metadata to the agent, deploy skill, outer container **image**, podman-in-container validation | agent-server (this plan) |

agent-server stays appx-agnostic: it receives a generic `deployment` object (dev + prod `{port, url}` pairs) on project create and makes it available to the agent. It never knows how appx mints ports or subdomains — only that two pairs were handed to it.

> **appx-side implication (track in `phase_9_plan.md`):** appx must allocate a
> **pair** of ports per project and route **two** subdomains (prod `…<domain>`,
> dev e.g. `…-dev.<domain>`). **Resolved (2026-06-12):** the published/allocated
> range was set to `10000–10199` (200 ports) so the pair model still supports
> **100 projects**. The outer-container publish range (Stage 2/3 `run-outer.sh`)
> and `phase_9_plan.md` D1 must match `10000-10199`.

---

## Design decisions

### D1 — Deployment metadata rides on `POST /v1/projects` (dev + prod)

Extend the create-project contract with an optional `deployment` object carrying
**two environments**, each a `{port, url}` pair:

```jsonc
POST /v1/projects
{
  "name": "eventx",
  "deployment": {
    "dev":  { "port": 10006, "url": "https://eventx-dev.example.com" },
    "prod": { "port": 10007, "url": "https://eventx.example.com" }
  }
}
```

- Both `dev` and `prod` (and their fields) are optional, so a single-port local dev setup or a partial registration is still valid.
- Persisted on the `ProjectRecord` in `projects.json`.
- **Idempotent re-POST with the same name updates `deployment`** (today it returns the existing record untouched). This lets appx's startup reconcile heal drift — e.g. a project that predates this feature gets its ports on the next boot.
- Returned by `GET /v1/projects` / `GET /v1/projects/:id` so the control plane can verify registration.
- agent-server never *reads a port back* from the agent — the pairs flow one way (appx → metadata → agent). Readiness is appx's concern (a health check on each port), never an agent-authored file. (Contrast: orchestrator's `.pi/app.json` — see `docs/architecture/other/orchestrator-comparison.md` §2.3.)

### D2 — Metadata is surfaced to the agent as file + prompt section

Two mechanisms, both generated from the same record:

1. **`<projectDir>/.pi/deployment.json`** — materialised on create/update. The agent can `cat` it any time; it survives context compaction and session restarts.
2. **System prompt injection** — `ProjectRuntime` appends a short generated "Deployment" section to the resolved system prompt when metadata exists (after the `.pi/AGENTS.md` content, never replacing it):

```
## Deployment
This project runs as TWO containers from the SAME build (two instances, not two builds):
- DEV  (iterate here):   host port 10006 → https://eventx-dev.example.com   (container <project>-app-dev)
- PROD (stable, shared): host port 10007 → https://eventx.example.com       (container <project>-app-prod)
Refinements rebuild + redeploy DEV; PROD changes only when you "promote".
The app listens on its container port; map it with -p <reserved host port>:<container port>.
Container runtime: podman. See the deploy-app skill for build/run/redeploy/promote conventions.
Machine-readable copy: .pi/deployment.json
```

File-only would risk the agent never reading it; prompt-only would risk loss on compaction. Both is cheap.

### D3 — Container runtime for the agent is env config, not hardcoded

`APP_CONTAINER_RUNTIME` env var (default `podman`), threaded into the prompt section and the skill. In the outer container it is always `podman`; in local macOS dev (Stage 1, agent-server on host) it may be `docker` (Docker Desktop) or podman-machine. The skill references `$APP_CONTAINER_RUNTIME` so Stage 1 prompt iteration transfers untouched to the nested setup.

### D4 — Deploy conventions live in a skill, not only in AGENTS.md

Ship a `deploy-app` skill in this repo (`builder-agent/skills/deploy-app/SKILL.md`), loaded via `PI_SKILL_PATHS` in the outer image. Skills are versioned with agent-server, independent of any one project's `.pi/`, and the prompt section stays short (conventions load only when the agent deploys).

### D5 — New projects are seeded from a baked-in app template

`POST /v1/projects` copies a configured template dir into a freshly-created
`WORKSPACE_DIR/{id}/` (only when the dir did not already exist; existing projects
are untouched). A seeded, runnable starting point means the deploy skill's
`build` + `run` commands work from the very first prompt instead of
relying on the LLM to scaffold a correct app + Dockerfile from scratch. The
**seeding mechanism** (a `templateDir` + recursive copy with a skip filter for
`node_modules`/build output) is lifted from appx-orchestrator (comparison §1).

- Config: `APPX_TEMPLATE_DIR` (absent ⇒ projects start empty, as today).
- The outer image bakes the template at a fixed path and points `APPX_TEMPLATE_DIR` at it.

**The template *content* is deliberately undecided.** We do not yet know the
target stack — it may not even be a JS frontend (a Python backend, a full-stack
framework, or several selectable templates are all on the table). Consequences:

- **Start minimal:** a small **Vite SPA** is the provisional default, not Next.js
  — fewer moving parts, faster builds under nested podman, easier to reason about
  while the core loop is proven. Treat it as a throwaway placeholder, not a commitment.
- **No framework assumptions leak outward.** agent-server, the deployment metadata,
  and the deploy skill stay stack-agnostic — the only contract is "a Dockerfile
  that builds a lean image serving on a port." Swapping the
  template, or supporting several, must require zero changes outside `APPX_TEMPLATE_DIR`.
- **We author the template's Dockerfile; we don't copy orchestrator's.**
  Orchestrator's is a useful *structural* reference for the multi-stage shape
  (deps → build → lean runtime), but its final stage ships the whole build tree
  (dev deps + source) and runs as root — not optimal. Ours has a lean runtime
  stage and a non-root user. The inner-app spike (`container/INNER-APP-SPIKE.md`)
  **proved this builds and serves under nested rootless podman + native overlay**
  (a 64 MB non-root Vite image; a Python app worked identically).

### D6 — Two containers per app: DEV and PROD (same build, two instances)

Each project deploys as two inner containers built from the **same Dockerfile**
(one build target — no dev/prod divergence), on the two ports appx allocated (D1):

| Env | Container | Image | Host port | Purpose |
|---|---|---|---|---|
| DEV  | `<project>-app-dev`  | `<project>-app:dev`  | dev port  | What the user iterates against; rebuilt + redeployed on each refinement. |
| PROD | `<project>-app-prod` | `<project>-app:prod` | prod port | The stable/shared URL; rebuilt only on **promote**. |

- **DEV is built exactly like PROD** (real built image, real server) — no
  framework dev-server, no hot-reload. "What you see in DEV is what ships," and
  every stack is treated uniformly (build an image, run it). This deliberately
  keeps app-specific dev-server quirks (Vite `allowedHosts`, HMR WebSockets) out
  of the template, the skill, **and** appx. See *Potential improvements* for the
  hot-reload escape hatch if rebuild latency ever bites.
- **Refinement loop (goal step 5):** rebuild the image and redeploy **DEV only**
  (~seconds; the spike measured ~0.7 s warm rebuild + a fast `rm`/`run`). PROD's
  URL stays stable while the user iterates.
- **Promote** = rebuild PROD from current source and restart its container, so
  PROD matches what the user approved in DEV.
- Two image tags (`:dev`/`:prod`) keep the instances independent snapshots even
  though they come from one Dockerfile.

---

## Staging (shared with appx plan)

| Stage | What | Repo focus | Status |
|---|---|---|---|
| 0 | Nested rootless podman spike (timeboxed ~1 day) | agent-server | ✅ done |
| 1 | Full user flow with agent-server **on host** ("podman without outer container") | both | ✅ code + unit tests; manual e2e pending |
| 2 | agent-server inside the outer container, started manually | agent-server | ✅ smoke-green |
| 3 | appx creates/supervises the outer container at startup | appx | ✅ smoke-green (`smoke-deploy.sh` 38/38) |
| 4 | **Productionize**: deploy is container-mode only (remove host mode), appx as a systemd service, secrets, docker access, soak | appx (+ both) | ✅ done (appx-side; reboot-soaked) |
| 5 | Hardening (restarts, key stripping, resource limits, security review) | both | pending |

Rationale: the user-visible flow (Stage 1) is ~80% of the value and is independent of the outer container; the outer container is packaging. The Stage 0 spike de-risks the one thing that could invalidate Stage 1 decisions — nested podman flag fragility ("works on host, breaks nested"). **Stage 3→4 split (2026-06-12):** Stage 3 proved appx can supervise the container when hand-run with env vars; running it as the production systemd service (secrets, docker access, boot ordering) is a distinct, soak-worthy chunk, so it was carved out as **Stage 4 (productionize)** and hardening moved to **Stage 5**. **Host mode dropped from deploy (2026-06-12):** container mode supersedes it, so Stage 4 removes the host-mode deploy/systemd path entirely (no `appx-agent` user, no `agent-server.service`, no host Node/Pi install); local development becomes a manual, no-systemd flow (run agent-server by hand + `appx --http`). The appx binary keeps its `APPX_AGENT_SERVER_URL` runtime path for that local/macOS use.

---

## Stage 0 — Nested-podman spike ✅ DONE

Validated on a Linux host. Artifacts committed under `container/`; full writeup in
`container/SPIKE-FINDINGS.md`. Nested rootless podman works **unprivileged** with
hardened host defaults intact.

**Proven outer-container recipe (supersedes the old draft flags):**
- **No `--privileged`, no `--cap-add SYS_ADMIN`**; the outer process runs as uid 1000.
- The linchpin fix: repackage `newuidmap`/`newgidmap` with **file capabilities** (not setuid-root) — this, not any host sysctl, is what makes nested userns work.
- Required `docker run` flags (each deletion-tested): `--device /dev/net/tun`, `--security-opt seccomp=container/seccomp-builder.json` (tailored, **stricter than `unconfined`**), `--security-opt apparmor=unconfined` (TODO: tailor), `--security-opt systempaths=unconfined`.
- **Native rootless overlay** storage — `/dev/fuse` dropped, ~2× faster builds.
- Restart recovery: entrypoint wipes stale `XDG_RUNTIME_DIR` runtime state, then `podman start --all` cleanly resurrects inner containers (informs Stage 4).
- No host changes needed beyond installing docker.

**Committed:** `container/{Dockerfile, run-outer.sh, entrypoint.sh, smoke.sh, seccomp-builder.json, gen-seccomp.sh, SPIKE-FINDINGS.md}`. Stages 2+ transcribe this recipe verbatim. One caveat: re-verify on a genuine Ubuntu 24.04 host (the spike box was 26.04 / kernel 7.0; the in-image podman target is 24.04).

---

## Stage 1 — Deployment metadata + deploy skill (agent-server on host) ✅ CODE COMPLETE

**Status (2026-06-12):** all code + unit tests landed in both repos; checks green
(agent-server `typecheck`/`test` 116 pass/`check`; appx `task test`). The
cross-repo **manual LLM e2e is the one remaining item** (needs a Linux box with
a container runtime + an LLM key — see *Stage 1 e2e environment* below).

### What landed

**agent-server (this repo):**
- [x] `src/contract/schemas.ts` + `openapi.json`: optional `deployment
  { dev?, prod?: { port?, url? } }` on the create request and `ProjectInfo`;
  port validated as an integer **1024–65535** → fail-fast **400** at the boundary.
- [x] `src/runtime/projectStore.ts`: `ProjectRecord.deployment?` (loader tolerates
  its absence — backward compatible) + `setDeployment`.
- [x] `src/runtime/projectRegistry.ts`: `createProject({ name, deployment })`
  persists metadata; **same-name re-POST updates it**; materialises
  `.pi/deployment.json` (stable key order `dev→prod`, `port→url`; absent ⇒ no
  file); **template seeding** via `cpSync` + skip-filter into fresh dirs only.
- [x] `src/runtime/deployment.ts` (new): pure `buildDeploymentPromptSection()` +
  `buildDeploymentJson()` — unit-tested without a runtime.
- [x] `src/runtime/projectRuntime.ts`: appends the Deployment section **after**
  `.pi/AGENTS.md` (`composeSystemPrompt`, never replacing it).
- [x] `src/config.ts`: `APPX_TEMPLATE_DIR` (optional, existence-checked) +
  `APP_CONTAINER_RUNTIME` (default `podman`).
- [x] `builder-agent/skills/deploy-app/SKILL.md` (D6 conventions; references
  `$APP_CONTAINER_RUNTIME`; never passes `*_API_KEY`).
- [x] `builder-agent/templates/vite-spa/` (new): provisional Vite SPA — lean
  multi-stage Dockerfile, single nginx runtime target, `USER nginx`, `listen
  8080`, FQ image refs.
- [x] Tests: `test/projectLifecycle.test.ts` (metadata round-trip, re-POST
  update, file written/rewritten, absent ⇒ no file, seeding fresh-vs-existing) +
  `test/deploymentPrompt.test.ts`.
- [x] Local-dev wiring documented (`.env.example`, README): `APPX_TEMPLATE_DIR`,
  `APP_CONTAINER_RUNTIME`, `PI_SKILL_PATHS` → `builder-agent/...`.

**appx (sibling repo):**
- [x] `internal/agentserver/client.go`: `EnsureProject(ctx, name, dep)` marshals
  the nested `deployment` object, omitting empty environments/fields.
- [x] `internal/project/store.go` + migration `000006_project_dev_port`:
  atomic **DEV+PROD pair allocation**, capped at `PublishedPortRangeEnd =
  10199` (**100 projects**); `assigned_port` kept as PROD, new `dev_port` column.
- [x] `internal/project/project.go`: `Deployment`/`EnvTarget` types,
  `ValidateName` rejects the reserved `-dev` suffix.
- [x] `internal/project/manager.go`: `appURL()` builds prod/dev public URLs from
  appx's external scheme/host/listen-port; payload sent on create + reconcile.
- [x] `internal/server/router.go`: subdomain dispatcher selects DEV vs PROD port
  from the `-dev` label; both stay behind auth; session cookie stripped to apps;
  WebSocket upgrade passthrough verified by test.

**agent-client (consumer):**
- [x] Re-synced `openapi/agent-server.json` + regenerated
  `src/core/agent-server.generated.ts`; `AgentProject` (= `ProjectInfo`) gains an
  optional `deployment?`. Additive, typecheck clean, 65 tests pass.

### Deviations / notes from the original checklist

- **Cap raised to 100 projects** (`10000–10199`) per follow-up decision — the
  original "~50 projects" note is superseded (see the blockquote above).
- **Repo reorg:** the deploy skill + template moved under `builder-agent/`
  (`builder-agent/skills/deploy-app`, `builder-agent/templates/vite-spa`); all
  docs/paths updated. Stage 2 must bake from these paths.
- **Deferred security hardening** (tracked in Stage 4): validate `deployment.url`
  as a bounded URL in the zod schema (defence-in-depth against prompt injection
  if the metadata source ever becomes less trusted — today the only producer is
  appx, which builds it from a slug-validated name); add `.pi` to the template
  `.dockerignore` (hygiene — keeps builder metadata out of the build context).

### Tests (Stage 1) — done

- [x] `test/projectLifecycle.test.ts` (see above)
- [x] `test/deploymentPrompt.test.ts` (dev-only / prod-only / both / absent)
- [ ] **Manual e2e** (with appx running): create project in UI (seeded template
  runs immediately) → prompt a small change → DEV URL updates → promote → PROD
  URL reflects it. This is where skill iteration happens. **Pending — run on a
  Linux box (see below).**

### Stage 1 e2e environment

The code path is host-mode (no outer container yet), so it can run anywhere with
a container runtime + an LLM key. Two viable setups:
- **macOS local** with Docker Desktop (`APP_CONTAINER_RUNTIME=docker`) — fastest
  feedback loop for **prompt/skill iteration** (Risk #3), which is the real
  purpose of the manual e2e. Recommended for the skill-quality pass.
- **Linux box** (`podman`) — closer to the eventual nested target; do this once
  to confirm the skill's literal commands behave the same under podman.

**Acceptance:** the full create → deploy → view → refine → redeploy loop works
locally with agent-server via `npm run dev` and Docker Desktop/podman as
`APP_CONTAINER_RUNTIME`. *(Code + unit tests done; manual loop pending.)*

---

## Stage 2 — Outer container image ✅ DONE (smoke green; manual e2e pending)

**Status (2026-06-12):** agent-server now runs **inside** the outer container.
`scripts/container-smoke.sh` is **green (31/31)** on the Ubuntu 26.04 / kernel
7.0 Hetzner VM (the Stage 0 box), and the Stage 0 `container/smoke.sh` still
passes (11/11) — packaging didn't regress the nesting recipe. The security
boundary is byte-for-byte the proven Stage 0 set: `docker inspect` confirms
`Privileged=false`, `CapAdd=[]`, no `no-new-privileges`, no `/dev/fuse`, with
only the `4001` + `10000-10199` publishes added. Full writeup:
`container/SPIKE-FINDINGS.md` ("Stage 2 Findings"). **The cross-repo manual LLM
e2e (host appx → container) is the one remaining item.**

Promote the **committed Stage 0 artifacts** (`container/Dockerfile`,
`run-outer.sh`, `entrypoint.sh`, `seccomp-builder.json`) from "keeps the container
alive for exec" to "runs agent-server". Keep the proven flag set and the
`newuidmap` file-cap + native-overlay fixes **verbatim** — do not reintroduce
`/dev/fuse`, `SYS_ADMIN`, or `seccomp=unconfined`.

- [x] `container/Dockerfile` — extended the spike image:
  - **multi-stage build**: a Node 22 build stage (`node:22-bookworm-slim`,
    `npm ci && npm run build && npm prune --omit=dev`) compiles agent-server;
    the pruned runtime (`dist/` + production `node_modules` + `package.json`) is
    copied into the unchanged ubuntu:24.04 podman stage. Built from the **repo
    root** (`docker build -f container/Dockerfile ..`) + a root `.dockerignore`.
  - kept the spike's rootless-podman setup (file-cap helpers, native-overlay
    `storage.conf`, `containers.conf`, subuid/subgid, volume mountpoints) **verbatim**
  - baked `builder-agent/skills/deploy-app` → `/opt/builder-agent/skills/deploy-app`;
    set `PI_SKILL_PATHS`
  - baked the Vite SPA template → `/opt/builder-agent/templates/vite-spa`; set
    `APPX_TEMPLATE_DIR`. `container-smoke.sh` builds it nested (~13 s cold) and
    runs DEV+PROD — guards against regression.
  - **Node in the final stage: NodeSource `setup_22.x`** (industry-standard for a
    pinned Node LTS on Ubuntu; keeps the proven ubuntu:24.04 base rather than a
    `node:*` base). Image ~1.03 GB (node_modules 263 MB dominates), cold build ~55 s.
- [x] `container/entrypoint.sh` — extended the spike entrypoint:
  - kept the stale-runtime-state wipe + `podman info` warmup **verbatim**
  - replaced `sleep infinity` with `node /opt/agent-server/dist/server.js`
    (`exec`'d as PID 1). Env baked: `WORKSPACE_DIR=/workspace`,
    `AGENT_SERVER_HOST=0.0.0.0`, `AGENT_SERVER_PORT=4001`,
    `APP_CONTAINER_RUNTIME=podman`, `APPX_TEMPLATE_DIR`, `PI_SKILL_PATHS`.
    Secrets (`ANTHROPIC_API_KEY`, `AGENT_SERVER_TOKEN`) arrive via `docker run -e`.
- [x] `container/run-outer.sh` — extended the spike script:
  - added `-p 127.0.0.1:4001:4001` (API) + changed the app publish to
    `-p 127.0.0.1:10000-10199:10000-10199` (200 ports; matches appx
    `PublishedPortRangeEnd = 10199`)
  - passes `-e ANTHROPIC_API_KEY -e AGENT_SERVER_TOKEN` by name (never baked);
    volumes + the proven security flags untouched
- [ ] Run the **same Stage 1 manual e2e** with host-run appx pointed at the container via `APPX_AGENT_SERVER_URL=http://127.0.0.1:4001` — zero appx code changes expected. **Pending** (needs an `ANTHROPIC_API_KEY` + host appx in `--http` mode on this VM).

### Stage 2 environment — run on Linux, not macOS, and not the live prod box

**Recommendation: do Stage 2 on a dedicated, disposable Ubuntu 24.04 Linux VM
(a Hetzner box is ideal), separate from the production server.**

Why:
- **macOS cannot run the nested setup natively.** The proven recipe (file-cap
  `newuidmap`, native rootless overlay, tailored seccomp) targets a real Linux
  kernel's user namespaces. Nested rootless podman inside a container inside
  Docker Desktop's VM is exactly the fragile "works on host, breaks nested"
  territory the staging split exists to avoid. Keep macOS for Stage 1 flow/prompt
  dev (host mode) only.
- **A fresh Ubuntu 24.04 VM also retires the one open Stage 0 caveat** — the
  spike box was 26.04 / kernel 7.0, and the in-image target is 24.04. Stage 2 on
  24.04 doubles as that re-verification.
- **Not the live production server:** Stage 2 installs docker, builds images, and
  runs experimental nested containers — don't do that next to live appx + real
  user apps. A separate cheap VM matching the prod OS gives "Linux truth" without
  risking production. (When Stage 3 lands, the *production* box runs the
  appx-supervised container; Stage 2 is the manual dress rehearsal for it.)
- **Appx stays in host mode** for Stage 2: run appx on the same VM in `--http`
  mode pointed at `APPX_AGENT_SERVER_URL=http://127.0.0.1:4001` — no appx code
  changes, so this isolates "nested environment breaks the flow" from "appx
  manages containers correctly" (that's Stage 3).
- **CI parallel:** the deterministic `container-smoke.sh` (below) runs on GitHub
  ubuntu runners (full VMs), so the infra chain is guarded on every relevant PR
  independently of whichever VM you iterate on manually.

### Tests (Stage 2)

- [x] `scripts/container-smoke.sh` (Linux): build image → run → poll `GET /` until healthy → `POST /v1/projects` with deployment metadata → assert `deployment.json` inside the container → `docker exec` the skill's literal command sequence to build **the seeded template** once and run it as DEV + PROD instances on the two ports (a realistic multi-stage build under nested rootless podman — not just nginx) → `curl 127.0.0.1:<devPort>` and `<prodPort>` from the host → restart outer container → assert registry + workspace survived + `podman start --all` recovers.
  This deliberately **bypasses the LLM**: the agent only ever runs bash commands, so executing the skill's exact commands validates all infrastructure (ports, volumes, nesting) deterministically. **Green: 31/31.** Also adds `docker inspect` assertions for the security invariants and a redeploy-isolation check (DEV changes, PROD untouched).
- [x] CI: nightly/on-demand GitHub Actions job running `container-smoke.sh` (`.github/workflows/container-smoke.yml`, `workflow_dispatch` + nightly `schedule`, ubuntu-latest full VM).

**Acceptance:** `container-smoke.sh` green on Ubuntu 26.04 ✅; Stage 1 e2e with agent-server containerised **pending** (manual LLM loop).

### Deviations / notes (Stage 2)

- **Build context moved to the repo root** so the Node build stage can compile
  agent-server (`docker build -f container/Dockerfile ..`); added a root
  `.dockerignore`. `gen-seccomp.sh` updated to match.
- **Smoke drops the named volumes up front** for determinism — a box polluted by
  earlier manual/spike runs leaves inner containers that collide on the app ports
  and would otherwise break `podman start --all`. Test hygiene, not a regression.
- **"Build once, two instances":** the smoke builds `:dev` once and `podman tag`s
  `:prod` from it (faithful to D6); redeploy rebuilds `:dev` only.
- The Stage 0 `container/smoke.sh` is kept and still passes (11/11) as the bare
  nesting baseline.

### Stage 2 → Stage 3 handoff: what's still missing for the live flow

Stage 2 proves the *nested environment* and the *contract* (appx Stage 1 already
landed: nested deployment metadata via `EnsureProject`, DEV+PROD pair allocation
capped at `PublishedPortRangeEnd = 10199` — in lock-step with this repo's
`run-outer.sh` range — and `-dev`/prod subdomain selection). What is **not** yet
built (all appx-side, tracked in the sibling `phase_9_plan.md` Stage 3):

- **appx does not manage the container.** Today the live box runs agent-server as
  a host systemd unit (`deploy/agent-server.service`); appx just talks to
  `APPX_AGENT_SERVER_URL`. Stage 3 adds `internal/containerruntime` (a docker-CLI
  `Supervisor` + fake) that `EnsureRunning`s the outer container from the **proven
  flag set transcribed verbatim from this repo's `run-outer.sh`** (the source of
  truth), behind the `APPX_AGENT_CONTAINER=true` switch, before reconcile.
- **Egress from inside the container is the most likely silent breakage.** appx's
  CONNECT egress proxy (the agent's path to the LLM) listens on loopback today;
  once agent-server is *in* the container, loopback no longer reaches it. Stage 3
  must bind it on the docker-bridge gateway and set `HTTPS_PROXY` +
  `NODE_USE_ENV_PROXY` + `--add-host=host.docker.internal:host-gateway` in the
  container env. Without this you can create/deploy but the **prompt step dies**.
- **Token becomes mandatory** in container mode (generate + persist 0600), since
  the published API port means loopback is no longer a trust boundary.
- **Mismatch detection** (never silently recreate — it kills running user apps).
- **Deploy scripts** (`system-setup.sh`/`bootstrap.sh`/`tools-install.sh`) still
  install host Node + the systemd agent-server; container mode installs docker +
  the pinned outer image instead. ~~Open decision: how the appx user invokes
  docker~~ **Resolved (Stage 4):** outer = rootful host Docker (spike T2);
  rootless-docker-outer is non-viable (nested subuid), so the `appx` user uses the
  `docker` group (root-equivalent, accepted on a dedicated box) — tighter scoping
  is Stage 5.
- **`appx/scripts/smoke-deploy.sh`** is the missing cross-service gate — the
  sibling of this repo's `container-smoke.sh`, but curling **through the appx
  subdomain proxy** (`<name>-dev.<domain>` / `<name>.<domain>`) rather than the
  loopback publish directly. That proves the full outside→appx→outer→podman→inner
  path, which `container-smoke.sh` deliberately stops short of.

Good news for Stage 3: the proxy *target* is unchanged across all stages
(`127.0.0.1:<port>` means the same thing host- or container-side), the port
ranges already match, and the handshake is live — so Stage 3 is "wrap + supervise
+ wire egress," not a re-architecture.

---

## Stage 3 — appx supervises the outer container ✅ DONE (smoke-green)

**Status (2026-06-12):** landed **appx-side** (full detail in the sibling
`phase_9_plan.md` "Stage 3 — Results"). `appx/scripts/smoke-deploy.sh` is
**green (38/38)** on the same Ubuntu 26.04 / kernel 7.0 VM: appx in container mode
creates a **healthy** outer container, registers a project, and the full deploy
chain works **through the appx subdomain proxy** (create → DEV+PROD → curl both
via the proxy → redeploy DEV (PROD unchanged) → promote → outer restart →
appx restart). `docker inspect` on the **appx-created** container confirms the
proven flag set byte-for-byte (`Privileged=false`, `CapAdd=[]`, no
`no-new-privileges`, no `/dev/fuse`, loopback-only `4001` + `10000-10199`).

What appx added (all appx-side; agent-server/the image unchanged):
`internal/containerruntime` (docker-CLI `Supervisor` + fake; verbatim `RunArgs`),
container-mode wiring in `cmd/appx/main.go` (`APPX_AGENT_CONTAINER`, token
mandatory + persisted 0600, `--recreate-agent-container`), egress bound on the
docker bridge gateway with `HTTPS_PROXY`/`NODE_USE_ENV_PROXY`/`--add-host`,
container-mode branches in the deploy scripts, and the `smoke-deploy.sh` gate.

### Cross-cutting findings (recorded for both repos)

These surfaced during Stage 3 bring-up + manual testing and affect the whole
system / upstream Pi, not just appx:

1. **Bedrock API key set via the agent-client Settings UI does NOT work — it's an
   upstream Pi gap, not appx/agent-server/the container.** The coding-agent SDK
   (`pi/packages/coding-agent/src/core/sdk.ts` `streamFn`) passes the stored
   AuthStorage credential as `options.apiKey`, but the Bedrock provider
   (`pi/packages/ai/src/providers/amazon-bedrock.ts:141`) authenticates **only**
   from `options.bearerToken` or `process.env.AWS_BEARER_TOKEN_BEDROCK`; nothing
   maps `apiKey → bearerToken` for `amazon-bedrock` (and `streamSimpleBedrock` →
   `buildBaseOptions` never sets `bearerToken`). So the key is silently ignored,
   the AWS SDK falls back to its default credential chain, and chat fails with
   **"Could not load credentials from any providers."** Reproduces identically in
   host mode. **Workaround (works today):** supply `AWS_BEARER_TOKEN_BEDROCK` (+
   `AWS_REGION`) as env vars — in container mode appx forwards them by name via
   `APPX_AGENT_ENV_PASSTHROUGH=AWS_BEARER_TOKEN_BEDROCK,AWS_REGION`. **Proper fix
   (upstream Pi):** map a stored `amazon-bedrock` api_key credential to
   `bearerToken`, or have the provider accept `options.apiKey` as the bearer token.
2. **Non-default provider endpoints need an egress allowlist entry.** appx's
   CONNECT proxy fails closed, and the default allowlist only had Anthropic/OpenAI/
   Go/npm. Bedrock inference (`bedrock-runtime.<region>.amazonaws.com:443`) was
   blocked. appx now ships `bedrock-runtime.*.amazonaws.com:443` in the default
   allowlist with **scoped DNS-wildcard matching** (`*` = one label, like a
   wildcard cert). Any other provider (Vertex, Azure, self-hosted) similarly needs
   its endpoint allowlisted.
3. **`HTTPS_PROXY` is honoured by podman, not just Node.** Injecting it
   container-wide (so agent-server's LLM traffic traverses the egress proxy) also
   routed `podman pull` of base images through the LLM allowlist → 403 on
   `registry-1.docker.io`. Fixed in appx: the container-mode default `NO_PROXY`
   bypasses common image registries (`.docker.io`, `.docker.com`, `ghcr.io`,
   `quay.io`, `gcr.io`, `registry.k8s.io`); LLM endpoints (not listed) still go
   through the proxy.
4. **`appRunning` (TCP-dial health) false-positives after an outer restart.**
   Loopback publishes use docker's userland `docker-proxy`, which accepts the
   host-side connection even when the inner backend is down, so the UI can show an
   app "running" while inner containers are `created`. Ground truth is the inner
   `podman inspect` state. Fix (Stage 5): make the health/degraded signal an
   HTTP-level probe, not a bare TCP dial.

---

## Stage 4 — Productionize (deploy is container-mode only; appx runs as a systemd service) ✅ DONE (appx-side; reboot + crash soaked)

Stage 3 proved appx supervises the container when **hand-run with env vars**.
Stage 4 makes that *the* production deployment and **removes host mode from the
deploy path entirely** — owned mostly by appx (`phase_9_plan.md`), listed here so
the shared staging stays in sync.

**Decision (2026-06-12): drop host mode from `deploy/`.** The deploy scripts +
systemd become **container-mode only**. There is no longer a host-mode toggle to
maintain, no `appx-agent` user, no `agent-server.service`, and no host install of
Node/Pi/agent-server. Local development does **not** use these scripts: a
developer runs agent-server manually (e.g. `npm run dev`) and appx in `--http`
mode pointed at `APPX_AGENT_SERVER_URL` — by hand, no systemd. This keeps the
appx **binary's** host-mode runtime capability (the `APPX_AGENT_SERVER_URL` path
is still in the code for local/macOS dev) while deleting the host-mode
**deployment** machinery that container mode supersedes.

- [x] **Strip host mode from the deploy scripts** — `system-setup.sh`: remove the
  `appx-agent` user/group, `/home/appx-agent` dirs, and the
  `agent-server.service` install/enable; **delete** `deploy/agent-server.service`
  and remove the `APPX_AGENT_CONTAINER` branch (container mode is now the only
  path). `tools-install.sh`: drop the host Pi/agent-server install; **build the
  outer image from the agent-server checkout**
  (`docker build -f <agent-server>/container/Dockerfile`), tagged
  `APPX_AGENT_IMAGE` (the Dockerfile's own multi-stage build compiles agent-server
  inside a `node:22` stage, so the prod box needs docker + the source, not host
  Node). Pinned by **tag** for now; publishing a registry image + deploy-by-digest
  is a deferred *Potential improvement* (below). `bootstrap.sh`: stop prompting for / writing
  a mode toggle; always write the container-mode `appx.env`; start only `appx`.
  Existing boxes with a stale `agent-server.service` should have it disabled +
  removed on upgrade (idempotent cleanup), not left dangling.
- [x] **systemd ordering** — appx must start after the container runtime: in
  `appx.service` (or a drop-in) `Wants=docker.service` +
  `After=docker.service network.target`. On reboot docker comes up → appx's
  idempotent `EnsureRunning` re-attaches to the existing container (no recreate).
  (No host-mode base unit to keep clean anymore, so this can live directly in
  `appx.service`.)
- [x] **Container restart policy + supervision model** — add `--restart
  unless-stopped` to `ContainerSpec.RunArgs` so the **Docker daemon** resurrects
  the outer container on process crash *and* on reboot, independent of appx. This
  closes a real Stage 3 gap: appx runs `EnsureRunning` **only at startup** (it is
  not a continuous watchdog), and the spec set no restart policy, so a
  `builder-outer` crash *while appx keeps running* was not auto-healed. The model
  to document: **the daemon keeps the container's process alive** (`--restart`);
  **appx ensures it exists / is correct / is healthy** at startup (`EnsureRunning`,
  drift detection, health poll); **`appx.service` `Restart=on-failure`** covers
  appx itself. (Whether appx also needs a periodic re-`EnsureRunning`/health loop
  vs. relying on the restart policy + the Stage 5 degraded banner is a Stage 5
  call.) Verify `--restart unless-stopped` plays well with the entrypoint's
  stale-`XDG_RUNTIME_DIR` wipe on a daemon-driven restart.
- [x] **Secrets to the service** — provider creds reach appx's process env (appx
  forwards them **by name** into the container; never baked). Put
  `ANTHROPIC_API_KEY` and/or `AWS_BEARER_TOKEN_BEDROCK` + `AWS_REGION` in
  `/etc/appx/appx.env` (0600) or an optional `EnvironmentFile=-/etc/appx/secrets.env`
  (`root:root 0600`), and set `APPX_AGENT_ENV_PASSTHROUGH` to list the extra
  names. `AGENT_SERVER_TOKEN` is generated + persisted 0600 by appx (no manual step).
  **Revised post-implementation (2026-06-13):** most providers — incl. Anthropic —
  are configured via the agent **Settings UI** like any other key (stored in the
  agent's Pi credential storage in the `builder-workspace` volume), so
  `bootstrap.sh` no longer prompts for `ANTHROPIC_API_KEY`. The service-env path
  (`secrets.env` + `APPX_AGENT_ENV_PASSTHROUGH`) is reserved for creds the UI
  can't carry — i.e. Bedrock's `AWS_BEARER_TOKEN_BEDROCK` + `AWS_REGION`.
- [x] **appx.env** — always container mode: `APPX_AGENT_CONTAINER=true`,
  `APPX_AGENT_IMAGE=<pinned tag/digest>`,
  `APPX_AGENT_SECCOMP=/etc/appx/seccomp-builder.json`. `system-setup.sh` installs
  the seccomp profile to `/etc/appx/` and sets up docker access for the appx user.
- [x] **`appx` service user → Docker access** — *Runtime is already decided +
  validated (SPIKE-FINDINGS T2): outer = **rootful host Docker**, inner = rootless
  podman. Not open* (rootless-docker-outer would reintroduce the nested
  subuid-exhaustion that killed rootless-podman-outer, and would break the
  rootful-bridge egress auto-detect — so it is **not** an option). The only thing
  to wire is how the unprivileged `appx` system user reaches the root daemon:
  **Decision — add `appx` to the `docker` group** (proven in Stages 2–3; under
  systemd `User=appx` the service inherits it after `usermod` + `daemon-reload` +
  restart). Document the residual risk honestly — docker-group membership is
  **root-equivalent** — mitigated by this being a dedicated single-purpose box +
  dedicated `appx` user. Tightening that access (a docker-socket proxy restricting
  the API surface, or a narrow sudoers rule) is **Stage 5 hardening**, not a
  blocker here.
- [x] **port 443 without root** — already handled: `appx.service` sets
  `AmbientCapabilities=CAP_NET_BIND_SERVICE` (the manual `setcap` is only for
  hand-running the binary outside systemd).
- [x] **start/restart semantics** — `Type=simple` (systemd doesn't block on
  EnsureRunning readiness). On EnsureRunning failure appx `log.Fatal`s → exits →
  `Restart=on-failure`; pick a `RestartSec` large enough that a missing image /
  down daemon doesn't hot-loop. First boot: `tools-install.sh` builds/pulls the
  pinned image before `appx.service` starts (bootstrap order: system-setup →
  tools-install → start).
- [x] **verify-installation.sh** — container-mode checks (unit active, container
  healthy, proven flags present, publishes loopback-only, secret reachable);
  remove host-mode (agent-server.service) assertions.
- [x] **Docs** — update `README`/`.env.example` so local dev is described as the
  manual no-systemd flow (run agent-server yourself + `appx --http` with
  `APPX_AGENT_SERVER_URL`); production = `bootstrap.sh` (container only).
- [x] **Soak** on a prod-like box: reboot recovery, outer-container restart
  recovery, secrets reach the container, full UI e2e over public HTTPS.
  *(Reboot + genuine-crash recovery validated on the VM; the LLM-in-the-loop UI
  e2e remains the manual pre-release step, as in Stage 3.)*

**Acceptance:** a fresh box → `bootstrap.sh` → reboot → the `appx` systemd unit is
active, the outer container is healthy, and the full UI e2e works over the public
HTTPS URL with provider creds supplied only via the service env. No `appx-agent`
user, no `agent-server.service`, no host Node/Pi/agent-server install exist on the
box. Local dev still works by hand (manual agent-server + `appx --http`).

### Stage 4 — Results (2026-06-13, appx-side; recorded here for the shared staging)

**Status:** COMPLETE (appx-side). Full detail in the sibling `phase_9_plan.md`
"Stage 4 — Results". On a fresh disposable Ubuntu 26.04 VM with rootful Docker:
appx now runs as the `appx` systemd service in container mode, ordered
`After=docker.service`; the outer container carries `--restart unless-stopped`
so the **Docker daemon** keeps it alive across crash + reboot, while appx's
startup `EnsureRunning` re-attaches idempotently (no recreate). A real VM reboot
recovered docker → appx → healthy container with no manual step;
`scripts/smoke-deploy.sh` is **41/41** (now asserting `RestartPolicy=unless-stopped`
+ daemon-driven crash recovery) and `verify-installation.sh` **61/61**. Host mode
is gone from `deploy/` (no `appx-agent` user, no `agent-server.service`, no host
Pi/agent-server); secrets reach the agent **only** via the service env
(`/etc/appx/secrets.env`, `root:root 0600`) forwarded into the container **by
name** — verified present via `docker exec printenv` and **absent** from
`journalctl -u appx`.

**Cross-repo finding (affects this repo's entrypoint):** `docker kill`/`docker
stop` do **not** trigger an `unless-stopped` restart — they set the container's
manual-stop flag, which `unless-stopped` honours by design (vs `always`). A
genuine crash (the container's main process dying) **is** restarted by the
daemon, and the entrypoint's stale-`XDG_RUNTIME_DIR` wipe composes cleanly with
that daemon-driven restart (confirmed on the live box).

**Follow-on finding + short-term fix (2026-06-13):** the entrypoint originally
wiped `XDG_RUNTIME_DIR` but did **not** `podman start --all` (despite earlier
plan wording claiming it did), so after a crash/recreate/reboot the inner DEV +
PROD app containers came back as `Created`/`Exited` and stayed **down** until the
next redeploy. Added a **short-term fix** to `container/entrypoint.sh`: after the
wipe + warmup, `podman start --all` (fail-soft via `|| true` so one bad inner
container can't crash-loop the outer one). Validated end-to-end on the live box:
a full outer recreate **and** a genuine `kill -9` crash now bring both apps back
up automatically. `--all` is deliberately blunt (see the Stage 5 item below for
the principled replacement).

---

## Stage 5 — Hardening (agent-server items)

(Stages 3–4 are appx-side; see sibling plan.)

- [ ] **Upstream Pi: Bedrock credential mapping** (cross-repo, see Stage 3 finding
  #1). Today a Bedrock key set via the Settings UI is ignored because the SDK
  passes it as `options.apiKey` while the provider only reads `options.bearerToken`
  / `AWS_BEARER_TOKEN_BEDROCK`. Fix in Pi: map a stored `amazon-bedrock` api_key
  credential to `bearerToken` (or accept `options.apiKey` in the bedrock provider),
  so the UI path works without the `AWS_BEARER_TOKEN_BEDROCK` env workaround.
- [~] Entrypoint resurrects inner apps after an outer restart: **wipe stale `XDG_RUNTIME_DIR` runtime state first**, then `podman start --all` (the spike proved bare `podman start --all` fails without the wipe). **Short-term fix landed (2026-06-13):** `entrypoint.sh` now runs `podman start --all` (fail-soft) after the wipe + warmup, covering both DEV and PROD — proven on the live box across recreate + `kill -9` crash. **Still open for Stage 5:** replace the blunt `--all` with **registry-driven reconciliation** (start exactly the containers the project registry says should be running, with DEV/PROD intent) so stale/intentionally-stopped containers aren't resurrected and published-port clashes can't occur. Architecture doc limitation #6
- [ ] Bash tool `spawnHook` strips `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `*_API_KEY` from child process env — defence in depth so keys can't leak into `podman run -e`-style invocations even by accident (OWASP secrets-management alignment; keys live in the process heap, not child envs)
- [ ] **Validate `deployment.url`** in the create-project zod schema as a bounded
  URL (`z.string().url().max(2048).optional()`) — defence-in-depth against prompt
  injection via the URL that is interpolated into the agent's system prompt.
  Today the only producer is appx (URL built from a slug-validated name + operator
  base domain), so it is not attacker-controlled; this makes that a guarantee
  rather than a property of the current caller. Requires an `openapi.json` regen +
  agent-client snapshot re-sync.
- [ ] **Add `.pi` to the app template `.dockerignore`** — hygiene so a generated
  app never copies `.pi/deployment.json` / `.pi/AGENTS.md` into its build context
  (no secrets there, and the final image already excludes it, but keep builder
  metadata out of build layers).
- [ ] Optional golden-prompt LLM smoke (manual, pre-release): "build a single-page todo app and deploy it" → assert HTTP 200 on the reserved port within N minutes. Catches prompt/skill regressions; not CI

---

## Testing strategy summary

Every networking boundary is tested by a real connection at exactly one layer and faked everywhere else:

| Layer | What | Where |
|---|---|---|
| Unit (`node:test`, every PR) | metadata round-trip, prompt section builder, config validation | this repo |
| Infra smoke (deterministic, no LLM) | full port/volume/nesting chain via skill's literal commands | `scripts/container-smoke.sh`, Linux CI |
| Cross-service smoke | appx ↔ agent-server ↔ subdomain chain | appx repo, `scripts/smoke-deploy.sh` |
| LLM e2e | prompt/skill quality | manual golden-prompt checklist |

## Potential improvements (deferred — not v1)

Validated or low-risk upgrades we defer to keep v1 simple and uniform. None
require app-specific logic in appx.

### Publish the outer image (registry + pinned digest)

Stage 4 builds `builder-outer` from the agent-server checkout **on the box** (prod
carries the source). A later improvement: build it in **CI**, push to a registry,
and set `APPX_AGENT_IMAGE=<registry>/builder-outer@sha256:…` so deploy **pulls a
pinned digest** instead of building — removing the agent-server source + build
step from prod, and making "what's running" immutable, reproducible, and
auditable. `tools-install.sh` already takes the pull path when `APPX_AGENT_IMAGE`
is a registry ref, so this is mostly a CI/registry task (decide tagging + signing,
e.g. cosign, and who owns the registry), not appx code. Deferred — building from
source is fine while the image and its base recipe are still moving.

### Durable app data (persistent volumes for stateful apps)

The deploy model rebuilds containers on every refinement/redeploy, so anything an
app writes to its **container layer is lost** on the next deploy; and the skill's
*Multi-container apps* section invites a `<project>-db` sibling without saying how
to persist it. Today this is harmless (the seeded template is a static Vite SPA
with no data), but it becomes load-bearing the first time a template/app has a
database. Add a **"Persistent data"** convention to the `deploy-app` skill — but
as a deliberate design item, not a one-line `-v` flag, because it changes the
deploy model's statefulness semantics. It must cover:

- **Named volumes, reused on redeploy, never `rm`'d.** e.g.
  `-v <project>-db-data:/var/lib/postgresql/data`. Redeploy replaces the
  *container*, never the *data volume* (a "clean up" `volume rm` = data loss).
  Volumes live under the `builder-podman-storage` named docker volume, so they
  already survive outer restart/recreate.
- **DEV/PROD data isolation.** The skill currently runs **one** shared
  `<project>-db` for both env instances — which already half-breaks "iterate on
  DEV without touching PROD," and durable data makes a bad DEV migration able to
  corrupt PROD's real data. Persistence forces a choice: separate volumes (and
  likely separate db containers) per env (`<project>-db-dev-data` /
  `<project>-db-prod-data`), or an explicit, documented "DEV and PROD share data"
  stance.
- **Migrations, not resets.** Once data survives rebuilds, schema changes must be
  migrations; "drop and recreate" silently destroys user data.
- **Cleanup on project delete.** Durable volumes leak — today
  `appx Delete → agent-server DeleteProject` removes the project dir + sessions
  but **not** podman containers/images/volumes. A stateful model needs a teardown
  hook (agent-server or the skill's "remove app" path) so volumes don't accumulate.

Deferred because v1's template has no data, and getting it right is a small design
pass (the four points above) rather than a flag. Owned by this repo (skill + D6
deploy model + template); the only appx touch-point is delete-time volume cleanup.

### Hot-reload DEV (instant refinements)

The inner-app spike (`container/INNER-APP-SPIKE.md`, T3) **proved** a faster
refinement loop is feasible: bind-mount the project dir into the DEV container
(`-v <projectDir>:/app` plus an anonymous `-v /app/node_modules` so the mount
doesn't shadow installed deps) and run the framework's dev server. The agent then
edits files in `/workspace` and the running DEV app **hot-reloads with no rebuild
or redeploy** — HMR fired across the mount on native overlay, no polling needed.

Deferred because it breaks v1's uniformity:
- It's **framework-specific** (needs a dev server with HMR; a built static app or
  a Python service has no equivalent), so it can't be the universal model.
- It reintroduces dev-server quirks the template + skill must handle — Vite's
  `server.allowedHosts` must include the project's dev subdomain (fed via env from
  `.pi/deployment.json`), and the dev server's HMR WebSocket must traverse appx's
  subdomain proxy.

Safe to add later because it needs **no appx change specific to it**:
`allowedHosts` lives in the template + skill; WebSocket forwarding is a generic
proxy capability appx needs for user apps regardless. Adopt per-template if the
rebuild-redeploy latency (a few seconds) proves to be real friction.

## Risks

1. **Nested podman flags on target OS** — retired by Stage 0 (proven recipe committed); only residual is re-verifying on a genuine Ubuntu 24.04 host.
2. **"Works on host, breaks nested"** — mitigated by D3 (`APP_CONTAINER_RUNTIME`) + skill conventions written against `deployment.json`, not host assumptions.
3. **Skill quality** — the only part needing real-LLM iteration; isolated in Stage 1 where the feedback loop is fastest (no containers in the way).
4. **Outer restart kills inner apps** — addressed in Stage 4 (stale-state wipe + `podman start --all`); appx UI already shows honest per-port health.
5. **Two ports/project** doubles subdomains and halves density per published
   port — **resolved (2026-06-12):** allocation range set to `10000–10199` (200
   ports = 100 projects). The outer-container publish range and `phase_9_plan.md`
   D1 must be kept in lock-step with `PublishedPortRangeEnd = 10199`.
6. **Refinement latency** — dev=prod means every refinement is a rebuild + redeploy (~seconds, not instant). Accepted for v1; hot-reload (see *Potential improvements*) is the escape hatch and needs no appx change.

(Realistic multi-stage builds under nesting — once a risk — are now **validated** by `container/INNER-APP-SPIKE.md`: dev+prod instances on two ports, redeploy with layer cache, and a Python app all worked unprivileged; Stage 2 smoke guards against regression.)
