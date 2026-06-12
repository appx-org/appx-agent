#!/usr/bin/env bash
# Stage 2 infra smoke — DETERMINISTIC, NO LLM. Exits 0 iff every REQUIRED check
# passes. This is the Stage 2 gate (docs/plans/builder-containers-plan.md).
#
# The agent only ever runs bash, so executing the deploy-app skill's LITERAL
# command sequence validates the entire chain without an LLM:
#
#   host → docker publish → outer container → agent-server (4001)
#                                          ↘ rootless podman → inner nginx (app)
#
# It builds the REAL seeded Vite template (a multi-stage build under nested
# rootless podman — not just nginx), runs it as DEV + PROD instances, redeploys
# DEV in isolation, and verifies survival across an outer-container restart.
#
# Checks marked [observe] never fail the run; their outcome is recorded for the
# findings. Everything else exits non-zero on failure.
#
# Determinism: this script removes the named volumes up front so a polluted box
# (e.g. leftover containers from manual spike runs that collide on the app
# ports) can never make the gate flap. Run it on a disposable Linux VM.
set -uo pipefail
cd "$(dirname "$0")/../container"

readonly NAME="builder-outer"
readonly TOKEN="container-smoke-token"
readonly PROJECT="smoke-app"
readonly DEV_PORT=10000
readonly PROD_PORT=10001
readonly APP_PORT=8080   # the vite-spa template's container port (nginx listen)
PASS_COUNT=0
FAIL_COUNT=0

# ── helpers ──────────────────────────────────────────────────────────────────

pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

check() { # check <description> <command...>
	local description="$1"
	shift
	if "$@" > /tmp/csmoke-last.log 2>&1; then
		pass "$description"
	else
		fail "$description"
		sed 's/^/    | /' /tmp/csmoke-last.log | tail -n 15
	fi
}

outer_exec() { docker exec "$NAME" "$@"; }
# Run a podman command inside the project dir, exactly as the deploy skill does.
proj_podman() { docker exec -w "/workspace/${PROJECT}" "$NAME" podman "$@"; }

api() { # api <method> <path> [data]  — authenticated, returns body on stdout
	local method="$1" path="$2" data="${3:-}"
	if [ -n "$data" ]; then
		curl -fsS -X "$method" "http://127.0.0.1:4001${path}" \
			-H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' -d "$data"
	else
		curl -fsS -X "$method" "http://127.0.0.1:4001${path}" \
			-H "Authorization: Bearer ${TOKEN}"
	fi
}

wait_health() { # poll GET / until agent-server answers (or time out)
	for _ in $(seq 1 30); do
		curl -fsS "http://127.0.0.1:4001/" > /dev/null 2>&1 && return 0
		sleep 1
	done
	return 1
}

curl_app() { # curl_app <port> — full host→inner chain, with retry for startup
	curl -fsS --retry 15 --retry-delay 1 --retry-connrefused --retry-all-errors \
		"http://127.0.0.1:${1}/" > /dev/null
}

# Fetch the hashed JS bundle the SPA's index.html references on <port> and grep
# it for <marker>. This is how we prove a redeploy did/didn't change an instance.
bundle_contains() { # bundle_contains <port> <marker>
	local port="$1" marker="$2" asset
	asset=$(curl -fsS "http://127.0.0.1:${port}/" | grep -oE '/assets/[^"]+\.js' | head -1)
	[ -n "$asset" ] || return 2
	curl -fsS "http://127.0.0.1:${port}${asset}" | grep -q "$marker"
}

# Inverse of bundle_contains: succeeds iff the marker is ABSENT (used to prove
# a redeploy left the other instance untouched). A fetch failure is a hard error
# (return 2), not a silent "absent".
bundle_lacks() { # bundle_lacks <port> <marker>
	local port="$1" marker="$2" asset
	asset=$(curl -fsS "http://127.0.0.1:${port}/" | grep -oE '/assets/[^"]+\.js' | head -1)
	[ -n "$asset" ] || return 2
	! curl -fsS "http://127.0.0.1:${port}${asset}" | grep -q "$marker"
}

