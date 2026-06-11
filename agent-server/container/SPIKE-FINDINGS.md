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

## Headline finding: setuid-root `newuidmap` breaks rootless podman in an unprivileged container

The single biggest blocker. Symptom on first run:

```
running `/usr/bin/newuidmap <pid> 0 1000 1 1 100000 65536`: newuidmap: write to uid_map failed: Operation not permitted
Error: cannot set up namespace using "/usr/bin/newuidmap": exit status 1
```

**Root cause (traced with bpftrace, not guessed):** Ubuntu ships `newuidmap`/`newgidmap`
as **setuid-root** (`-rwsr-xr-x`). Inside an unprivileged docker container they therefore
run with `euid=0`. The kernel's `/proc/<pid>/uid_map` write path (`new_idmap_permitted`)
has a shortcut: if the writer's euid equals the uid that *created* the target user
namespace (here uid 1000 = `builder`), a single-extent self-map is allowed without any
capability. With `euid=0` that shortcut does **not** apply, so the kernel instead requires
`CAP_SYS_ADMIN` **in the initial user namespace**. docker's default capability bounding set
(`0x00000000a80425fb`) excludes `CAP_SYS_ADMIN`, so the check fails. bpftrace on
`cap_capable` confirmed the final failing check is `cap=21` (CAP_SYS_ADMIN), returning -1.

This is **not** AppArmor and **not** seccomp — it fails identically with every AppArmor /
seccomp sysctl set to 0. It is purely the setuid-vs-filecap packaging difference.

**Fix (matches Fedora / `quay.io/podman/stable` / Dan Walsh's "Podman inside a container"
blog):** ship the helpers with **file capabilities** instead of setuid-root, so euid stays
1000 and the ownership shortcut applies:

```dockerfile
RUN chmod u-s /usr/bin/newuidmap /usr/bin/newgidmap \
 && setcap cap_setuid+ep /usr/bin/newuidmap \
 && setcap cap_setgid+ep /usr/bin/newgidmap
```

Verified: after this change `newuidmap <pid> 0 1000 1 1 100000 65536` returns OK with **no**
added capabilities and `apparmor_restrict_unprivileged_userns=1` left at its hardened default.
This is why `quay.io/podman/stable` "just works" as a nested image — it already does this.

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

