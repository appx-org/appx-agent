# Stage 0 Spike Findings

**Status:** COMPLETE — `./container/smoke.sh` exits 0 (11/11) under all hard constraints.
**Brief:** `docs/plans/stage0-spike-brief.md`

## Host

- Provider / instance type: Hetzner KVM VM ("appx"), 4 vCPU, 7.6 GiB RAM, 75 GiB disk, 4 GiB swap
- Distro + kernel (`lsb_release -ds`, `uname -rm`): **Ubuntu 26.04 LTS** (brief assumed 24.04 — see note), kernel `7.0.0-15-generic x86_64`
- Arch: x86_64
- Docker version (`docker --version`): Docker version 29.5.3, build d1c06ef (security options: apparmor, seccomp profile=builtin, cgroupns)
- Outer image base: `ubuntu:24.04` (matches the brief's production target even though the host is 26.04)
- Podman version inside outer (`podman --version`): **4.9.3** (Ubuntu 24.04 repo)

**Note on distro:** the box is Ubuntu 26.04, not the 24.04 the brief targets. The
relevant hardening is the same or stricter: `kernel.apparmor_restrict_unprivileged_userns = 1`
(the 24.04 default that blocks nested userns) is active here too, and AppArmor is enabled
(`/sys/module/apparmor/parameters/enabled = Y`). The OUTER IMAGE is `ubuntu:24.04`, so the
in-image findings (podman 4.9.3, packaging, configs) are exactly the production target. The
operator should still re-verify the host-side flags on a real 24.04 host before production.

## Result summary

**Yes — the unprivileged nested chain works on this host**, and `./container/smoke.sh` exits 0
(11/11) with no `--privileged`, no added capabilities (no `SYS_ADMIN`), and the outer main
process running as non-root uid 1000 (`builder`). The full path is proven: host → docker
publish (`127.0.0.1:10000`) → outer container → rootless podman + slirp4netns → inner nginx,
plus a working `podman build`, persistence across `docker restart`, and clean recovery via
`podman start --all`. The single decisive fix was repackaging `newuidmap`/`newgidmap` with
file capabilities (see headline finding); after that only four `docker run` knobs are needed,
and `seccomp=unconfined` was further replaced by a strictly-tighter tailored profile.
Remarkably, **no host-level sysctl/apparmor change was required** — the hardened Ubuntu
defaults (`apparmor_restrict_unprivileged_userns=1`) are left untouched.

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

From `container/run-outer.sh` (deletion-tested in T2 — each flag removed individually and the
exact resulting error recorded):

```
docker run -d --name builder-outer \
  --device /dev/net/tun \
  --security-opt seccomp=$(pwd)/seccomp-builder.json \
  --security-opt apparmor=unconfined \
  --security-opt systempaths=unconfined \
  -v builder-workspace:/workspace \
  -v builder-podman-storage:/home/builder/.local/share/containers \
  -p 127.0.0.1:10000-10009:10000-10009 \
  builder-outer
```

| Flag | Needed? | Exact error when removed |
| --- | --- | --- |
| `--device /dev/net/tun` | **Yes** | `FAIL@run: /usr/bin/slirp4netns failed: "open(\"/dev/net/tun\"): No such file or directory"` — rootless slirp4netns networking is dead without it |
| `--security-opt seccomp=seccomp-builder.json` | **Yes** | With docker's DEFAULT profile: `FAIL@info: Error: cannot re-exec process` (default profile blocks `mount(2)` and friends). Tailored profile is strictly tighter than `unconfined` — see T2 below |
| `--security-opt apparmor=unconfined` | **Yes** | `FAIL@info: mount /home/builder/.local/share/containers/storage/overlay...: permission denied` — docker-default AppArmor profile (`docker-default`) blocks the rootless overlay `mount(2)`. **NB this is NOT the host `apparmor_restrict_unprivileged_userns` problem** — that one is solved entirely by the file-cap `newuidmap` fix. TODO: replace with a tailored AppArmor profile (deferred; containment loss is bounded — seccomp + userns + caps still apply) |
| `--security-opt systempaths=unconfined` | **Yes** | `FAIL@run: crun: mount \`proc\` to \`proc\`: Operation not permitted` — docker masks `/proc` submounts (`/proc/sys`, `/proc/kcore`, ...); the kernel `mount_too_revealing()` check then refuses the inner container's fresh `proc` mount. `systempaths=unconfined` clears docker's `MaskedPaths`/`ReadonlyPaths`. **Adds no capabilities and no privilege**; the inner containers still get their own `/proc` masks from crun |
| `--device /dev/fuse` | **No (removed)** | Was in the draft for fuse-overlayfs. Native overlay (T4) needs no FUSE device, so this flag was deleted |
| `-v builder-workspace` | **Yes** | persistence: project files must survive container recreate (T3 verified) |
| `-v builder-podman-storage` | **Yes** | persistence: inner images/containers metadata must survive recreate (T3 verified) |
| `-p 127.0.0.1:10000-10009` | **Yes** | the host→inner port chain; loopback-only so appx proxies in. Without it the host curl check cannot reach the inner nginx |

No `--cap-add` of any kind is used. `docker inspect` confirms `Privileged=false`.

## T2 — tailored seccomp profile (replaces `seccomp=unconfined`)

The brief asks to prefer Podman's `seccomp.json` over `unconfined` if it works. Result:

- Podman's **stock** `seccomp.json` (from `containers-common`, present in the image at
  `/usr/share/containers/seccomp.json`) gets further than docker's default (it allows
  `mount`, so `podman info` succeeds) but the inner `podman run` dies at
  `crun: sethostname: Operation not permitted`. Reason: the stock profile *allow-lists*
  `sethostname` (and `setdomainname`, `setns`, plus `bpf`, `perf_event_open`, `quotactl`,
  `fanotify_init`, `lookup_dcookie`) only `includes.caps = [CAP_SYS_ADMIN]`. Our unprivileged
  outer has no `CAP_SYS_ADMIN`, so the runtime drops those allow-rules and the syscalls fall
  through to `ERRNO`.
