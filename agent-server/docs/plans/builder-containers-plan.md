# Plan: Containerised Apps — agent-server Side

**Date:** 2026-06-11
**Status:** Draft
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

> **appx-side implication (track in `phase_9_plan.md`):** appx must allocate a **pair** of ports per project and route **two** subdomains (prod `…<domain>`, dev e.g. `…-dev.<domain>`). The 100-port publish cap therefore means ~50 projects, not 100 — revisit the cap there.

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

Ship a `deploy-app` skill in this repo (`skills/deploy-app/SKILL.md`), loaded via `PI_SKILL_PATHS` in the outer image. Skills are versioned with agent-server, independent of any one project's `.pi/`, and the prompt section stays short (conventions load only when the agent deploys).

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

| Stage | What | Repo focus |
|---|---|---|
| 0 | Nested rootless podman spike (timeboxed ~1 day) | agent-server |
| 1 | Full user flow with agent-server **on host** ("podman without outer container") | both |
| 2 | agent-server inside the outer container, started manually | agent-server |
| 3 | appx creates/supervises the outer container at startup | appx |
| 4 | Hardening (restarts, key stripping, resource limits) | both |

Rationale: the user-visible flow (Stage 1) is ~80% of the value and is independent of the outer container; the outer container is packaging. The Stage 0 spike de-risks the one thing that could invalidate Stage 1 decisions — nested podman flag fragility ("works on host, breaks nested").

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

## Stage 1 — Deployment metadata + deploy skill (agent-server on host)

### Contract & registry

- [ ] `src/contract`: add `deployment` (optional `{ dev?: {port?, url?}; prod?: {port?, url?} }`) to the create-project request and the `ProjectInfo` response schemas; regenerate `openapi.json`
- [ ] `src/runtime/projectStore.ts`: `ProjectRecord` gains optional `deployment`; loader tolerates records without it (backward compatible)
- [ ] `src/runtime/projectRegistry.ts`:
  - `createProject({ name, deployment })` persists metadata; **same-name re-POST updates `deployment`** and rewrites the materialised file
  - materialise `<projectDir>/.pi/deployment.json` (pretty-printed, stable key order) on create/update
  - **template seeding (D5):** when the project dir is created fresh and `APPX_TEMPLATE_DIR` is set, recursively copy it in (skip `node_modules`/`.next`/`dist`/caches); leave existing dirs untouched. Lift orchestrator's `cpSync` + filter implementation
- [ ] `src/http/projectsRoutes.ts`: accept/return the new field; validation: each present port must be an integer in 1024–65535 (reject privileged/garbage values at the boundary — fail fast)
- [ ] `src/config.ts`: add `APPX_TEMPLATE_DIR` (optional; absent ⇒ no seeding)

### Runtime / prompt

- [ ] `src/config.ts`: add `APP_CONTAINER_RUNTIME` (default `"podman"`), validated non-empty string
- [ ] `src/runtime/projectRuntime.ts`: extend `resolveSystemPrompt` (or a sibling helper) to append the generated Deployment section when the project has metadata. Keep generation in one pure function (`buildDeploymentPromptSection(deployment, containerRuntime)`) so it is unit-testable without a runtime

### Deploy skill

- [ ] `skills/deploy-app/SKILL.md` with the conventions (DEV + PROD, per D6 — same build, two instances):
  - read `.pi/deployment.json` for the dev/prod ports and URLs
  - DEV (refine): `$APP_CONTAINER_RUNTIME build -t <project>-app:dev .` → `run -d --name <project>-app-dev -p <devPort>:<containerPort> <project>-app:dev`
  - PROD (promote): `$APP_CONTAINER_RUNTIME build -t <project>-app:prod .` → `run -d --name <project>-app-prod -p <prodPort>:<containerPort> <project>-app:prod`
  - no `--target`: the template's Dockerfile has one final (lean, non-root) image; DEV and PROD differ only by tag/instance/port
  - redeploy: `stop && rm && build && run` under the same `--name` (idempotent; never accumulate containers); refinements rebuild **DEV only**, promote rebuilds PROD
  - `<containerPort>` is a template detail (e.g. 8080); always map `-p <reserved host port>:<containerPort>`, never assume they're equal
  - multi-container apps (db etc.): suffix names `<project>-db`, only the app publishes the reserved port(s); inter-container traffic via a `<project>` podman network
  - health check before declaring success: `curl -fsS 127.0.0.1:<port>` with retries; report the relevant public URL to the user
  - **never** pass `*_API_KEY` env vars into app containers
- [ ] Wire the skill into local dev runs via `PI_SKILL_PATHS` (document in README); the outer image bakes it in at Stage 2

### Tests (Stage 1)

- [ ] `test/projectLifecycle.test.ts`: deployment metadata (dev+prod) round-trips create → get → list; re-POST same name updates it; `.pi/deployment.json` written and rewritten; absent metadata ⇒ no file, no prompt section; **template seeding** copies into a fresh dir and skips an existing one
- [ ] New `test/deploymentPrompt.test.ts`: `buildDeploymentPromptSection` output for dev-only / prod-only / both / absent metadata
- [ ] Manual e2e (with appx running locally — see appx plan): create project in UI (seeded template runs immediately) → prompt a small change → DEV URL updates → promote → PROD URL reflects it. This is where skill iteration happens.

