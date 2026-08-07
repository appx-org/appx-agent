# syntax=docker/dockerfile:1
# Stage 2 — the OUTER "builder" container image.
#
# Promotes the Stage 0 spike image (which only proved nested rootless podman by
# keeping itself alive for `docker exec`) to actually RUN agent-server, with the
# deploy-app skill + app template baked in.
#
# Built from the MONOREPO ROOT (not container/) so the Node build stage sees
# the root lockfile plus the agent-protocol workspace agent-server depends on.
# `run-outer.sh` invokes: docker build -f packages/agent-server/container/Dockerfile .
#
# HARD SECURITY INVARIANTS (transcribed verbatim from the deletion-tested Stage 0
# recipe — see container/SPIKE-FINDINGS.md). Do NOT weaken any of these:
#   - no --privileged, no --cap-add SYS_ADMIN, no /dev/fuse, no seccomp=unconfined
#   - the outer process runs as uid 1000 (builder)
#   - newuidmap/newgidmap ship with FILE CAPABILITIES (not setuid-root)
#   - NEVER add --security-opt no-new-privileges (incompatible with the file-cap
#     helpers; see the WARNING below)
#   - native rootless overlay, cgroupfs, file events logger, subuid/subgid ranges
# See docs/plans/builder-containers-plan.md (Stage 2, D3/D5/D6).

# ── Stage A: compile agent-server + prune to a production runtime ─────────────
# Official node:22 (current LTS, matches .github/workflows/contract.yml's
# node-version: 22 and the box's node). The build stage owns npm + the dev
# toolchain; only the pruned dist/ + production node_modules are copied forward,
# so none of that tooling reaches the final unprivileged image.
FROM node:22-bookworm-slim AS server-build
WORKDIR /build
# Install deps first (cache anchor) — only re-runs when a manifest changes.
# Workspace install: the root lockfile drives versions. Every workspace
# manifest must be present for `npm ci` to validate against the lockfile
# (agent-client's is copied for that validation only; -w limits the actual
# install to agent-server's tree, which includes the agent-protocol link).
COPY package.json package-lock.json ./
COPY packages/agent-protocol/package.json packages/agent-protocol/
COPY packages/agent-server/package.json packages/agent-server/
COPY packages/agent-client/package.json packages/agent-client/
RUN npm ci -w packages/agent-server
# The protocol package: agent-server resolves eventSchema.generated.json from
# it at runtime (via the node_modules workspace symlink). No build needed —
# the server only consumes the committed JSON artifacts.
COPY packages/agent-protocol packages/agent-protocol
# Compile TypeScript → dist/ (tsconfig extends the root tsconfig.base.json).
COPY tsconfig.base.json ./
COPY packages/agent-server/tsconfig.json packages/agent-server/
COPY packages/agent-server/src packages/agent-server/src
RUN npm run build -w packages/agent-server
# Prune to production dependencies in place; node_modules is now runtime-only.
RUN npm prune --omit=dev -w packages/agent-server