- **Fix adopted:** `container/seccomp-builder.json` = stock profile with the `CAP_SYS_ADMIN`
  gate removed from **only** `sethostname`, `setdomainname`, `setns` (the namespace-setup
  syscalls the nested runtime needs). The genuinely dangerous gated syscalls
  (`bpf`, `perf_event_open`, `quotactl`, `fanotify_init`, `lookup_dcookie`) stay **denied**.
  This is **strictly tighter than `unconfined`**. `container/gen-seccomp.sh` regenerates it
  from the image's stock profile and documents the provenance. Smoke stays 11/11 with it.

## T2 sub-question — outer runtime: docker vs podman (informs `system-setup.sh`)

Host change: installed `podman` 5.7.0 on the host to test it as the *outer* runtime.

- **Rootless podman as outer: DOES NOT WORK.** Fails at `newuidmap` before anything else:
  rootless podman runs the outer container inside *spike's* user namespace, whose `uid_map`
  is `0 1000 1 / 1 100000 65536` — i.e. only 65536 subuids exist *inside* the outer userns.
  The nested `builder` then asks to map its own `builder:100000:65536` range, which does not
  fit → `newuidmap: write to uid_map failed: Operation not permitted`. This is the classic
  rootless-in-rootless subuid-exhaustion problem; it would need a vastly larger host subuid
  allocation **and** nested-range planning. Not viable as-is. (The seccomp advantage is moot
  because the chain breaks earlier.)
