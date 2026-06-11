# Stage 0 Spike Findings

**Status:** IN PROGRESS
**Brief:** `docs/plans/stage0-spike-brief.md`

## Host

- Provider / instance type: Hetzner KVM VM ("appx"), 4 vCPU, 7.6 GiB RAM, 75 GiB disk, 4 GiB swap
- Distro + kernel (`lsb_release -ds`, `uname -rm`): **Ubuntu 26.04 LTS** (brief assumed 24.04 — see note), kernel `7.0.0-15-generic x86_64`
- Arch: x86_64
- Docker version (`docker --version`): Docker version 29.5.3, build d1c06ef (security options: apparmor, seccomp profile=builtin, cgroupns)
- Podman version inside outer (`podman --version`): TBD

**Note on distro:** the box is Ubuntu 26.04, not the 24.04 the brief targets. The
relevant hardening is the same or stricter: `kernel.apparmor_restrict_unprivileged_userns = 1`
(the 24.04 default that blocks nested userns) is active here too, and AppArmor is enabled
(`/sys/module/apparmor/parameters/enabled = Y`). Findings should transfer to 24.04, but the
operator should re-verify on a real 24.04 host before production.

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

