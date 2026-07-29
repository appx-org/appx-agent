#!/usr/bin/env bash
# Build and (re)start the outer builder container — Stage 2.
#
# Promotes the Stage 0 spike to RUN agent-server. The security flag set below is
# the FINAL PROVEN minimal set (Stage 0 task T2): each flag was deletion-tested
# and carries a one-line justification below and in SPIKE-FINDINGS.md. Stage 2
# adds ONLY the two publishes (4001 API + 10000-10199 app range) and the two
# secret -e pass-throughs; the security flags are byte-for-byte unchanged.
#
# Hard constraints honoured: no --privileged, no --cap-add SYS_ADMIN, no
# /dev/fuse, no seccomp=unconfined, no no-new-privileges; non-root user (outer
# main process is uid 1000 'builder').
set -euo pipefail
cd "$(dirname "$0")"

readonly IMAGE="builder-outer"
readonly NAME="builder-outer"
readonly SECCOMP="$(pwd)/seccomp-builder.json"

# Build from the REPO ROOT (..) so the Node build stage can compile agent-server;
# the Dockerfile lives in container/. .dockerignore keeps the context lean.
docker build -f Dockerfile -t "$IMAGE" ..
docker rm -f "$NAME" 2>/dev/null || true

# Secrets are passed by NAME (-e VAR with no =value): docker forwards the host's
# value if set, and simply omits the var otherwise. Never bake keys into the
# image. ANTHROPIC_API_KEY + AGENT_SERVER_TOKEN are both optional for the
# deterministic smoke (the agent never runs an LLM there); set them for the
# Stage 1 e2e.
docker run -d --name "$NAME" \
	--device /dev/net/tun \
	--security-opt seccomp="$SECCOMP" \
	--security-opt apparmor=unconfined \
	--security-opt systempaths=unconfined \
	-e ANTHROPIC_API_KEY \
	-e AGENT_SERVER_TOKEN \
	-v builder-workspace:/workspace \
	-v builder-podman-storage:/home/builder/.local/share/containers \
	-p 127.0.0.1:4001:4001 \
	-p 127.0.0.1:10000-10199:10000-10199 \
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
#   -p 127.0.0.1:4001            agent-server API, loopback-only (appx proxies in)
#   -p 127.0.0.1:10000-10199     app port range (200 = 100 projects x DEV+PROD
#                                pair; matches appx PublishedPortRangeEnd=10199),
#                                loopback-only (appx proxies in)

sleep 2
docker logs "$NAME"
echo
echo "outer container '$NAME' is up. agent-server API: http://127.0.0.1:4001/"
echo "Try: docker exec -it $NAME podman info"