# ── 0. clean slate ───────────────────────────────────────────────────────────

echo "[0] clean slate (deterministic: drop outer + both named volumes)"
docker rm -f "$NAME" > /dev/null 2>&1 || true
docker volume rm builder-workspace builder-podman-storage > /dev/null 2>&1 || true

# ── 1. build + start (agent-server inside) ───────────────────────────────────

echo "[1] build image + start outer container (runs agent-server)"
# run-outer.sh reads AGENT_SERVER_TOKEN from the env and passes it via -e.
check "run-outer.sh builds + starts the outer container" \
	env AGENT_SERVER_TOKEN="$TOKEN" ./run-outer.sh

echo "[2] security boundary unchanged (acceptance: docker inspect)"
check "outer main process uid is 1000 (builder)" \
	bash -c "[ \"\$(docker exec $NAME id -u)\" = '1000' ]"
check "Privileged=false" \
	bash -c "[ \"\$(docker inspect -f '{{.HostConfig.Privileged}}' $NAME)\" = 'false' ]"
check "CapAdd is empty" \
	bash -c "[ \"\$(docker inspect -f '{{.HostConfig.CapAdd}}' $NAME)\" = '[]' ]"
check "no no-new-privileges in SecurityOpt" \
	bash -c "! docker inspect -f '{{.HostConfig.SecurityOpt}}' $NAME | grep -q 'no-new-privileges'"
check "no /dev/fuse device" \
	bash -c "! docker inspect -f '{{.HostConfig.Devices}}' $NAME | grep -q '/dev/fuse'"
check "the two expected publishes are present (4001 + 10000-10199)" \
	bash -c "docker inspect -f '{{json .HostConfig.PortBindings}}' $NAME | grep -q '4001/tcp' \
	         && docker inspect -f '{{json .HostConfig.PortBindings}}' $NAME | grep -q '10000/tcp'"

# ── 3. agent-server reachable + auth enforced ────────────────────────────────

echo "[3] agent-server API healthy + bearer auth enforced"
check "GET / becomes healthy" wait_health
check "GET /v1/projects without token → 401" \
	bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4001/v1/projects)\" = '401' ]"
check "GET /v1/projects with token → 200" api GET /v1/projects

# ── 4. project create: metadata + seeding ────────────────────────────────────

echo "[4] POST /v1/projects (dev+prod metadata) → create + seed"
check "create project with deployment metadata" \
	api POST /v1/projects \
	"{\"name\":\"${PROJECT}\",\"deployment\":{\"dev\":{\"port\":${DEV_PORT},\"url\":\"https://${PROJECT}-dev.example.com\"},\"prod\":{\"port\":${PROD_PORT},\"url\":\"https://${PROJECT}.example.com\"}}}"

check ".pi/deployment.json exists inside the container with the right ports" \
	bash -c "docker exec $NAME cat /workspace/${PROJECT}/.pi/deployment.json \
	         | tr -d ' \n' | grep -q '\"port\":${DEV_PORT}' \
	         && docker exec $NAME cat /workspace/${PROJECT}/.pi/deployment.json \
	         | tr -d ' \n' | grep -q '\"port\":${PROD_PORT}'"

check "seeded template landed (vite-spa Dockerfile + index.html)" \
	bash -c "docker exec $NAME test -f /workspace/${PROJECT}/Dockerfile \
	         && docker exec $NAME test -f /workspace/${PROJECT}/index.html"

# ── 5. deploy: build the seeded template once, run DEV + PROD ─────────────────
# The deploy-app skill's literal commands (APP_CONTAINER_RUNTIME=podman). D6:
# DEV and PROD are the SAME build (two instances) — build :dev once, tag :prod.

echo "[5] build seeded template once + run DEV + PROD instances"
build_start=$(date +%s)
check "podman build ${PROJECT}-app:dev (real multi-stage Vite build, nested)" \
	proj_podman build -t "${PROJECT}-app:dev" .
