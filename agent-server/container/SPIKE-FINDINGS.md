# Stage 0 Spike Findings

**Status:** NOT STARTED — fill in as you iterate, not at the end.
**Brief:** `docs/plans/stage0-spike-brief.md`

## Host

- Provider / instance type:
- Distro + kernel (`lsb_release -ds`, `uname -rm`):
- Arch:
- Docker version (`docker --version`):
- Podman version inside outer (`podman --version`):

## Result summary

<!-- One paragraph: does the unprivileged nested chain work on this host? -->

## Final `docker run` flag set

<!-- Copy the final run-outer.sh invocation. Then justify every flag: -->

| Flag | Needed? | Exact error when removed |
| --- | --- | --- |
| `--device /dev/fuse` | | |
| `--security-opt seccomp=...` | | |
| `--security-opt apparmor=...` | | |

## Host prerequisites

<!-- sysctls, apparmor profiles, packages — anything appx's deploy/system-setup.sh
     must replicate. "None beyond docker install" is a valid (great) answer. -->

## Storage driver (T4)

- fuse-overlayfs: works? notes:
- native rootless overlayfs (no mount_program): works? notes:
- Pinned choice + why:

## Warmup timing (T3)

- Cold first `podman info` (fresh storage volume):
- Warmed (entrypoint already ran):

## Restart behaviour (T3)

- Workspace volume:
- Podman image store:
- Running inner containers after `docker restart`:
- `podman start --all` viable as the Stage 4 recovery mechanism?

## Port chain notes

<!-- Anything surprising about host → publish → outer → slirp4netns → inner.
     E.g. latency, slirp4netns vs pasta, IPv6, DNS inside inner containers. -->

## Recommendations for Stage 2

<!-- Deltas to apply to container/Dockerfile and run-outer.sh for the real
     image (agent-server installed, CMD replaced, AGENT_SERVER_* env, port 4001
     publish). Anything that surprised you and will bite Stage 2/3. -->

## Open questions / blockers

