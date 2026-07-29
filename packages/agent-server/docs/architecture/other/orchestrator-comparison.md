# appx-orchestrator vs. agent-server + appx

**Date:** 2026-06-12
**Context:** `appx-orchestrator` is a parallel implementation of the same
`docs/architecture/important/builder-container-architecture.md`. It is further
along on product surface (template, preview, theme) but stops at the network
edge. This doc is the concise "what to borrow, what to avoid, how appx closes
the gap" reference.

Both share the same core: one agent-server process, per-project builder agents,
one outer container, rootless podman, inner app-only containers. They diverge on
**how the app reaches the user**, **who owns the app's port**, and **how
hardened the outer container is**.

---

## 1. Good things worth adopting into agent-server

| Feature | What it is | Adoption note |
| --- | --- | --- |
| **App template seeding** | A runnable Next.js app baked into the outer image; copied into `/workspace/<project>` on first `POST /v1/projects`. Projects start as a working app, not an empty dir. | Highest-value borrow. agent-server needs the `templateDir` + `cpSync` seam (orchestrator already has it; ours doesn't yet). |
| **Iframe preview UX** | Live app embedded next to the chat panel. | The product surface users love. appx makes it work remotely (§3). |
| **DEV/PROD container split** | Multi-stage template Dockerfile: `dev` (hot-reload, preview) vs `prod` (built, served). | Good lifecycle model; adopt the multi-stage template. |
| **Theme bridge** | Shell theme propagates into the app via `--app-*` CSS tokens + origin-checked `postMessage`; app can push `appx:start-prompt`. | Nice-to-have polish; adopt once the core loop works. |
| **Global builder `AGENTS.md`** | Entrypoint installs a shared builder system prompt into `.pi-global/AGENTS.md`. | Complements our planned `deploy-app` skill — use both (prompt for "you're a builder", skill for deploy mechanics). |
| **Headless backend / client-only UI** | `agent-client` is imported only by the frontend; agent-server has zero UI deps. | We already do this (appx embeds the React UI). Confirms the boundary is right. |

---

## 2. Issues with the orchestrator approach

| # | Issue | Why it bites |
| --- | --- | --- |
| 1 | **Dangerously weakened outer container (the security boundary).** `run.sh` uses `--cap-add SYS_ADMIN` + `seccomp=unconfined` + `apparmor=unconfined` (+ `--device /dev/fuse`). | `--cap-add SYS_ADMIN` gives the outer container nearly-root powers over the host kernel (mounting, namespaces — the classic container-escape toolkit). Combined with their disabled seccomp+AppArmor, it badly weakens the very sandbox the whole design depends on — and our spike showed it's unnecessary: a 3-line `newuidmap` fix removes the need for it entirely (§3), with ~2× faster builds too. |
| 2 | **Localhost-only preview — unusable on a deployed server.** The iframe `src` is `http://127.0.0.1:<port>`, and an iframe URL is resolved by the *viewer's browser*, not the server. | `127.0.0.1` always means "the machine asking" — i.e. the viewer's own laptop. It only works when the browser and the outer container are the **same machine** (a dev laptop). Host orchestrator on a server (e.g. Hetzner) and open it from your laptop: the shell + chat still work (chat is proxied server-side), but the preview iframe asks *your laptop* for `127.0.0.1:<port>`, where nothing is running → blank. Pointing it at the server's IP instead doesn't save it: that's an unauthenticated, non-TLS, port-collision-prone exposure, and an `http://` iframe inside an HTTPS shell is blocked as mixed content. **Net: the orchestrator preview is a single-machine dev tool; it cannot show a hosted app to a remote user.** |
| 3 | **Agent-authoritative ports + `app.json` discovery.** The agent picks a port from a fixed 3000–3010 range and writes `.pi/app.json`; the shell reads (and must sanitize) that agent-supplied URL. | See §2.3 — fragile, insecure, and inverts the authority we want. ~10 ports also caps concurrent apps and invites collisions. |
| 4 | **No external exposure.** No reverse proxy, no public URL, no per-user routing. | You can't hand anyone a link to a built app. The "PROD container" in the docs has no mechanism behind it — aspirational. |
| 5 | **No TLS, no auth in front of apps.** | Any attempt to expose the raw port range is unauthenticated + unencrypted. An HTTPS shell also can't embed an `http://` iframe (mixed-content block). |
| 6 | **Thin control plane.** The Next.js `app-shell` has no egress control, no durable per-project/user records, no health model beyond a preview ping. | No allowlist on outbound agent traffic; no multi-tenant accounting. |

**Root cause of 2–5:** the preview is built on the assumption that the viewer
sits at the machine running the app. The moment it's hosted, that assumption is
false.

### 2.3 Why `app.json` is an anti-pattern for us (the port-authority point)

orchestrator is **agent-authoritative** on the port: the agent chooses it, so
the shell has no other way to learn it — hence the agent writes `.pi/app.json`
and the shell reads it back. That forces:

- **Fragility** — routing depends on an LLM correctly writing a file: it can be
  missing, malformed, or stale after a redeploy.
- **A security smell** — the control plane consumes **agent-authored data for
  routing**, so it must sanitize an agent-supplied URL (orchestrator literally
  has `sanitizePreviewUrl`). If you have to sanitize it, you shouldn't be
  trusting it as a source of truth.
- **Inverted authority** — it reintroduces, through the back door, the agent
  control over ports that a deterministic design removes.

We want the opposite direction of authorship:

> **`deployment.json` (ours): written by the control plane, read by the agent — an instruction.**
> **`app.json` (theirs): written by the agent, read by the control plane — a discovery.**

In our model **appx allocates the port** and already knows the URL at allocation
time. There is nothing to discover. The agent's only obligation is to **publish
the app on the port appx assigned** (`podman run -p <assigned>:<internal>`).
Readiness — the one useful thing `app.json` gave orchestrator — is covered
better by appx's own **TCP health check on the assigned port** (the existing
`AppRunning`): deterministic, ground-truth, agent-independent. So `app.json` is
dropped entirely.

