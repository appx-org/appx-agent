# syntax=docker/dockerfile:1
# Stage 0 spike draft — the OUTER "builder" container image.
#
# Validates: unprivileged docker container running rootless podman inside.
# agent-server is deliberately NOT installed here (Stage 2 adds it); this image
# exists purely to prove the nesting works on the target host.
#
# See docs/plans/stage0-spike-brief.md for the validation tasks and
# container/SPIKE-FINDINGS.md for the (to-be-recorded) results.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# podman + rootless plumbing:
#   uidmap         → newuidmap/newgidmap setuid helpers (subordinate id mapping)
#   slirp4netns    → rootless network namespace + port forwarding
#   fuse-overlayfs → overlay storage in nested user namespaces (T4 tests native)
RUN apt-get update && apt-get install -y --no-install-recommends \
      podman uidmap slirp4netns fuse-overlayfs \
      ca-certificates curl git iproute2 \
    && rm -rf /var/lib/apt/lists/*

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
#   storage: overlay via fuse-overlayfs (T4: test native overlay, pin winner)
RUN mkdir -p /home/builder/.config/containers \
 && printf '[engine]\ncgroup_manager = "cgroupfs"\nevents_logger = "file"\n' \
      > /home/builder/.config/containers/containers.conf \
 && printf '[storage]\ndriver = "overlay"\n\n[storage.options.overlay]\nmount_program = "/usr/bin/fuse-overlayfs"\n' \
      > /home/builder/.config/containers/storage.conf \
 && chown -R builder:builder /home/builder/.config

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

USER builder
WORKDIR /workspace

# No systemd-logind to provision /run/user/1000; entrypoint creates this.
ENV XDG_RUNTIME_DIR=/tmp/runtime-builder

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
# Spike keeps the container alive for `docker exec` iteration; Stage 2 replaces
# this with the agent-server process.
CMD ["sleep", "infinity"]
