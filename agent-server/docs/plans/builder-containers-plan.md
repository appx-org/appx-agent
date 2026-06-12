# Plan: Containerised Apps — agent-server Side

**Date:** 2026-06-11 (updated 2026-06-12 with Stage 1 results)
**Status:** Stage 0 ✅ done · Stage 1 ✅ code-complete + unit-tested (manual e2e pending) · Stages 2–4 pending
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
| 2 | agent-server inside the outer container, started manually | agent-server | ⏭ next (Linux VM) |
| 3 | appx creates/supervises the outer container at startup | appx | pending |
| 4 | Hardening (restarts, key stripping, resource limits) | both | pending |

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

## Stage 2 — Outer container image

Promote the **committed Stage 0 artifacts** (`container/Dockerfile`,
`run-outer.sh`, `entrypoint.sh`, `seccomp-builder.json`) from "keeps the container
alive for exec" to "runs agent-server". Keep the proven flag set and the
`newuidmap` file-cap + native-overlay fixes **verbatim** — do not reintroduce
`/dev/fuse`, `SYS_ADMIN`, or `seccomp=unconfined`.

- [ ] `container/Dockerfile` — extend the spike image:
  - **multi-stage build** (lift orchestrator's pattern): a Node build stage that compiles agent-server, then copy the pruned runtime into the spike's ubuntu:24.04 stage (e.g. `npm ci && build` then copy `dist/` + production deps; orchestrator uses `pnpm deploy --prod /app`)
  - keep the spike's rootless-podman setup (file-cap helpers, native-overlay `storage.conf`, `containers.conf`, subuid/subgid) unchanged
  - bake `builder-agent/skills/deploy-app` at a fixed path; set `PI_SKILL_PATHS`
  - bake the **app template** (provisional: a minimal Vite SPA, see D5 — lean multi-stage, single runtime target, non-root) at a fixed path; set `APPX_TEMPLATE_DIR`. `container-smoke.sh` builds it under nested rootless podman (proven in the inner-app spike; the smoke guards against regression)
- [ ] `container/entrypoint.sh` — extend the spike entrypoint:
  - keep the stale-runtime-state wipe + `podman info` warmup
  - replace `sleep infinity` with agent-server (env: `WORKSPACE_DIR=/workspace`, `ANTHROPIC_API_KEY`, `AGENT_SERVER_TOKEN`, `APP_CONTAINER_RUNTIME=podman`, `APPX_TEMPLATE_DIR=...`, `AGENT_SERVER_HOST=0.0.0.0` — the container boundary takes over loopback's role; the **publish** stays loopback-only on the host side)
- [ ] `container/run-outer.sh` — extend the spike script:
  - add `-p 127.0.0.1:4001:4001` (API) alongside the app-port range publish,
    now `-p 127.0.0.1:10000-10199:10000-10199` (200 ports = 100 projects × a
    DEV+PROD pair; must match appx's `PublishedPortRangeEnd = 10199`)
  - keep volumes (workspace + named podman-storage volume) and the proven security flags
- [ ] Run the **same Stage 1 manual e2e** with host-run appx pointed at the container via `APPX_AGENT_SERVER_URL=http://127.0.0.1:4001` — zero appx code changes expected

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

- [ ] `scripts/container-smoke.sh` (Linux): build image → run → poll `GET /` until healthy → `POST /v1/projects` with deployment metadata → assert `deployment.json` inside the container → `docker exec` the skill's literal command sequence to build **the seeded template** once and run it as DEV + PROD instances on the two ports (a realistic multi-stage build under nested rootless podman — not just nginx) → `curl 127.0.0.1:<devPort>` and `<prodPort>` from the host → restart outer container → assert registry + workspace survived.
  This deliberately **bypasses the LLM**: the agent only ever runs bash commands, so executing the skill's exact commands validates all infrastructure (ports, volumes, nesting) deterministically.
- [ ] CI: nightly/on-demand GitHub Actions job (ubuntu runners are full VMs; `--device /dev/fuse` works there) running `container-smoke.sh`

**Acceptance:** Stage 1 e2e passes with agent-server containerised; `container-smoke.sh` green on Linux.

---

## Stage 4 — Hardening (agent-server items)

(Stage 3 is appx-side; see sibling plan.)

- [ ] Entrypoint resurrects inner apps after an outer restart: **wipe stale `XDG_RUNTIME_DIR` runtime state first**, then `podman start --all` (the spike proved bare `podman start --all` fails without the wipe; `entrypoint.sh` already does this — confirm it covers both DEV and PROD containers). Architecture doc limitation #6
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
