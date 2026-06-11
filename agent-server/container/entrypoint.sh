#!/usr/bin/env bash
# Outer-container entrypoint (Stage 0 spike).
#
# 1. Provision the runtime dir rootless podman expects (no systemd-logind here).
# 2. Warm up podman storage so the first real build/run isn't slow and so a
#    broken nested environment is visible in `docker logs` immediately.
# 3. Exec the CMD (spike: sleep infinity; Stage 2: agent-server).
set -euo pipefail

mkdir -p "${XDG_RUNTIME_DIR:-/tmp/runtime-$(id -un)}"

# XDG_RUNTIME_DIR is supposed to be ephemeral (tmpfs, wiped on boot). Here it
# lives in the container filesystem, so it SURVIVES `docker restart` — but the
# rootless-podman pause process it points at does NOT. The stale pause-pid then
# makes every podman call fail with:
#   "invalid internal status, try resetting the pause process with
#    'podman system migrate': could not find any running process"
# Wiping the transient runtime state on each boot restores clean-start
# semantics; persistent state (images/containers metadata) lives in the
# ~/.local/share/containers named volume and is untouched.
rm -rf "${XDG_RUNTIME_DIR:?}/libpod" "${XDG_RUNTIME_DIR:?}/containers" \
       "${XDG_RUNTIME_DIR:?}/netns" 2>/dev/null || true

echo "[entrypoint] podman warmup starting ($(date -Is))"
if time podman info > /tmp/podman-info.log 2>&1; then
	echo "[entrypoint] podman warmup OK"
else
	# Don't die: keep the container alive so the spike agent can exec in and debug.
	echo "[entrypoint] WARNING: podman info FAILED — see /tmp/podman-info.log:"
	tail -n 20 /tmp/podman-info.log || true
fi

exec "$@"