**Acceptance:** the full create → deploy → view → refine → redeploy loop works locally with agent-server run via `npm run dev` and Docker Desktop/podman as `APP_CONTAINER_RUNTIME`.

---

## Stage 2 — Outer container image

Promote the **committed Stage 0 artifacts** (`container/Dockerfile`,
`run-outer.sh`, `entrypoint.sh`, `seccomp-builder.json`) from "keeps the container
alive for exec" to "runs agent-server". Keep the proven flag set and the
`newuidmap` file-cap + native-overlay fixes **verbatim** — do not reintroduce
`/dev/fuse`, `SYS_ADMIN`, or `seccomp=unconfined`.

- [ ] `container/Dockerfile` — extend the spike image:
  - **multi-stage build** (lift orchestrator's pattern): a Node build stage that compiles agent-server, then copy the pruned runtime into the spike's ubuntu:24.04 stage (e.g. `npm ci && build` then copy `dist/` + production deps; orchestrator uses `pnpm deploy --prod /app`)
  - keep the spike's rootless-podman setup (file-cap helpers, native-overlay `storage.conf`, `containers.conf`, subuid/subgid) unchanged
  - bake `skills/deploy-app` at a fixed path; set `PI_SKILL_PATHS`
  - bake the **app template** (provisional: a minimal Vite SPA, see D5 — lean multi-stage, single runtime target, non-root) at a fixed path; set `APPX_TEMPLATE_DIR`. `container-smoke.sh` builds it under nested rootless podman (proven in the inner-app spike; the smoke guards against regression)
- [ ] `container/entrypoint.sh` — extend the spike entrypoint:
  - keep the stale-runtime-state wipe + `podman info` warmup
  - replace `sleep infinity` with agent-server (env: `WORKSPACE_DIR=/workspace`, `ANTHROPIC_API_KEY`, `AGENT_SERVER_TOKEN`, `APP_CONTAINER_RUNTIME=podman`, `APPX_TEMPLATE_DIR=...`, `AGENT_SERVER_HOST=0.0.0.0` — the container boundary takes over loopback's role; the **publish** stays loopback-only on the host side)
- [ ] `container/run-outer.sh` — extend the spike script:
  - add `-p 127.0.0.1:4001:4001` (API) alongside the existing app-port range publish (now a **pair-aware** range; see appx plan for the revised cap given two ports/project)
  - keep volumes (workspace + named podman-storage volume) and the proven security flags
- [ ] Run the **same Stage 1 manual e2e** with host-run appx pointed at the container via `APPX_AGENT_SERVER_URL=http://127.0.0.1:4001` — zero appx code changes expected

### Tests (Stage 2)

- [ ] `scripts/container-smoke.sh` (Linux): build image → run → poll `GET /` until healthy → `POST /v1/projects` with deployment metadata → assert `deployment.json` inside the container → `docker exec` the skill's literal command sequence to build **the seeded template** once and run it as DEV + PROD instances on the two ports (a realistic multi-stage build under nested rootless podman — not just nginx) → `curl 127.0.0.1:<devPort>` and `<prodPort>` from the host → restart outer container → assert registry + workspace survived.
  This deliberately **bypasses the LLM**: the agent only ever runs bash commands, so executing the skill's exact commands validates all infrastructure (ports, volumes, nesting) deterministically.
- [ ] CI: nightly/on-demand GitHub Actions job (ubuntu runners are full VMs; `--device /dev/fuse` works there) running `container-smoke.sh`

**Acceptance:** Stage 1 e2e passes with agent-server containerised; `container-smoke.sh` green on Linux.

---

## Stage 4 — Hardening (agent-server items)

(Stage 3 is appx-side; see sibling plan.)

- [ ] Entrypoint resurrects inner apps after an outer restart: **wipe stale `XDG_RUNTIME_DIR` runtime state first**, then `podman start --all` (the spike proved bare `podman start --all` fails without the wipe; `entrypoint.sh` already does this — confirm it covers both DEV and PROD containers). Architecture doc limitation #6
- [ ] Bash tool `spawnHook` strips `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `*_API_KEY` from child process env — defence in depth so keys can't leak into `podman run -e`-style invocations even by accident (OWASP secrets-management alignment; keys live in the process heap, not child envs)
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
5. **Two ports/project halves project density** under appx's published-port cap and doubles subdomains — tracked in `phase_9_plan.md`; revisit the cap.
6. **Refinement latency** — dev=prod means every refinement is a rebuild + redeploy (~seconds, not instant). Accepted for v1; hot-reload (see *Potential improvements*) is the escape hatch and needs no appx change.

(Realistic multi-stage builds under nesting — once a risk — are now **validated** by `container/INNER-APP-SPIKE.md`: dev+prod instances on two ports, redeploy with layer cache, and a Python app all worked unprivileged; Stage 2 smoke guards against regression.)