---

## 3. How appx unblocks each issue

appx is the **public edge + control plane** that orchestrator lacks.

| Issue (§2) | appx capability that resolves it |
| --- | --- |
| 1 — weakened outer container | Our **Stage 0 spike** outer image: file-cap `newuidmap` (drops `SYS_ADMIN`), **tailored seccomp** (replaces `unconfined`), **native overlay** (drops `/dev/fuse`, ~2× faster). Restores all three sandbox barriers — strictly more secure + faster. Adopt into the outer image; orchestrator's builder should too. |
| 2 — localhost-only preview | **Subdomain reverse proxy.** Each project gets `https://<project>.<domain>`, resolved server-side to the inner container's loopback port → the iframe loads from **any** browser, anywhere. |
| 3 — agent ports + app.json | appx **allocates a dedicated port per project** (durable store) and **pushes it down** as `deployment.json` + prompt context. The agent *must* publish on that port; it never chooses one. No agent-written routing file; readiness via appx's port health check. Stable, collision-free, deterministic URLs. |
| 4 — no external exposure | appx **is** the public origin. It routes `Host: <project>.<domain>` → `127.0.0.1:<assignedPort>` inside the host. "PROD" stops being aspirational: the subdomain *is* the production surface. |
| 5 — no TLS/auth | appx **terminates TLS** (Let's Encrypt via CertMagic) and runs **auth middleware in front of every app and the chat**. HTTPS end-to-end means the iframe embeds cleanly; auth means apps aren't open to the world. |
| 6 — thin control plane | appx adds the **egress allowlist proxy**, durable per-project records, password auth, and a real health model. |

**Iframe caveat appx turns into a non-issue:** because appx is the doorman in
front of every app, it can set/strip `X-Frame-Options` / CSP `frame-ancestors`
at the proxy, so framing works over HTTPS regardless of what the generated app
emits.

---

## 4. Target shape (the synthesis)

> Take orchestrator's **product surface** — template seeding, iframe preview,
> DEV/PROD split, theme bridge — and run it on **our agent-server**, with **appx
> providing the edge** (subdomain + TLS + auth + **deterministic port
> allocation**) and the **hardened outer container** from the Stage 0 spike.

Result: *build on a server, view the live app from anywhere — embedded in an
iframe or at its own URL — securely.* That is precisely what orchestrator cannot
do today and what the appx control plane exists to enable.

**Port authority — decided, not open:** appx allocates → the agent must bind the
app to that port via podman → appx routes the subdomain to it and health-checks
it. No agent-authored `app.json`; the control plane owns the address end to end.
