#!/usr/bin/env bash
# Outer-container entrypoint (Stage 2).
#
# 1. Provision the runtime dir rootless podman expects (no systemd-logind here).
# 2. Wipe stale XDG_RUNTIME_DIR transient state so `docker restart` recovers
#    cleanly (Stage 0 finding — load-bearing for Stage 4 podman start --all).
# 3. Warm up podman storage so the first real build/run isn't slow and so a
#    broken nested environment is visible in `docker logs` immediately.
# 4. exec the CMD — Stage 2: agent-server (node dist/server.js). exec keeps Node
#    as PID 1 so docker stop/restart signals reach it directly.
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
       "${XDG_RUNTIME_DIR:?}/netns" "${XDG_RUNTIME_DIR:?}/crun" 2>/dev/null || true

echo "[entrypoint] podman warmup starting ($(date -Is))"
if time podman info > /tmp/podman-info.log 2>&1; then
	echo "[entrypoint] podman warmup OK"
else
	# Don't die on a warmup failure: agent-server still starts (so /v1 is
	# reachable and the failure is visible via logs / the agent's first podman
	# call) instead of crash-looping the whole container.
	echo "[entrypoint] WARNING: podman info FAILED — see /tmp/podman-info.log:"
	tail -n 20 /tmp/podman-info.log || true
fi

# Resurrect inner app containers after an outer restart/crash/reboot. The named
# ~/.local/share/containers volume preserves each app container's definition, but
# `docker restart`/a daemon-driven restart leaves them in 'Created'/'Exited', so
# without this the user's deployed apps stay DOWN until the next redeploy.
#
# `|| true` is load-bearing: this runs under `set -euo pipefail`, so one
# un-startable inner container must NOT abort the entrypoint and crash-loop the
# whole outer container (same fail-soft stance as the warmup above). Runs after
# the XDG_RUNTIME_DIR wipe so podman's pause process is freshly valid.
#
# SHORT-TERM FIX (Stage 5 follow-up): `--all` is deliberately blunt — it starts
# every container that exists, including intentionally-stopped or stale ones from
# old deploys, with no DEV/PROD intent and possible published-port clashes. The
# principled replacement is registry-driven reconciliation (start exactly the
# containers the project registry says should be running). Acceptable today given
# the strict one-DEV/one-PROD-per-project model. Pairs with the Stage 5 HTTP-probe
# health fix (the appRunning TCP dial false-positives during this startup window).
echo "[entrypoint] resurrecting inner app containers (podman start --all)"
podman start --all > /tmp/podman-start-all.log 2>&1 || \
	echo "[entrypoint] WARNING: 'podman start --all' had failures — see /tmp/podman-start-all.log (continuing)"

exec "$@"
