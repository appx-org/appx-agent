#!/usr/bin/env bash
# Outer-container entrypoint (Stage 0 spike).
#
# 1. Provision the runtime dir rootless podman expects (no systemd-logind here).
# 2. Warm up podman storage so the first real build/run isn't slow and so a
#    broken nested environment is visible in `docker logs` immediately.
# 3. Exec the CMD (spike: sleep infinity; Stage 2: agent-server).
set -euo pipefail

mkdir -p "${XDG_RUNTIME_DIR:-/tmp/runtime-$(id -un)}"

echo "[entrypoint] podman warmup starting ($(date -Is))"
if time podman info > /tmp/podman-info.log 2>&1; then
	echo "[entrypoint] podman warmup OK"
else
	# Don't die: keep the container alive so the spike agent can exec in and debug.
	echo "[entrypoint] WARNING: podman info FAILED — see /tmp/podman-info.log:"
	tail -n 20 /tmp/podman-info.log || true
fi

exec "$@"
