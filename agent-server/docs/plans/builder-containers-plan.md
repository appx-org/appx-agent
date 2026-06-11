# Plan: Containerised Apps — agent-server Side

**Date:** 2026-06-11
**Status:** Draft
**Scope:** Deployment metadata contract, builder deploy skill/prompt, outer container image (nested rootless podman), smoke tests
**Canonical architecture:** `docs/architecture/important/builder-container-architecture.md`
**Sibling plan:** appx repo, `docs/plans/phase_9_plan.md` (control plane: port allocation, container supervision, subdomain routing)

---

## Goal

Implement agent-server's half of the containerised apps architecture:

1. appx starts ONE outer container at boot (agent-server + rootless podman inside).
2. User creates a project in the appx UI; appx allocates a port and registers the project here **with deployment metadata** (port + public URL).
3. The builder agent knows its project's port/URL and deploys the app as an inner podman container publishing that port.
4. The user sees the app on `https://<project>.<domain>`; refinement prompts lead to redeploys visible at the same URL.

## Division of labour

| Concern | Owner |
|---|---|
| Port allocation, subdomain proxy, outer container lifecycle, host deploy scripts | appx |
| Project registry + deployment metadata persistence, surfacing metadata to the agent, deploy skill, outer container **image**, podman-in-container validation | agent-server (this plan) |

agent-server stays appx-agnostic: it receives a generic `deployment` object on project create and makes it available to the agent. It never knows about subdomains, SQLite, or docker-on-the-host.

---

## Design decisions

### D1 — Deployment metadata rides on `POST /v1/projects`

Extend the create-project contract with an optional `deployment` object:

```jsonc
POST /v1/projects
{
  "name": "eventx",
  "deployment": {
    "port": 10007,                          // host/outer port reserved for this app
    "url": "https://eventx.example.com"     // where the user will see the app
  }
}
```

- Persisted on the `ProjectRecord` in `projects.json`.
- **Idempotent re-POST with the same name updates `deployment`** (today it returns the existing record untouched). This lets appx's startup reconcile heal drift — e.g. a project that predates this feature gets its port on the next boot.
- Returned by `GET /v1/projects` / `GET /v1/projects/:id` so the control plane can verify registration.

### D2 — Metadata is surfaced to the agent as file + prompt section

Two mechanisms, both generated from the same record:

1. **`<projectDir>/.pi/deployment.json`** — materialised on create/update. The agent can `cat` it any time; it survives context compaction and session restarts.
2. **System prompt injection** — `ProjectRuntime` appends a short generated "Deployment" section to the resolved system prompt when metadata exists (after the `.pi/AGENTS.md` content, never replacing it):

```
## Deployment
- Your app's reserved port: 10007. The app MUST be reachable on 127.0.0.1:10007.
- Public URL after deploy: https://eventx.example.com
- Container runtime: podman (see the deploy-app skill for build/run/redeploy conventions)
- Machine-readable copy: .pi/deployment.json
```

File-only would risk the agent never reading it; prompt-only would risk loss on compaction. Both is cheap.

### D3 — Container runtime for the agent is env config, not hardcoded

`CONTAINER_RUNTIME` env var (default `podman`), threaded into the prompt section and the skill. In the outer container it is always `podman`; in local macOS dev (Stage 1, agent-server on host) it may be `docker` (Docker Desktop) or podman-machine. The skill references `$CONTAINER_RUNTIME` so Stage 1 prompt iteration transfers untouched to the nested setup.

### D4 — Deploy conventions live in a skill, not only in AGENTS.md

Ship a `deploy-app` skill in this repo (`skills/deploy-app/SKILL.md`), loaded via `PI_SKILL_PATHS` in the outer image. Skills are versioned with agent-server, independent of any one project's `.pi/`, and the prompt section stays short (conventions load only when the agent deploys).

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

## Stage 0 — Nested-podman spike

Pure validation on a **Linux** host (Hetzner box / Lima / OrbStack VM — not macOS-native). No feature code.

- [ ] Build the draft Dockerfile from `docs/misc/other/rootless-podman-isolation.md`; fix until it works:
  - `docker run --device /dev/fuse --userns=keep-id --security-opt seccomp=unconfined ...` (trim flags to the minimal working set; document why each survivor is needed)
  - inside: `podman run -d -p 10000:80 nginx` succeeds
  - from host: `curl 127.0.0.1:10000` traverses both forwarding layers
- [ ] Verify volume-mounted `/workspace` and podman storage (`~/.local/share/containers`) survive `docker restart`
- [ ] Measure first-`podman info` warmup; confirm warmup-in-entrypoint removes first-build latency
- [ ] Record behaviour of inner containers across outer restart (expected: dead; informs Stage 4)

**Deliverables:** known-good `container/Dockerfile` + `container/run-outer.sh` (committed even if rough) and a findings note appended to this plan. Timebox: 1 day; if fundamentally blocked on the target OS, escalate to the Sysbox/alternatives discussion before building Stages 2–3.

---

## Stage 1 — Deployment metadata + deploy skill (agent-server on host)

### Contract & registry

- [ ] `src/contract`: add `deployment` (optional `{ port?: number; url?: string }`) to the create-project request and the `ProjectInfo` response schemas; regenerate `openapi.json`
- [ ] `src/runtime/projectStore.ts`: `ProjectRecord` gains optional `deployment`; loader tolerates records without it (backward compatible)
- [ ] `src/runtime/projectRegistry.ts`:
  - `createProject({ name, deployment })` persists metadata; **same-name re-POST updates `deployment`** and rewrites the materialised file
  - materialise `<projectDir>/.pi/deployment.json` (pretty-printed, stable key order) on create/update
