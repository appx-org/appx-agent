#!/usr/bin/env bash
# Stage 0 acceptance test — exits 0 iff every REQUIRED check passes.
#
# This is the spike's definition of done (docs/plans/stage0-spike-brief.md).
# It validates the full nested chain on a fresh box:
#   host → docker port publish → outer container → rootless podman → inner app
#
# Checks marked [observe] never fail the run; their outcome is recorded for
# SPIKE-FINDINGS.md (e.g. whether inner containers survive an outer restart).
set -uo pipefail
cd "$(dirname "$0")"

readonly NAME="builder-outer"
readonly APP_PORT=10000
PASS_COUNT=0
FAIL_COUNT=0

# ── helpers ──────────────────────────────────────────────────────────────────

pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

check() { # check <description> <command...>
	local description="$1"
	shift
	if "$@" > /tmp/smoke-last.log 2>&1; then
		pass "$description"
	else
		fail "$description"
		sed 's/^/    | /' /tmp/smoke-last.log | tail -n 15
	fi
}

outer_exec() { docker exec "$NAME" "$@"; }

curl_app() {
	curl -fsS --retry 10 --retry-delay 1 --retry-connrefused --retry-all-errors \
		"http://127.0.0.1:${APP_PORT}" > /dev/null
}

# ── 1. fresh outer container ─────────────────────────────────────────────────

echo "[1] build + start outer container"
check "run-outer.sh brings up the outer container" ./run-outer.sh

echo "[2] outer container is unprivileged"
check "main process uid is 1000 (builder)" \
	bash -c "[ \"\$(docker exec $NAME id -u)\" = '1000' ]"
check "container is not privileged" \
	bash -c "[ \"\$(docker inspect -f '{{.HostConfig.Privileged}}' $NAME)\" = 'false' ]"

echo "[3] podman works inside (warmup ran in entrypoint; see 'docker logs $NAME' for timing)"
check "podman info succeeds" outer_exec podman info

# ── 2. inner run: pull + serve + full port chain ─────────────────────────────

echo "[4] inner container serves through both forwarding layers"
outer_exec podman rm -f spike-web > /dev/null 2>&1
check "podman run nginx publishing :${APP_PORT}" \
	outer_exec podman run -d --name spike-web \
	-p "${APP_PORT}:80" docker.io/library/nginx:alpine
check "host curl 127.0.0.1:${APP_PORT} reaches the inner nginx" curl_app

# ── 3. inner build: storage driver + build path ──────────────────────────────

echo "[5] podman build works inside"
check "podman build of a trivial image" outer_exec bash -c '
	build_dir=$(mktemp -d) &&
	printf "FROM docker.io/library/alpine:3.20\nRUN echo built-ok > /built\n" \
		> "$build_dir/Dockerfile" &&
	podman build -q -t spike-build-test "$build_dir"
'
check "built image runs and contains its layer" outer_exec bash -c \
	'[ "$(podman run --rm spike-build-test cat /built)" = "built-ok" ]'

# ── 4. restart semantics ─────────────────────────────────────────────────────

echo "[6] outer restart: persistence + recovery"
outer_exec bash -c "echo persists > /workspace/spike-marker" > /dev/null 2>&1
docker restart "$NAME" > /dev/null
sleep 3

check "workspace volume survived restart" outer_exec bash -c \
	'[ "$(cat /workspace/spike-marker)" = "persists" ]'
check "podman image store survived restart" outer_exec bash -c \
	'podman images --format "{{.Repository}}" | grep -q spike-build-test'

inner_state=$(outer_exec podman inspect -f '{{.State.Status}}' spike-web 2>/dev/null || echo "gone")
echo "  [observe] inner container state after outer restart: ${inner_state}"
if outer_exec podman start spike-web > /dev/null 2>&1 && curl_app; then
	echo "  [observe] 'podman start' resurrected the inner app (good for Stage 4: podman start --all)"
	pass "app reachable again after restart (via podman start)"
else
	echo "  [observe] 'podman start' did NOT resurrect it — record in findings; trying re-create"
	outer_exec podman rm -f spike-web > /dev/null 2>&1
	check "app reachable again after restart (via re-create)" outer_exec \
		podman run -d --name spike-web -p "${APP_PORT}:80" docker.io/library/nginx:alpine
	check "host curl after re-create" curl_app
fi

# ── summary ──────────────────────────────────────────────────────────────────

echo
echo "──────────────────────────────────────────"
echo "smoke result: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
if [ "$FAIL_COUNT" -eq 0 ]; then
	echo "STAGE 0 SMOKE: PASS"
	exit 0
fi
echo "STAGE 0 SMOKE: FAIL"
exit 1