- **Rootful podman as outer (`sudo podman run`): WORKS, with a SMALLER security-flag set.**
  Real-root model (like docker) so `newuidmap` is fine. `podman info` + inner `podman run`
  creation succeed with **only** `--device /dev/net/tun --security-opt apparmor=unconfined`:
  - **No `seccomp=` override needed** — podman's *default* seccomp profile allows `mount(2)`
    (confirms the brief's premise). This is podman-outer's real advantage.
  - **No `systempaths=unconfined` needed** — podman does not mask `/proc` the way docker
    does, so the inner `proc` mount is not blocked.
  - Still needs `apparmor=unconfined` (podman's default container AppArmor profile also
    blocks the overlay `mount`) and `--device /dev/net/tun`.
  - **Caveat (new delta):** podman's default network gave the outer container **no working
    DNS** (even the outer could not resolve `registry-1.docker.io`), so image *pulls* fail
    until DNS is configured (`--dns`, or host `aardvark-dns`/`netavark` setup). Docker's
    default bridge ships an embedded resolver (`127.0.0.11`), so docker-outer has DNS for
    free.
- **Recommendation:** docker-outer is the proven, complete, lowest-friction path and is what
  `run-outer.sh` uses. Rootful-podman-outer is a viable alternative that trades two security
  flags (`seccomp`, `systempaths`) for (a) running the supervisor as root and (b) a DNS-config
  requirement. If `system-setup.sh` later prefers podman-on-host for a smaller flag surface,
  it must run podman **rootful** and configure container DNS. Rootless-podman-outer is a dead
  end without large nested-subuid provisioning.

## Host prerequisites

**None required for the docker-outer path.** This is the headline operational result:

- `kernel.apparmor_restrict_unprivileged_userns` was left at its hardened default **`1`**.
  (It was toggled to 0 *during diagnosis only* and restored; the final green smoke runs with
  it `=1`.) The file-cap `newuidmap` fix is what makes nested userns work, not a host sysctl.
- No host AppArmor profile added.
- No host sysctl changes persisted.
- Only host package needed: **docker** (already required). The image installs its own
  `podman`, `uidmap`, `slirp4netns`, `fuse-overlayfs`, `libcap2-bin`.
- `podman` 5.7.0 was installed on the host **only to answer the T2 outer-runtime
  sub-question**; it is NOT needed for the docker-outer path and can be removed.

So `system-setup.sh` needs nothing beyond a docker install for the docker-outer design.

### Host changes log (everything touched on the box)

| Change | Persisted? | Purpose | Needed for the solution? |
| --- | --- | --- | --- |
| `sysctl kernel.apparmor_restrict_unprivileged_userns` toggled 1↔0 | **No** — restored to `1` | Diagnosis only (proved the blocker was NOT this sysctl) | No |
| `sysctl kernel.apparmor_restrict_unprivileged_unconfined` toggled 1↔0 | **No** — restored to `1` | Diagnosis only | No |
| `sysctl kernel.unprivileged_userns_apparmor_policy` toggled 1↔0 | **No** — restored to `1` | Diagnosis only | No |
| `apt-get install podman` (5.7.0) | Yes (removable) | Answer the T2 outer-runtime sub-question | No (docker-outer path) |
| `apt-get install bpftrace` | Yes (removable) | Trace the `newuidmap` EPERM to `cap_capable cap=21` | No |
| `apt-get install strace gcc libc6-dev` **inside the outer container** | container-only | Diagnosis of the setuid/cap behaviour | No |

Final host sysctl state verified: all three `= 1` (hardened defaults). The green smoke run
uses **zero** persisted host changes beyond the pre-existing docker install.

## Storage driver (T4)

- **fuse-overlayfs:** works. Needs `--device /dev/fuse` and the `fuse-overlayfs` binary +
  `mount_program` in `storage.conf`. Build benchmark (300-file image): **~1281 ms**.
- **native rootless overlayfs (no `mount_program`):** works on this kernel 7.0 host (kernel
  ≥ 5.13 supports rootless native overlay). Needs **no** `/dev/fuse` device. Build benchmark:
  **~582 ms** — **~2.2× faster** than fuse-overlayfs.
- **vfs (last-resort fallback):** not needed and not pinned — native overlay works, so the
  slow full-copy VFS driver was not required.
- **Pinned choice:** **native rootless overlay** (`storage.conf` = `[storage] driver =
  "overlay"` with no `mount_program`). Faster *and* lets us drop `--device /dev/fuse`.
  `fuse-overlayfs` is left installed as a documented fallback only.

## Warmup timing (T3)

- Cold first `podman info` (fresh storage volume): **~0.25 s** (`time` logged by entrypoint).
- Warmed (entrypoint already ran / after restart): **~0.16–0.23 s**.
- Negligible either way with native overlay; no warmup optimisation needed for Stage 2.

## Restart behaviour (T3)

- **Workspace volume:** survives `docker restart` (marker file intact). ✓
- **Podman image store:** survives `docker restart` (built image still present). ✓
- **Running inner containers after `docker restart`:** stop — they come back in state
  `created` (not `running`). Expected: a `docker restart` kills all inner processes.
- **`podman start --all` viable as the Stage 4 recovery mechanism? YES**, but only after the
  entrypoint wipes the **stale transient runtime state** on each boot. `XDG_RUNTIME_DIR`
  (`/tmp/runtime-builder`) lives in the container FS and *survives* `docker restart`, but the
  rootless-podman **pause process** and **crun** state it references do not. Left stale,
  podman fails with `invalid internal status, try resetting the pause process with "podman
  system migrate"` and `podman start` fails with `crun: container already exists`. The
  entrypoint now `rm -rf`s `$XDG_RUNTIME_DIR/{libpod,containers,netns,crun}` on every boot;
  after that `podman start --all` cleanly resurrects the inner container **with its port
  forwarding** (host curl succeeds again). The smoke test exercises exactly this path.

## Port chain notes

- Full chain works: host `127.0.0.1:10000` → docker publish → outer netns → rootless
  **slirp4netns** → inner nginx `:80`. No latency surprises on loopback.
- **slirp4netns requires `/dev/net/tun`** in the outer container (`--device /dev/net/tun`);
  this is the only device the docker-outer path needs.
- IPv6: harmless warnings only (`failed to set net.ipv6.conf.default.accept_dad ...`); IPv4
  forwarding unaffected.
- The read-only `net.ipv4.ping_group_range` sysctl that crun tries to set on container
  create is suppressed by `default_sysctls = []` in `containers.conf` (baked into the image).
- DNS *inside inner containers* under the docker-outer path works (docker bridge resolver).
  Under podman-outer it does not (see T2 sub-question).

## Recommendations for Stage 2

The Stage 2 image and appx's Stage 3 supervisor should transcribe this verbatim:

1. **Keep the four `docker run` knobs** exactly: `--device /dev/net/tun`,
   `--security-opt seccomp=<seccomp-builder.json>`, `--security-opt apparmor=unconfined`,
   `--security-opt systempaths=unconfined`. No `--privileged`, no `--cap-add`.
2. **Keep the `newuidmap`/`newgidmap` file-cap fix** in the Dockerfile — it is the linchpin.
   If Stage 2 switches the base to `quay.io/podman/stable`, that image already does this.
3. **Pin native overlay** storage (no `mount_program`); do not re-add `--device /dev/fuse`.
4. **Keep the entrypoint runtime-state wipe** — it is what makes `docker restart` +
   `podman start --all` a reliable Stage 4 recovery mechanism.
5. Ship `seccomp-builder.json` alongside the deploy scripts and reference it by absolute path;
   `gen-seccomp.sh` regenerates it if the base podman version changes.
6. Replace the spike `CMD ["sleep","infinity"]` with the agent-server process; publish 4001
   and the app port range; add `AGENT_SERVER_*` env. The security flags are unaffected.
7. **Deferred TODO:** replace `apparmor=unconfined` with a tailored AppArmor profile that
   permits the overlay `mount` (mirrors what we did for seccomp). Bounded containment loss
   for now (seccomp + userns + cap-bounding still apply).

## Open questions / blockers

- **None blocking.** The chain works unprivileged with hardened host defaults.
- Re-verify on a genuine **Ubuntu 24.04** host (this box is 26.04, though the image is 24.04)
  before production — expected to pass, but the host kernel/apparmor build differs.
- Tailored AppArmor profile (item 7 above) is the one remaining hardening refinement.
- If appx ever wants podman-on-host, settle the rootful-podman DNS configuration
  (`aardvark-dns`/`netavark` or `--dns`) noted in the T2 sub-question.