# ── Stage B: the rootless-podman outer image (Stage 0 recipe, UNCHANGED) ──────
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# podman + rootless plumbing:
#   uidmap         → newuidmap/newgidmap setuid helpers (subordinate id mapping)
#   slirp4netns    → rootless network namespace + port forwarding
#   fuse-overlayfs → overlay storage in nested user namespaces (T4 tests native)
RUN apt-get update && apt-get install -y --no-install-recommends \
      podman uidmap slirp4netns fuse-overlayfs \
      ca-certificates curl git iproute2 libcap2-bin \
    && rm -rf /var/lib/apt/lists/*

# Node 22 runtime for agent-server in the final stage. Installed from NodeSource
# (the canonical way to get a specific Node LTS on Ubuntu, with correct apt
# dependency resolution) so it matches the build stage's major version. We keep
# the proven ubuntu:24.04 podman base rather than switching to a node:* base —
# the nesting recipe (file-cap helpers, native overlay) was validated on this
# base and must not change.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && node --version

# CRITICAL FIX (see SPIKE-FINDINGS.md "newuidmap"): Ubuntu ships newuidmap /
# newgidmap as setuid-root. Inside an unprivileged docker container that makes
# euid=0 when they run, which fails the kernel's uid_map ownership shortcut and
# forces a CAP_SYS_ADMIN-in-init-userns check that docker's bounding set denies
# -> 'newuidmap: write to uid_map failed: Operation not permitted'.
# Fedora/quay.io/podman-stable instead ship them with file capabilities, so
# euid stays 1000 (== owner of the nested userns) and the ownership shortcut
# applies. Replicate that here:
# WARNING: this file-capabilities approach is INCOMPATIBLE with running the
# outer container under `--security-opt no-new-privileges`. Under no_new_privs,
# execve() cannot add file capabilities to the permitted set, so newuidmap would
# silently lose CAP_SETUID and rootless podman fails at namespace setup with the
# same 'Operation not permitted' shown above. Do NOT add no-new-privileges as a
# "hardening" flag without first switching these helpers back to another mapping
# mechanism. (https://www.kernel.org/doc/html/latest/userspace-api/no_new_privs.html)
RUN chmod u-s /usr/bin/newuidmap /usr/bin/newgidmap \
 && setcap cap_setuid+ep /usr/bin/newuidmap \
 && setcap cap_setgid+ep /usr/bin/newgidmap

# ubuntu:24.04 ships a default 'ubuntu' user at uid 1000; replace it with
# 'builder' so the unprivileged uid is ours and predictable.
RUN userdel -r ubuntu 2>/dev/null || true \
 && useradd -m -s /bin/bash -u 1000 builder

# Subordinate uid/gid ranges — rootless podman maps inner-container users into
# these. Without them every nested `podman run` fails at user-namespace setup.
RUN echo 'builder:100000:65536' > /etc/subuid \
 && echo 'builder:100000:65536' > /etc/subgid

# Podman config for a systemd-less nested environment:
#   cgroup_manager=cgroupfs  → no systemd inside this container
#   events_logger=file       → no journald inside this container
#   storage: NATIVE rootless overlay (T4 winner: ~2.2x faster than
#   fuse-overlayfs on this kernel 7.0 host, and needs no /dev/fuse device).
#   fuse-overlayfs is left installed as a documented fallback only.
RUN mkdir -p /home/builder/.config/containers \
 && printf '[containers]\ndefault_sysctls = []\n\n[engine]\ncgroup_manager = "cgroupfs"\nevents_logger = "file"\n' \
      > /home/builder/.config/containers/containers.conf \
 && printf '[storage]\ndriver = "overlay"\n' \
      > /home/builder/.config/containers/storage.conf \
 && chown -R builder:builder /home/builder/.config

# Pre-create the volume mountpoints OWNED BY builder. Docker initialises named
# volumes by copying ownership from the image path; without this both volumes
# mount root-owned and rootless podman dies with:
#   mkdir /home/builder/.local/share/containers/storage: permission denied
RUN mkdir -p /workspace /home/builder/.local/share/containers \
 && chown -R builder:builder /workspace /home/builder/.local

# ── agent-server runtime + baked builder assets (Stage 2 additions) ───────────
# Pruned runtime from the build stage, preserving the workspace layout so the
# hoisted node_modules' relative symlink to packages/agent-protocol still
# resolves. Root-owned is fine — the unprivileged builder process only READS
# these.
COPY --from=server-build /build/node_modules /opt/agent-server/node_modules
COPY --from=server-build /build/package.json /opt/agent-server/package.json
COPY --from=server-build /build/packages/agent-protocol /opt/agent-server/packages/agent-protocol
COPY --from=server-build /build/packages/agent-server/dist /opt/agent-server/packages/agent-server/dist
COPY --from=server-build /build/packages/agent-server/package.json /opt/agent-server/packages/agent-server/package.json

# Bake the deploy skill + app template at fixed paths and point env at them
# (D4 / D5). builder reads these read-only.
COPY packages/agent-server/builder-agent/skills/deploy-app /opt/builder-agent/skills/deploy-app
COPY packages/agent-server/builder-agent/templates/vite-spa /opt/builder-agent/templates/vite-spa

COPY packages/agent-server/container/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# Ship the tailored seccomp profile INSIDE the image so consumers can extract it
# instead of vendoring a copy that silently drifts.
#
# The profile is a `docker run --security-opt seccomp=<host path>` argument, so
# it must exist as a file on the HOST that starts this container — it is never
# read from in here. Baking it anyway makes the image the single distribution
# channel for the whole security boundary: a consumer (e.g. the appx control
# plane) does `docker create` + `docker cp /opt/appx/seccomp-builder.json`, and
# the profile it applies is by construction the one this image was built with.
# See gen-seccomp.sh for how the profile is derived from podman's stock one.
COPY packages/agent-server/container/seccomp-builder.json /opt/appx/seccomp-builder.json

# agent-server env contract (see src/config.ts). Secrets (ANTHROPIC_API_KEY,
# AGENT_SERVER_TOKEN) are NEVER baked — they arrive via `docker run -e`.
#   AGENT_SERVER_HOST=0.0.0.0  the container boundary takes over loopback's
#   role; the host PUBLISH stays loopback-only (run-outer.sh -p 127.0.0.1:...).
ENV WORKSPACE_DIR=/workspace \
    AGENT_SERVER_HOST=0.0.0.0 \
    AGENT_SERVER_PORT=4001 \
    APP_CONTAINER_RUNTIME=podman \
    APPX_TEMPLATE_DIR=/opt/builder-agent/templates/vite-spa \
    PI_SKILL_PATHS=/opt/builder-agent/skills/deploy-app

USER builder
WORKDIR /workspace

# No systemd-logind to provision /run/user/1000; entrypoint creates this.
ENV XDG_RUNTIME_DIR=/tmp/runtime-builder

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
# Stage 2: agent-server is the container's main process. The entrypoint warms
# up rootless podman then `exec`s this (so signals reach Node directly). Node
# resolves /opt/agent-server/node_modules by walking up from the script dir.
CMD ["node", "/opt/agent-server/packages/agent-server/dist/server.js"]
