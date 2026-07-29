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
- [x] In `/workspace/vite-sample`, scaffold a **minimal Vite app** (plain `npm create vite` SPA, no extras) with a multi-stage `Dockerfile`:
  - `dev` target: installs deps, runs the Vite dev server bound to `0.0.0.0`
  - `build` target: `vite build`
  - `prod` target: a lean final stage serving the built `dist/` (e.g. `nginx:alpine` or a tiny static server) — **only the build output**, no `node_modules`/source
- [x] `podman build --target dev  -t vite-sample:dev  .` and `--target prod -t vite-sample:prod .` both succeed inside the outer container
- [x] Run both at once: dev on `:10000`, prod on `:10001`
- [x] From the **host**: `curl 127.0.0.1:10000` and `curl 127.0.0.1:10001` both return the app
- [x] Record: build times (cold), prod image size vs dev image size, any overlay/permission errors

### T2 — Redeploy cycle + layer cache
- [x] Edit a source file, then redeploy DEV: `podman build --target dev ... && podman rm -f <name> && podman run ...`
- [x] Confirm the dependency-install layer is **cached** (rebuild only re-runs from the source-copy layer); record the warm rebuild time vs cold
- [x] Confirm the change is visible via host curl

### T3 — DEV hot-reload via bind mount (the D6 open question)
- [x] Run the DEV container with the project dir bind-mounted: `podman run -d -v /workspace/vite-sample:/app -p 10000:<devport> vite-sample:dev` (adjust workdir so the mount lands where the dev server watches)
- [x] Edit a source file on the host side of the mount; confirm whether the Vite dev server inside the container **hot-reloads without a rebuild** (check via curl / the HMR endpoint)
- [x] Record: does a workspace bind mount work at all under nested rootless podman? Any uid/permission issues on the mounted files? Does file-watching/HMR fire across the mount? **This decides whether D6's hot-reload option is viable or we fall back to rebuild-redeploy.**

### T4 — Stack-agnosticism smoke (non-JS)
- [x] In `/workspace/py-sample`, a trivial **Python** app (e.g. Flask/`http.server`) with its own single-stage `Dockerfile`, published on `:10002`
- [x] Build + run + host curl succeed
- [x] Purpose: confirm the *mechanics* (build any Dockerfile, publish a port) are framework-neutral — so the deploy skill/metadata don't need JS assumptions

### T5 — Resource sanity on a small box
- [x] After T1–T4, record `podman images` total size, `df -h` on the podman storage volume, and peak memory during the heaviest build (`free -m` while building)
- [x] Note whether anything thrashed/OOM'd; this informs the outer container's `--memory`/`--cpus` limits (Stage 4) and the box sizing recommendation

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

**Status:** COMPLETE — T1, T2, T4 green; T3 answered definitively (hot-reload
**viable**); T5 recorded. **No outer-container weakening introduced** —
`docker inspect` confirms `Privileged=false`, `CapAdd=[]`; the `builder-outer`
image and `run-outer.sh` flags are byte-for-byte the Stage 0 set. Re-ran
`./container/smoke.sh` first: 11/11 PASS.

Method note: the outer container has **no node/npm** (correct — app builds happen
*inside* podman using base images). Sample apps were hand-written (deterministic,
per the brief) and `docker cp`'d into the `/workspace` volume as uid 1000
(`builder`). All `curl`s below are from the **host** through both forwarding
layers (host → docker publish `127.0.0.1:1000x` → outer → rootless podman →
inner app).

### Host / container
- Outer image base `ubuntu:24.04`; inner podman **4.9.3**; native rootless
  **overlay** (`Store.GraphDriverName=overlay`, no `mount_program`). Unchanged
  from Stage 0. Outer main process uid 1000, `Privileged=false`, no added caps.
- Box: 4 vCPU / 7.6 GiB RAM / 75 GiB disk (same Hetzner VM as Stage 0).
- `docker.io/library/node:20-alpine` pulled in ~3 s; native overlay healthy.