- [ ] `src/http/projectsRoutes.ts`: accept/return the new field; validation: port must be an integer in 1024–65535 if present (reject privileged/garbage values at the boundary — fail fast)

### Runtime / prompt

- [ ] `src/config.ts`: add `CONTAINER_RUNTIME` (default `"podman"`), validated non-empty string
- [ ] `src/runtime/projectRuntime.ts`: extend `resolveSystemPrompt` (or a sibling helper) to append the generated Deployment section when the project has metadata. Keep generation in one pure function (`buildDeploymentPromptSection(deployment, containerRuntime)`) so it is unit-testable without a runtime

### Deploy skill

- [ ] `skills/deploy-app/SKILL.md` with the conventions:
  - read `.pi/deployment.json` for the reserved port and URL
  - build: `$CONTAINER_RUNTIME build -t <project>-app .` (project dir is the build context)
  - run: `$CONTAINER_RUNTIME run -d --name <project>-app -p <port>:<containerPort> <project>-app`
  - redeploy: `stop && rm && build && run` under the same `--name` (idempotent; never accumulate containers)
  - multi-container apps (db etc.): suffix names `<project>-db`, only the frontend publishes the reserved port; inter-container traffic via a `<project>` podman network
  - health check before declaring success: `curl -fsS 127.0.0.1:<port>` with retries; report the public URL to the user
  - **never** pass `*_API_KEY` env vars into app containers
- [ ] Wire the skill into local dev runs via `PI_SKILL_PATHS` (document in README); the outer image bakes it in at Stage 2

### Tests (Stage 1)

- [ ] `test/projectLifecycle.test.ts`: deployment metadata round-trips create → get → list; re-POST same name updates it; `.pi/deployment.json` written and rewritten; absent metadata ⇒ no file, no prompt section
- [ ] New `test/deploymentPrompt.test.ts`: `buildDeploymentPromptSection` output for full/partial/absent metadata
- [ ] Manual e2e (with appx running locally — see appx plan): create project in UI → prompt "build a hello-world page and deploy it" → app visible on `http://<name>.127.0.0.1.sslip.io:8080` → refinement prompt → change visible. This is where skill iteration happens.

**Acceptance:** the full create → deploy → view → refine → redeploy loop works locally with agent-server run via `npm run dev` and Docker Desktop/podman as `CONTAINER_RUNTIME`.

---

## Stage 2 — Outer container image

Turn the Stage 0 spike artifacts into the real image.

- [ ] `container/Dockerfile`:
  - base: `ubuntu:24.04`; install podman, fuse-overlayfs, uidmap, slirp4netns, git, curl, ca-certificates, Node.js LTS
  - install agent-server (copy built `dist/` + production `node_modules`, or `npm pack` artifact — pick the one that keeps the image reproducible from a git checkout)
  - non-root `builder` user (uid 1000), rootless storage config, `/workspace` as the volume mount point
  - bake `skills/deploy-app` into a fixed path and set `PI_SKILL_PATHS` accordingly
- [ ] `container/entrypoint.sh`:
  - `podman info > /dev/null` warmup (limitation #4 in the architecture doc)
  - exec agent-server (env contract unchanged: `WORKSPACE_DIR=/workspace`, `ANTHROPIC_API_KEY`, `AGENT_SERVER_TOKEN`, `CONTAINER_RUNTIME=podman`, `AGENT_SERVER_HOST=0.0.0.0` — the container boundary takes over loopback's role; the **publish** stays loopback-only on the host side)
- [ ] `container/run-outer.sh` — reference `docker run` for manual use and as the spec appx's supervisor implements at Stage 3:
  - `-p 127.0.0.1:4001:4001` (API) and `-p 127.0.0.1:10000-10099:10000-10099` (app range; see appx plan D1 for the 100-port cap rationale)
  - volumes: workspace + named volume for podman storage
  - `--device /dev/fuse` + the minimal flag set from Stage 0
- [ ] Run the **same Stage 1 manual e2e** with host-run appx pointed at the container via `APPX_AGENT_SERVER_URL=http://127.0.0.1:4001` — zero appx code changes expected

### Tests (Stage 2)

- [ ] `scripts/container-smoke.sh` (Linux): build image → run → poll `GET /` until healthy → `POST /v1/projects` with deployment metadata → assert `deployment.json` inside the container → `docker exec` the skill's literal command sequence against a canned hello-world app → `curl 127.0.0.1:<port>` from the host → restart outer container → assert registry + workspace survived.
  This deliberately **bypasses the LLM**: the agent only ever runs bash commands, so executing the skill's exact commands validates all infrastructure (ports, volumes, nesting) deterministically.
- [ ] CI: nightly/on-demand GitHub Actions job (ubuntu runners are full VMs; `--device /dev/fuse` works there) running `container-smoke.sh`

**Acceptance:** Stage 1 e2e passes with agent-server containerised; `container-smoke.sh` green on Linux.

---

## Stage 4 — Hardening (agent-server items)

(Stage 3 is appx-side; see sibling plan.)

- [ ] Entrypoint runs `podman start --all` after warmup so user apps come back after an outer restart (architecture doc limitation #6)
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

## Risks

1. **Nested podman flags on target OS** — mitigated by Stage 0 before feature investment.
2. **"Works on host, breaks nested"** — mitigated by D3 (`CONTAINER_RUNTIME`) + skill conventions written against `deployment.json`, not host assumptions.
3. **Skill quality** — the only part needing real-LLM iteration; isolated in Stage 1 where the feedback loop is fastest (no containers in the way).
4. **Outer restart kills inner apps** — accepted until Stage 4 `podman start --all`; appx UI already shows honest per-port health.
