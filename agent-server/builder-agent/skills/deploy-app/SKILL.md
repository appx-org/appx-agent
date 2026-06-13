---
name: deploy-app
description: Build and run a project's app as DEV + PROD containers on the ports the control plane allocated. Use whenever the user wants to see, deploy, refine, or promote their app.
---

# deploy-app

Deploy this project as **two containers built from the same image** — a DEV
instance you iterate against and a PROD instance that stays stable until you
promote. The control plane (appx) owns the ports and public URLs; you never
choose a port. Read them from `.pi/deployment.json`.

The container runtime is `$APP_CONTAINER_RUNTIME` (e.g. `podman` in the builder
container, `docker` in local macOS dev). Use that variable in every command —
never hardcode `podman` or `docker`.

## The contract

- **dev = prod.** One Dockerfile, one build target, **no `--target`**. DEV and
  PROD differ only by image tag, container name, and host port.
- **The app listens on a container port** (a template detail, e.g. `8080`) that
  is **not** the reserved host port. Always map `-p <reservedHostPort>:<containerPort>`.
- **Never pass secrets into app containers.** Do not forward `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, or any `*_API_KEY` into `run` with `-e`. The app does not
  need LLM credentials.
- **Loopback only.** Do not publish on `0.0.0.0`; appx is the only edge. Do not
  use `--network=host`.
- **Use fully-qualified image refs** in Dockerfiles (`docker.io/library/...`).

## 1. Read the deployment metadata

```bash
cat .pi/deployment.json
```

It looks like:

```json
{
  "dev":  { "port": 10006, "url": "https://eventx-dev.example.com" },
  "prod": { "port": 10007, "url": "https://eventx.example.com" }
}
```

Use `dev.port`/`dev.url` for DEV and `prod.port`/`prod.url` for PROD. Find the
container port the app listens on in the project's Dockerfile (`EXPOSE` / the
server's bind port).

## 2. Deploy / redeploy DEV (the iterate loop)

Rebuild the image and replace the DEV container. This is idempotent — stop and
remove any existing instance first so containers never accumulate.

```bash
$APP_CONTAINER_RUNTIME build -t <project>-app:dev .
$APP_CONTAINER_RUNTIME rm -f <project>-app-dev 2>/dev/null || true
$APP_CONTAINER_RUNTIME run -d --name <project>-app-dev \
  -p <devPort>:<containerPort> <project>-app:dev
```

Every refinement rebuilds **DEV only**; PROD's URL stays stable while the user
iterates.

## 3. Promote to PROD

When the user is happy with DEV, rebuild PROD from the current source so it
matches what they approved:

```bash
$APP_CONTAINER_RUNTIME build -t <project>-app:prod .
$APP_CONTAINER_RUNTIME rm -f <project>-app-prod 2>/dev/null || true
$APP_CONTAINER_RUNTIME run -d --name <project>-app-prod \
  -p <prodPort>:<containerPort> <project>-app:prod
```

## 4. Health-check before declaring success

Do not tell the user the app is live until a request succeeds on the host port:

```bash
for i in $(seq 1 10); do
  curl -fsS "127.0.0.1:<port>" >/dev/null && break
  sleep 1
done
curl -fsS "127.0.0.1:<port>" >/dev/null && echo "up" || echo "FAILED"
```

Then report the relevant **public URL** (`dev.url` after a DEV deploy,
`prod.url` after a promote) — not the loopback address.

## Multi-container apps (db, cache, etc.)

If the app needs a database or other service, run them as sibling containers
named `<project>-db` etc. on a shared `<project>` network
(`$APP_CONTAINER_RUNTIME network create <project>`). **Only the app container
publishes the reserved host port(s);** inter-container traffic stays on the
network. Secrets for those services are app config, never LLM keys.
