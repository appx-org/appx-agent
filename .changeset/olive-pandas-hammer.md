---
"@appx-org/agent-server": minor
---

Make DB/cache sidecars actually work, with DEV/PROD data isolation.

The outer image installed podman with `--no-install-recommends`, which drops the
CNI `dnsname` plugin — so sibling containers on a `podman network create`
network could never be reached by container name, breaking the deploy-app
skill's entire multi-container section. The plugin is now installed explicitly.

The skill's multi-container section now mandates per-environment sidecars
(`<project>-db-dev` / `<project>-db-prod`) with per-environment data volumes
(`<project>-db-dev-data` / `<project>-db-prod-data`), states that redeploys
replace containers but never remove data volumes, and requires migrations
instead of drop-and-recreate once data persists. Drift-guard tests pin the new
conventions, and `container-smoke.sh` gains a deterministic sidecar step
(labelled network + DNS by name + volume durability) plus delete-reap checks
for the labelled network and volume.