build_end=$(date +%s)
echo "  [observe] cold multi-stage build under nested rootless podman: $((build_end - build_start))s"

check "tag ${PROJECT}-app:prod = :dev (same build, D6)" \
	outer_exec podman tag "${PROJECT}-app:dev" "${PROJECT}-app:prod"

outer_exec podman rm -f "${PROJECT}-app-dev" "${PROJECT}-app-prod" > /dev/null 2>&1
check "run DEV instance on :${DEV_PORT}" \
	outer_exec podman run -d --name "${PROJECT}-app-dev" -p "${DEV_PORT}:${APP_PORT}" "${PROJECT}-app:dev"
check "run PROD instance on :${PROD_PORT}" \
	outer_exec podman run -d --name "${PROJECT}-app-prod" -p "${PROD_PORT}:${APP_PORT}" "${PROJECT}-app:prod"

echo "[6] full chain: host curl reaches both inner apps"
check "host curl 127.0.0.1:${DEV_PORT} (DEV) returns the app" curl_app "$DEV_PORT"
check "host curl 127.0.0.1:${PROD_PORT} (PROD) returns the app" curl_app "$PROD_PORT"

# ── 7. redeploy isolation: modify DEV, PROD must not change ───────────────────

echo "[7] redeploy modified DEV → DEV changes, PROD unchanged"
outer_exec sh -c "sed -i 's/Your app is running/CSMOKE_MARKER_V2 redeployed/' /workspace/${PROJECT}/src/main.js"
check "rebuild DEV only" proj_podman build -t "${PROJECT}-app:dev" .
outer_exec podman rm -f "${PROJECT}-app-dev" > /dev/null 2>&1
check "redeploy DEV instance" \
	outer_exec podman run -d --name "${PROJECT}-app-dev" -p "${DEV_PORT}:${APP_PORT}" "${PROJECT}-app:dev"
check "host curl DEV reachable after redeploy" curl_app "$DEV_PORT"
check "DEV bundle now contains the marker" bundle_contains "$DEV_PORT" "CSMOKE_MARKER_V2"
check "PROD bundle does NOT contain the marker (untouched)" \
	bundle_lacks "$PROD_PORT" "CSMOKE_MARKER_V2"

# ── 8. restart survival + recovery ───────────────────────────────────────────

echo "[8] outer restart: registry + workspace survive, podman start --all recovers"
docker restart "$NAME" > /dev/null
check "agent-server healthy again after restart" wait_health
check "project registry survived restart" \
	bash -c "docker exec $NAME cat /workspace/${PROJECT}/.pi/deployment.json | grep -q ${DEV_PORT} \
	         && curl -fsS -H 'Authorization: Bearer ${TOKEN}' http://127.0.0.1:4001/v1/projects | grep -q ${PROJECT}"
check "workspace edit survived restart (DEV marker still in source)" \
	bash -c "docker exec $NAME grep -q CSMOKE_MARKER_V2 /workspace/${PROJECT}/src/main.js"
check "podman image store survived restart" \
	bash -c "docker exec $NAME podman images --format '{{.Repository}}' | grep -q ${PROJECT}-app"

inner_state=$(outer_exec podman inspect -f '{{.State.Status}}' "${PROJECT}-app-dev" 2>/dev/null || echo "gone")
echo "  [observe] inner DEV container state after outer restart: ${inner_state}"
# Stage 4 recovery mechanism: entrypoint wiped stale runtime state, now resurrect.
check "podman start --all resurrects the inner apps" outer_exec podman start --all
check "host curl DEV reachable after restart+recovery" curl_app "$DEV_PORT"
check "host curl PROD reachable after restart+recovery" curl_app "$PROD_PORT"

# ── summary ──────────────────────────────────────────────────────────────────

echo
echo "──────────────────────────────────────────"
echo "container-smoke result: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
if [ "$FAIL_COUNT" -eq 0 ]; then
	echo "STAGE 2 CONTAINER SMOKE: PASS"
	exit 0
fi
echo "STAGE 2 CONTAINER SMOKE: FAIL"
exit 1
