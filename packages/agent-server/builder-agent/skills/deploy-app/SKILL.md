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
- **Label everything you create.** Every container, image, network and volume
  gets `--label appx.project="$PROJECT"`. Deleting the project reaps resources by
  this label; anything unlabelled survives the delete, keeps its published port
  bound, and breaks the next project that is allocated that port.
- **Use networks, not pods.** `pod create` is podman-only and a pod outlives the
  containers in it, so it cannot be reaped.
- **The app listens on a container port** (a template detail, e.g. `8080`) that
  is **not** the reserved host port.
- **Publish it as exactly two numbers:** `-p <reservedHostPort>:<containerPort>`,
  so the port is reachable on every interface of this container. The control plane
  restricts it to loopback on the host, which is what keeps it private.
- **Give each app container its own network** (`--network <project>`), or the
  default one.
- **Never pass secrets into app containers.** Do not forward `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, or any `*_API_KEY` into `run` with `-e`. The app does not
  need LLM credentials.
- **Use fully-qualified image refs** in Dockerfiles (`docker.io/library/...`).

## 1. Read the deployment metadata

```bash
cat .pi/deployment.json
```

It looks like:

```json
{
  "project": "eventx",
  "dev":  { "port": 10006, "url": "https://eventx-dev.example.com" },
  "prod": { "port": 10007, "url": "https://eventx.example.com" }
}
```

Use `dev.port`/`dev.url` for DEV and `prod.port`/`prod.url` for PROD. Find the
container port the app listens on in the project's Dockerfile (`EXPOSE` / the
server's bind port).

`project` is this project's canonical id — the value every label must carry.
Read it out once and reuse it; never retype or guess it:

```bash
PROJECT=$(node -p "require('./.pi/deployment.json').project")
```

## 2. Deploy / redeploy DEV (the iterate loop)

Rebuild the image and replace the DEV container. This is idempotent — stop and
remove any existing instance first so containers never accumulate.

```bash
$APP_CONTAINER_RUNTIME build --label appx.project="$PROJECT" -t <project>-app:dev .
$APP_CONTAINER_RUNTIME rm -f <project>-app-dev 2>/dev/null || true
$APP_CONTAINER_RUNTIME run -d --name <project>-app-dev \
  --label appx.project="$PROJECT" \
  -p <devPort>:<containerPort> <project>-app:dev
```

Every refinement rebuilds **DEV only**; PROD's URL stays stable while the user
iterates.

## 3. Promote to PROD

When the user is happy with DEV, rebuild PROD from the current source so it
matches what they approved:

```bash
$APP_CONTAINER_RUNTIME build --label appx.project="$PROJECT" -t <project>-app:prod .
$APP_CONTAINER_RUNTIME rm -f <project>-app-prod 2>/dev/null || true
$APP_CONTAINER_RUNTIME run -d --name <project>-app-prod \
  --label appx.project="$PROJECT" \
  -p <prodPort>:<containerPort> <project>-app:prod
```

## 4. Health-check before declaring success

Tell the user the app is live once it responds **and** the publish covers every
interface. Both matter: a response alone can come back from a port only this
container can reach.

```bash
for i in $(seq 1 10); do
  curl -fsS "127.0.0.1:<port>" >/dev/null && break
  sleep 1
done
curl -fsS "127.0.0.1:<port>" >/dev/null || { echo "FAILED: app not responding"; exit 1; }

# Expect "<containerPort>/tcp -> 0.0.0.0:<port>".
$APP_CONTAINER_RUNTIME port <project>-app-dev | grep -q '0\.0\.0\.0:' \
  && echo "up" \
  || echo "FAILED: re-run the container with -p <hostPort>:<containerPort>"
```

If the second check fails, remove the container and run it again with that exact
`-p` form; a published binding cannot be changed in place.

Then report the relevant **public URL** (`dev.url` after a DEV deploy,
`prod.url` after a promote) — not the loopback address.

## Multi-container apps (db, cache, etc.)

If the app needs a database or other service, run it as sibling containers on a
shared `<project>` network — **one sidecar per environment**, mirroring the
app's DEV/PROD split: `<project>-db-dev` and `<project>-db-prod`. **Only the
app containers publish host ports**, in the same two-number form as above;
siblings are reached by container name over the shared network (the DEV app
connects to `<project>-db-dev`, the PROD app to `<project>-db-prod`). Secrets
for those services are app config, never LLM keys.

Label the network and every named volume as well, so they are reaped with the
project:

```bash
$APP_CONTAINER_RUNTIME network create --label appx.project="$PROJECT" <project>
$APP_CONTAINER_RUNTIME volume create --label appx.project="$PROJECT" <project>-db-dev-data
$APP_CONTAINER_RUNTIME run -d --name <project>-db-dev \
  --label appx.project="$PROJECT" \
  --network <project> -v <project>-db-dev-data:/var/lib/postgresql/data <image>
```

and the same for PROD with `<project>-db-prod` + `<project>-db-prod-data`. Run
the app containers with `--network <project>` too, so they can reach their
sidecars.

### Persistent data rules

- **DEV and PROD never share a database or a volume.** The user iterates
  against DEV; a bad DEV migration or a data reset must not be able to touch
  PROD's real data. That isolation is exactly why the volumes are
  `<project>-db-dev-data` / `<project>-db-prod-data`, never one shared volume.
- **Redeploy replaces containers, never data volumes.** A redeploy or promote
  may `rm -f` and re-run the `-db-dev`/`-db-prod` *containers*, but must reuse
  the existing named volume. Never run `volume rm` on a data volume when
  redeploying or "cleaning up" — that is user data loss. Volumes are removed
  only when the project itself is deleted (the reaper finds them by label).
- **Schema changes are migrations, not resets.** Once data persists across
  redeploys, never "drop and recreate" the database to apply a schema change —
  apply migrations against the existing data. Prove a migration on DEV first,
  then promote and run the same migration against PROD's volume.
