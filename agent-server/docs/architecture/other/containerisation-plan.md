I've read through both codebases. Before proposing the plan, here's the grounding — what already exists and what the real gaps are.

## Current state (gap analysis)

**Already built (more than the doc's "What Needs to Be Built" assumes):**

| Piece | Status |
|---|---|
| agent-server multi-project registry, `/v1/projects` lifecycle, per-project sessions, shared AuthStorage | ✅ done |
| appx → agent-server registration (`agentserver.Client`, `EnsureProject`/`DeleteProject`, startup reconcile) | ✅ done |
| appx port allocation (10000–10999 in SQLite, atomic) | ✅ done |
| appx subdomain proxy `<name>.<domain>` → `127.0.0.1:<assignedPort>` | ✅ done |
| Chat proxy/mirror (`/api/pi/...`) with allow-list | ✅ done |
| Bearer token seam (`AGENT_SERVER_TOKEN`) | ✅ done |

**Actual gaps:**

1. **Port → agent handshake.** appx allocates the port but agent-server never learns it. The builder agent has no way to know it must run `podman run -p 10007:3000`. There's no metadata field on `POST /v1/projects`.
2. **Builder deploy conventions** — system prompt / skill telling the agent: podman exists, here's your port, here's the redeploy procedure, name containers `<project>-app`.
3. **Outer container image** — Dockerfile with nested rootless podman (the draft in `rootless-podman-isolation.md` is untested).
4. **appx managing the outer container** — today the deploy is two systemd units on the host; nothing in Go touches docker.
5. **Ops glue** — egress proxy reachability from inside the container, restart semantics (inner containers die with outer), volumes, deploy script rewrite.

## Key design decisions to lock first

These determine how cleanly the stages compose, so I'd decide them up front:

**D1 — Port strategy: publish the appx port range on the outer container at create time.**
`docker run -p 127.0.0.1:10000-10099:10000-10099`. The decisive argument: **appx's subdomain proxy already targets `127.0.0.1:<port>` and needs zero changes** whether agent-server runs on host (early stages) or in the container (later stages). Caveats:
- Docker spawns a `docker-proxy` process per published port — shrink the range to ~100 ports (single admin doesn't need 1000 projects; the DB range constant can stay, just cap allocation).
- Escalation path if it ever hurts: a single in-container reverse proxy (agent-server itself or caddy) on one published port, with appx sending `X-Appx-Port`. Don't build it now; it's a clean swap later because appx's routing is already centralized in one handler.
- Reject `--network=host` — it throws away the network isolation boundary the whole architecture exists for.

**D2 — Deployment metadata handshake: extend `POST /v1/projects` with a `deployment` object.**
appx sends `{name, deployment: {port: 10007, url: "https://eventx.example.com"}}`; agent-server persists it in `projects.json` **and materializes it as `<project>/.pi/deployment.json`** so the agent can `cat` it, plus injects a short deployment section into the system prompt context. File + prompt beats prompt-only: survives context compaction, agent can re-read it.

**D3 — Outer container management in Go: shell out to the `docker` CLI behind an interface, not the Docker SDK.**
A `containerruntime` package with an interface (matching the existing `AgentRegistrar` fake-based testing pattern), implemented by exec-ing `docker` with `--format json`. Rationale: one container's lifecycle (ensure image, create, start, inspect, health-wait) doesn't justify the Docker SDK's dependency tree, and CLI-compat means the host runtime can be docker *or* podman for free. Industry practice is split here; for this scope CLI wins on simplicity and testability.

**D4 — Builder agent's container runtime is config, not hardcoded.**
In dev on macOS you'll run agent-server on the host where the "podman" might be podman-machine or Docker Desktop. Make the deploy skill reference `$CONTAINER_RUNTIME` (default `podman`) so stage-1 dev work transfers untouched to the nested setup.

## Staging: yes — podman-first, outer container later, plus one early de-risking spike

Your instinct is right, with one amendment. The user-visible flow (steps 2–6 of your list) is ~80% of the work and is **completely independent of the outer container** — prompt engineering, the port handshake, redeploy UX all behave identically whether agent-server is containerized. The outer container is packaging/ops. *But* there's one real risk in deferring it: "works on host, breaks nested" — nested rootless podman has fragile flags (`/dev/fuse`, fuse-overlayfs, uidmap, seccomp). So:

### Stage 0 — Nested-podman spike (timeboxed, ~1 day, parallel to everything)
Pure validation, no feature code. On a Linux box (Hetzner/Lima/OrbStack VM — **not** macOS-native):
- Build the draft Dockerfile from `rootless-podman-isolation.md`, fix it until `podman run -d -p 10000:80 nginx` works inside, and `curl 127.0.0.1:10000` works from the host through both forwarding layers.
- Verify: volume-mounted `/workspace` and podman storage survive container restart; `podman info` warmup time; behavior after `docker restart`.
- **Deliverable:** a known-good `Dockerfile` + `run-outer.sh` checked into `agent-server/` (or `appx/deploy/`), and a short findings note. This de-risks stages 3–4 and informs the stage-1 skill conventions.

### Stage 1 — Full user flow, agent-server on host ("podman without outer container")
The whole loop from your list (create project → agent builds app → container → subdomain → refine → redeploy), minimal moving parts:

- **agent-server:** `deployment` metadata on project create (contract + `ProjectStore` record + `deployment.json` materialization + system-prompt injection). All unit-testable with the existing `node:test` suites — extend `projectLifecycle.test.ts`.
- **appx:** `agentserver.Client.EnsureProject` gains the deployment payload (port from the store record, URL from `BaseDomain`); `Manager.Create` threads it through. Unit-test with the existing fake-registrar pattern.
- **Builder deploy skill/prompt:** conventions — read `.pi/deployment.json`, `$CONTAINER_RUNTIME build -t <project>-app .`, run with `-p <port>:<appPort>`, named containers, redeploy = `stop && rm && run`, health-check with curl before declaring success. This is where iteration time goes.
- **Dev environment:** `task local` on macOS + Docker Desktop/podman-machine as the agent's runtime. The appx health checker (`AppRunning` TCP dial) already gives the UI deploy status for free.

**Acceptance:** your steps 2–6 work end-to-end on `*.127.0.0.1.sslip.io` locally, including the refinement/redeploy cycle.

### Stage 2 — agent-server inside the outer container, started manually
Take the Stage 0 image, make it real: install agent-server in it, entrypoint (podman warmup, env-key injection — already supported via `ANTHROPIC_API_KEY` config), volumes for `/workspace` + podman storage, publish `127.0.0.1:4001` + the app port range. Run it via script/compose; point host-run appx at it via `APPX_AGENT_SERVER_URL` — **no appx code changes**, because of D1.

**Acceptance:** the exact Stage 1 e2e passes with agent-server containerized. This isolates "does the nested environment break the flow" from "does appx manage containers correctly".

### Stage 3 — appx creates/supervises the outer container at startup
- `internal/containerruntime`: interface + docker-CLI implementation + fake; ensure-image / create-if-missing / start / health-wait (poll agent-server `/`), reconcile on appx boot.
- Config: `APPX_AGENT_CONTAINER=true`, image ref, port range, key passthrough, generated `AGENT_SERVER_TOKEN` (now **mandatory** — the port is published, and OWASP A01 says don't rely on loopback alone once another party could reach it).
- Egress: outer container needs `--add-host=host.docker.internal:host-gateway` and `HTTPS_PROXY` pointed at the host egress proxy; the proxy must listen on the docker bridge, not just loopback — this is a real change to check in `egress.ProxyAddr`.
- Rewrite `deploy/`: drop `agent-server.service`, system-setup installs docker, appx.service gains docker group access.

**Acceptance:** fresh VM → bootstrap → appx up → container exists → full e2e.

### Stage 4 — Hardening
- **Restart semantics:** outer restart kills inner apps (doc limitation #6). Cheapest fix: entrypoint runs `podman start --all` after warmup; appx `AppRunning` already reflects reality in the UI either way.
- bash-tool `spawnHook` stripping `*_API_KEY` from child env (defense in depth per the architecture doc).
- `--memory`/`--cpus` on the outer container; idle-runtime eviction only if memory proves a problem.
- Security review pass (you have a precedent format in `docs/security/`).

## Testing strategy (the cross-service/networking question)

Apply the test pyramid, with an explicit rule for what each layer is allowed to touch:

**1. Unit tests (every PR, no docker, both repos).** Everything behind seams: deployment-metadata plumbing (node:test), port-capped allocation, `containerruntime` logic against a fake CLI runner, client payloads against `httptest` fake agent-server. The repos already do exactly this style — extend, don't invent.

**2. Deterministic infra smoke test — the key idea: bypass the LLM.** The expensive, flaky part of e2e is the agent; but the agent only ever runs bash commands. So script the *exact commands the deploy skill prescribes*:
- `scripts/smoke-deploy.sh`: start agent-server (host or container per stage) + `appx --http`, create a project via `POST /api/projects`, assert agent-server has it with the right port in `deployment.json`, then deploy a canned hello-world app by running the skill's literal command sequence (via `docker exec` into the outer container in stages 2+), and `curl http://<name>.127.0.0.1.sslip.io:8080` expecting 200. Then redeploy a modified version and assert the change is visible.
- This validates ports, volumes, proxy chain, registration — everything except LLM judgment — deterministically and in seconds-to-minutes.

**3. Nested-container integration (Linux only, CI nightly or on-demand).** Stages 0/2/3 artifacts get a GitHub Actions job (ubuntu runners are full VMs; `--device /dev/fuse` works there — the podman project itself tests podman-in-docker this way): build outer image, run, podman hello-world inside, full port-chain curl. Don't attempt this on macOS at all; accept that macOS dev covers stage-1-shaped flows and Linux covers nesting.

**4. LLM e2e — manual checklist + one optional scripted "golden prompt".** ("Build a single-page todo app and deploy it.") Asserts HTTP 200 on the subdomain within N minutes. Run before releases, not in CI — it's for catching prompt/skill regressions, and it's the only layer where prompt quality is visible.

The principle threading through: **every networking boundary gets tested by a real connection at exactly one layer, and faked everywhere else.** No mocked-docker unit tests pretending to verify port forwarding, and no LLM in the loop for infrastructure verification.

## Risk register (worth keeping visible)

1. **Nested podman flags on target OS** — mitigated by Stage 0 spike before feature investment.
2. **Port-range publish overhead** — mitigated by capping at ~100; escalation to in-container proxy is pre-designed (D1).
3. **macOS/Linux divergence** — accepted and bounded: macOS = flow/prompt dev, Linux = nesting truth.
4. **Outer restart kills apps** — Stage 4 `podman start --all`; UI already shows honest status.
5. **Egress proxy reachability from container** — explicitly scoped into Stage 3; easy to forget and "works in dev" (where agent-server is on host).
6. **Token becomes security-critical at Stage 3** — published port means bearer auth is no longer optional.

---

Rough effort: Stage 0 ~1 day, Stage 1 ~2–3 days (mostly skill iteration), Stage 2 ~1 day, Stage 3 ~2–3 days, Stage 4 ~1–2 days.

Want me to write this up as `docs/plans/` entries in the respective repos (the agent-server contract change and the appx container-supervisor design each deserve a short ADR), and/or create todos for the stages so work can be claimed per-stage?