### T1 — multi-stage dev/prod + two ports
- **dev build OK, prod build OK.** Cold times inside the outer container:
  **dev ~6.8 s** (npm install dominates; base image pre-pulled), **prod ~2.2 s**
  (its `build` stage reuses the `deps`/`npm install` layer already built for dev,
  then `vite build` + nginx copy). A fully cold `--no-cache` dev build is ~6.5 s.
- **prod 63.7 MB vs dev 239 MB** (~3.7× smaller). Prod = `nginx:alpine` + the
  built `dist/` only; dev = `node:20-alpine` + `node_modules`.
- **Both reachable from host:** `:10000` (dev) served the Vite HTML *with*
  `/@vite/client` injected (dev server live) and served transformed source at
  `/src/main.js`; `:10001` (prod) served the hashed/bundled assets, and the
  bundle contained `BUILD_MARKER_V1` (proves it's the real build output).
- **prod is non-root:** container runs as `uid=101(nginx)`; image has **no
  `/app`, no `node_modules`, no source** — only `index.html` + `assets/`.
  Achieved with a custom `nginx.conf` (pid + temp paths under `/tmp`, `listen
  8080`) + `USER nginx`.
- **No overlay/permission errors.** Multi-stage build over native overlay was
  clean; no layer-count or `node_modules`-size problems at this (minimal-SPA) scale.

### T2 — redeploy + cache
- **Dep layer cached.** After editing `src/main.js`, the warm `--target dev`
  rebuild printed `Using cache` for `COPY package.json` **and** `RUN npm install`;
  only `COPY . .` (source) re-ran. **Warm rebuild ~0.67 s vs ~6.8 s cold** (~10×).
- **Change visible:** `rm -f && run` redeploy on `:10000`, host curl of
  `/src/main.js` returned the edited `BUILD_MARKER_V2`.

### T3 — bind-mount hot-reload (D6 decision)
- **Bind mount works** under nested rootless podman:
  `podman run -v /workspace/vite-sample:/app -v /app/node_modules ...`. The Vite
  dev server started normally (`ready in 183 ms`).
- **uid/permissions:** files owned by uid 1000 (`builder`) on the outer appear as
  `uid=0(root)` *inside* the inner container — the expected rootless-podman
  container-root ↔ outer-user mapping. **No permission issues**; files read/served
  fine. **Gotcha (not a blocker):** a bare `-v <proj>:/app` makes the host dir
  **shadow the image's `/app/node_modules`** and the dev server can't find its
  deps. Fix used: add an **anonymous volume `-v /app/node_modules`** to keep the
  image's installed deps under the mount. The deploy skill MUST do this for the
  hot-reload path.
- **HMR fires on host-side edit without rebuild:** edited `src/main.js`
  V2→V3 on the workspace side; with **no rebuild and no restart** the dev server
  served `BUILD_MARKER_V3` and logged `[vite] page reload src/main.js`. inotify
  propagates across the bind mount on native overlay — **no `usePolling` needed**.
- **Verdict: hot-reload is VIABLE.** D6's optional bind-mount hot-reload works
  under nested rootless podman. Recommend the DEV container use it (bind mount +
  anon `node_modules` volume); rebuild-redeploy remains the fallback and is what
  PROD/promote uses anyway.

### T4 — non-JS stack
- **Python/Flask: build + run + host curl all OK** on `:10002`. Single-stage
  `python:3.12-alpine` Dockerfile; **`pip install` works under nesting** (cold
  build ~6.2 s). Host curl returned `PY_MARKER_V1 flask-sample ok`.
- **Nothing stack-specific leaked.** Identical mechanics as JS: write a
  Dockerfile, `podman build -t`, `podman run -p hostPort:containerPort`. The
  only contract is "a Dockerfile that publishes on the given port" — no JS
  assumptions. Confirms D5's stack-agnosticism premise.

### T5 — resources
- **Images:** nominal sizes — node:20-alpine 138 MB, nginx:alpine 63.7 MB,
  python:3.12-alpine 57.6 MB, vite dev 239 MB, vite prod 63.7 MB, py 71.2 MB.
  **Actual on-disk podman storage volume: ~404 MB** (overlay layer dedup; the
  alpine/node/nginx bases are shared across images).
- **Peak build memory: ~1469 MB used** during a `--no-cache` dev build
  (baseline ~1128 MB → build adds **~340 MB**). **No thrash, no OOM** (`dmesg`
  clean); the 7.6 GiB box was never near pressure. Builds are largely
  single-core and short.
- **Implication for outer `--memory`/`--cpus` + box sizing:** build peaks are
  modest (~350 MB delta) and brief; for the outer container, `--cpus 2` is
  enough for snappy builds and a generous `--memory` (e.g. 2–4 GiB) leaves wide
  headroom. At scale the **steady-state footprint of many idle inner containers**
  (50 projects × 2) will dominate, not build spikes — size the box for resident
  containers + image storage, not for build bursts. A 2 vCPU / 4 GiB box handles
  the build/deploy loop comfortably; storage grows ~tens of MB per project after
  base-image dedup.

### Recommendations for the template (D5) and Stage 2
- **Lean prod stage that worked (use as the template's shape):**
  `build` stage runs `vite build`; `prod` = `nginx:alpine` + custom `nginx.conf`
  (pid & temp paths under `/tmp`, `listen 8080`) + `COPY --from=build dist/` +
  `USER nginx`. Result: 63.7 MB, non-root, no source/deps shipped. Avoids
  orchestrator's "ship the whole build tree as root" anti-pattern (D5).
- **`deps` layer as a cache anchor:** `COPY package.json* && RUN npm install`
  *before* `COPY . .`, with `dev`/`build` both `FROM deps`. Gives sub-second warm
  redeploys (T2) and lets prod's build reuse dev's install.
- **Deploy skill MUST do / avoid:**
  - **Hot-reload DEV:** `-v <projectDir>:/app` **plus** `-v /app/node_modules`
    (anon volume) — without the second, the mount shadows deps and the dev server
    breaks. (JS-specific; the skill should apply it only when a deps dir would be
    shadowed.)
  - **Don't assume container port 80.** The non-root prod stage listens on **8080**
    and dev on **5173**; the skill maps `-p <reservedPort>:<containerPort>`, so the
    container port is a template detail, not the reserved appx port. Keep them distinct.
  - **Use fully-qualified image refs** (`docker.io/library/...`) in template
    Dockerfiles — podman 4.9.3 has no implicit Docker Hub default; short names can
    prompt/fail non-interactively. All builds here used FQ refs and were clean.
  - Bind 0.0.0.0 in the dev server (`vite.config.js server.host`); prod nginx is fine.
- **Open questions / blockers:** none blocking Stage 2.
  - **Vite `allowedHosts` (verify + likely fix at Stage 1/3):** we only curled
    via `127.0.0.1`, which Vite always allows, so the spike never exercised this.
    Vite 5.4.x ships a `Host`-header allow-list (anti DNS-rebinding). Served
    through appx's public **`*-dev.<domain>`** subdomain, the dev server sees a
    domain that isn't on its list and answers *"Blocked request. This host is not
    allowed."* — the user gets an error instead of their app. **PROD is
    unaffected** (plain nginx, no host check). Fix: set
    `server.allowedHosts` in the template's `vite.config.js`. Since the template
    is baked once but the domain is per-project, make it env-driven and let the
    deploy skill pass the value from `.pi/deployment.json`:
    ```js
    const devHost = process.env.VITE_DEV_ALLOWED_HOST;
    server: { host: "0.0.0.0", port: 5173,
              allowedHosts: devHost ? [devHost] : [] }
    ```
    then `podman run -e VITE_DEV_ALLOWED_HOST=eventx-dev.example.com ...`.
    Alternatives: a leading-dot wildcard `[".example.com"]` (all dev subdomains
    under one owned domain) or `true` (disable the check) — looser. Decide when
    the template + skill are written; one-line change, not an infra blocker.
  - **HMR websocket through the proxy (sibling of the above):** HMR uses a
    `ws://`/`wss://` upgrade on the same published dev port and the same domain;
    it worked on loopback here. appx's subdomain proxy must forward the WS
    upgrade or the app loads but hot-reload silently dies —
    track in the appx plan.
  - The `container-smoke.sh` (Stage 2) should build **this Vite template's**
    `dev`+`prod` targets and the bind-mount hot-reload run, not just nginx, to
    keep these guarantees from regressing.
