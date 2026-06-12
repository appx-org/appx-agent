# Inner-App Spike — Realistic Builds Under Nested Rootless Podman

**Date:** 2026-06-12
**Runs on:** the same Stage 0 spikebox (the `builder-outer` container is already
built and `./container/smoke.sh` passes). This is a follow-on, not a redo.
**Parent plan:** `docs/plans/builder-containers-plan.md` (D5, D6, Stage 2)
**Findings:** record everything in the "Findings" section at the bottom of this
file as you go.

## Why

Stage 0 only proved trivial images (nginx, a one-line Alpine build) run nested.
Before we commit to the template + two-container (DEV/PROD) deploy model, prove
that a **realistic multi-stage app build** works inside the outer container under
rootless podman + native overlay — including the things the real product depends
on: two published ports, a redeploy cycle, optional hot-reload, and
stack-agnosticism.

## Hard rules

- **Do not change the outer container's flags or image hardening.** Use the
  `builder-outer` container exactly as Stage 0 left it (no `--privileged`, no new
  caps). If something only works by weakening the outer container, that's a
  finding, not a fix — stop and record it.
- Everything happens **inside** the outer container via `docker exec` / `podman`,
  in `/workspace`. Apps publish in the already-forwarded **10000–10009** range.
- You write the sample apps yourself (small, known) — this is deterministic infra
  validation, **not** an LLM app-building exercise.

## Tasks

### T1 — Multi-stage JS app, DEV + PROD, two ports
- [ ] In `/workspace/vite-sample`, scaffold a **minimal Vite app** (plain `npm create vite` SPA, no extras) with a multi-stage `Dockerfile`:
  - `dev` target: installs deps, runs the Vite dev server bound to `0.0.0.0`
  - `build` target: `vite build`
  - `prod` target: a lean final stage serving the built `dist/` (e.g. `nginx:alpine` or a tiny static server) — **only the build output**, no `node_modules`/source
- [ ] `podman build --target dev  -t vite-sample:dev  .` and `--target prod -t vite-sample:prod .` both succeed inside the outer container
- [ ] Run both at once: dev on `:10000`, prod on `:10001`
- [ ] From the **host**: `curl 127.0.0.1:10000` and `curl 127.0.0.1:10001` both return the app
- [ ] Record: build times (cold), prod image size vs dev image size, any overlay/permission errors

### T2 — Redeploy cycle + layer cache
- [ ] Edit a source file, then redeploy DEV: `podman build --target dev ... && podman rm -f <name> && podman run ...`
- [ ] Confirm the dependency-install layer is **cached** (rebuild only re-runs from the source-copy layer); record the warm rebuild time vs cold
- [ ] Confirm the change is visible via host curl

### T3 — DEV hot-reload via bind mount (the D6 open question)
- [ ] Run the DEV container with the project dir bind-mounted: `podman run -d -v /workspace/vite-sample:/app -p 10000:<devport> vite-sample:dev` (adjust workdir so the mount lands where the dev server watches)
- [ ] Edit a source file on the host side of the mount; confirm whether the Vite dev server inside the container **hot-reloads without a rebuild** (check via curl / the HMR endpoint)
- [ ] Record: does a workspace bind mount work at all under nested rootless podman? Any uid/permission issues on the mounted files? Does file-watching/HMR fire across the mount? **This decides whether D6's hot-reload option is viable or we fall back to rebuild-redeploy.**

### T4 — Stack-agnosticism smoke (non-JS)
- [ ] In `/workspace/py-sample`, a trivial **Python** app (e.g. Flask/`http.server`) with its own single-stage `Dockerfile`, published on `:10002`
- [ ] Build + run + host curl succeed
- [ ] Purpose: confirm the *mechanics* (build any Dockerfile, publish a port) are framework-neutral — so the deploy skill/metadata don't need JS assumptions

### T5 — Resource sanity on a small box
- [ ] After T1–T4, record `podman images` total size, `df -h` on the podman storage volume, and peak memory during the heaviest build (`free -m` while building)
- [ ] Note whether anything thrashed/OOM'd; this informs the outer container's `--memory`/`--cpus` limits (Stage 4) and the box sizing recommendation

## Acceptance

- T1, T2, T4 green (multi-stage dev/prod build + run + two/three ports + redeploy, JS and Python).
- T3 answered definitively (hot-reload works, or doesn't, with the reason).
- Findings section filled in. No outer-container weakening introduced.

Timebox: a couple of hours. If a multi-stage build fundamentally fails under
nesting (e.g. native overlay chokes on many layers / large `node_modules`), stop
and capture the exact error + `podman info` storage section — that's a Stage 2
blocker we need to know about now, not later.

---

## Findings

### Host / container
- Outer image + podman version (unchanged from Stage 0?):

### T1 — multi-stage dev/prod + two ports
- dev build OK? prod build OK? cold build times:
- prod vs dev image size:
- both reachable from host (10000 / 10001):
- errors / surprises:

### T2 — redeploy + cache
- dep layer cached on rebuild? warm vs cold rebuild time:
- change visible:

### T3 — bind-mount hot-reload (D6 decision)
- bind mount works under nested rootless podman?
- uid/permission issues on mounted files?
- HMR fires on host-side edit without rebuild?
- **Verdict: hot-reload viable, or fall back to rebuild-redeploy?**

### T4 — non-JS stack
- Python app build+run+curl OK?
- anything stack-specific that leaked into the mechanics?

### T5 — resources
- total image size / storage volume usage:
- peak build memory; any thrash/OOM:
- implication for outer `--memory`/`--cpus` + box sizing:

### Recommendations for the template (D5) and Stage 2
- lean prod stage approach that worked:
- anything the deploy skill must do/avoid given what you saw:
- open questions / blockers:
