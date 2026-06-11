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
      ca-certificates curl git iproute2 libcap2-bin \
    && rm -rf /var/lib/apt/lists/*

# CRITICAL FIX (see SPIKE-FINDINGS.md "newuidmap"): Ubuntu ships newuidmap /
# newgidmap as setuid-root. Inside an unprivileged docker container that makes
# euid=0 when they run, which fails the kernel's uid_map ownership shortcut and
# forces a CAP_SYS_ADMIN-in-init-userns check that docker's bounding set denies
# -> 'newuidmap: write to uid_map failed: Operation not permitted'.
# Fedora/quay.io/podman-stable instead ship them with file capabilities, so
# euid stays 1000 (== owner of the nested userns) and the ownership shortcut
# applies. Replicate that here:
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
#   storage: overlay via fuse-overlayfs (T4: test native overlay, pin winner)
RUN mkdir -p /home/builder/.config/containers \
 && printf '[engine]\ncgroup_manager = "cgroupfs"\nevents_logger = "file"\n' \
      > /home/builder/.config/containers/containers.conf \
 && printf '[storage]\ndriver = "overlay"\n\n[storage.options.overlay]\nmount_program = "/usr/bin/fuse-overlayfs"\n' \
      > /home/builder/.config/containers/storage.conf \
 && chown -R builder:builder /home/builder/.config

# Pre-create the volume mountpoints OWNED BY builder. Docker initialises named
# volumes by copying ownership from the image path; without this both volumes
# mount root-owned and rootless podman dies with:
#   mkdir /home/builder/.local/share/containers/storage: permission denied
RUN mkdir -p /workspace /home/builder/.local/share/containers \
 && chown -R builder:builder /workspace /home/builder/.local

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
