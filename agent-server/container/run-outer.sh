#!/usr/bin/env bash
# Build and (re)start the outer builder container — Stage 0 spike.
#
# The flag set below is the CANDIDATE set. Stage 0's job (task T2 in
# docs/plans/stage0-spike-brief.md) is to shrink it to the minimal proven set;
# every surviving flag must have a one-line justification in SPIKE-FINDINGS.md.
#
# Hard constraints: no --privileged, no --cap-add SYS_ADMIN, non-root user.
set -euo pipefail
cd "$(dirname "$0")"

readonly IMAGE="builder-outer"
readonly NAME="builder-outer"

docker build -t "$IMAGE" .
docker rm -f "$NAME" 2>/dev/null || true

docker run -d --name "$NAME" \
	--device /dev/fuse \
	--security-opt seccomp=unconfined \
	--security-opt apparmor=unconfined \
	-v builder-workspace:/workspace \
	-v builder-podman-storage:/home/builder/.local/share/containers \
	-p 127.0.0.1:10000-10009:10000-10009 \
	"$IMAGE"

# Candidate-flag rationale (verify, then move to SPIKE-FINDINGS.md):
#   --device /dev/fuse           fuse-overlayfs storage driver needs the device
#   seccomp=unconfined           docker's default profile blocks mount(2);
#                                T2: try podman's seccomp.json instead
#   apparmor=unconfined          Ubuntu 24.04 apparmor_restrict_unprivileged_userns
#                                blocks nested userns_create; T2: test alternatives
#   builder-workspace volume     project files must survive container recreate
#   builder-podman-storage vol   inner images/containers must survive recreate
#   -p 127.0.0.1:10000-10009     app port range, loopback-only (appx proxies in)

sleep 2
docker logs "$NAME"
echo
echo "outer container '$NAME' is up. Try: docker exec -it $NAME podman info"
