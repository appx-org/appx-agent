#!/usr/bin/env bash
# Build and (re)start the outer builder container — Stage 0 spike.
#
# The flag set below is the FINAL PROVEN minimal set (task T2 complete): each
# flag was deletion-tested and carries a one-line justification below and in
# SPIKE-FINDINGS.md. `./smoke.sh` exits 0 with exactly these flags.
#
# Hard constraints honoured: no --privileged, no --cap-add SYS_ADMIN, non-root
# user (outer main process is uid 1000 'builder').
set -euo pipefail
cd "$(dirname "$0")"

readonly IMAGE="builder-outer"
readonly NAME="builder-outer"
readonly SECCOMP="$(pwd)/seccomp-builder.json"

docker build -t "$IMAGE" .
docker rm -f "$NAME" 2>/dev/null || true

docker run -d --name "$NAME" \
	--device /dev/net/tun \
	--security-opt seccomp="$SECCOMP" \
	--security-opt apparmor=unconfined \
	--security-opt systempaths=unconfined \
	-v builder-workspace:/workspace \
	-v builder-podman-storage:/home/builder/.local/share/containers \
	-p 127.0.0.1:10000-10009:10000-10009 \
	"$IMAGE"

# Final proven flag set (deletion-tested in T2; see SPIKE-FINDINGS.md):
#   --device /dev/net/tun        rootless slirp4netns networking opens /dev/net/tun;
#                                without it: 'open("/dev/net/tun"): No such file'
#   seccomp=seccomp-builder.json tailored profile (podman's stock + ungated
#                                sethostname/setdomainname/setns). Docker's
#                                DEFAULT seccomp blocks mount(2) -> 'cannot
#                                re-exec process'. Strictly tighter than
#                                unconfined; see gen-seccomp.sh for provenance
#   apparmor=unconfined          docker-default apparmor blocks the overlay
#                                mount(2): 'mount ...overlay...: permission
#                                denied'. (Host apparmor_restrict_unprivileged_
#                                userns is handled by the file-cap newuidmap fix,
#                                NOT by this flag.) TODO: tailored apparmor profile
#   systempaths=unconfined       docker masks /proc submounts; kernel
#                                mount_too_revealing() then blocks the inner
#                                container's fresh proc mount: 'mount proc to
#                                proc: Operation not permitted'. No caps/privilege
#   builder-workspace volume     project files must survive container recreate
#   builder-podman-storage vol   inner images/containers must survive recreate
#   -p 127.0.0.1:10000-10009     app port range, loopback-only (appx proxies in)

sleep 2
docker logs "$NAME"
echo
echo "outer container '$NAME' is up. Try: docker exec -it $NAME podman info"
