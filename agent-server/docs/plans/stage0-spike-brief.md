# Stage 0 Spike Brief — Nested Rootless Podman ("Outer Builder Container")

**Date:** 2026-06-11
**Parent plan:** `docs/plans/builder-containers-plan.md` (Stage 0)
**Architecture reference:** `docs/architecture/important/builder-container-architecture.md`
**Background reading:** `docs/misc/other/rootless-podman-isolation.md` (the untested draft this spike validates)

This document has two audiences:

- **Section 0** is the runbook for the human operator preparing the box.
- **Sections 1+** are the brief for the coding agent executing the spike.

---

## 0. Operator runbook (human — do this before handing off)

Target: a throwaway Linux cloud VM. **Ubuntu 24.04** (it is the assumed production host OS and ships the strictest user-namespace defaults — if the spike passes here, easier distros are free). Minimum 2 vCPU / 4 GB RAM / 40 GB disk; see the hardware discussion in the parent plan thread.

```bash
# ── as root on the fresh server ──────────────────────────────────────────────
apt-get update && apt-get install -y git curl rsync tmux jq
curl -fsSL https://get.docker.com | sh          # Docker CE from the official repo
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs

# Work user for the coding agent. docker group is root-equivalent, and the
# agent additionally gets passwordless sudo because T2 requires testing
# host-level mitigations (sysctls, AppArmor profiles). Acceptable ONLY because
# this box is throwaway and holds nothing but the spike + a disposable API key.
adduser --disabled-password --gecos "" spike
usermod -aG docker spike
echo 'spike ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/spike && chmod 0440 /etc/sudoers.d/spike

# SSH access for spike: the account has NO password (--disabled-password locks
# it), so reuse the key Hetzner provisioned for root.
mkdir -p /home/spike/.ssh
cp /root/.ssh/authorized_keys /home/spike/.ssh/authorized_keys
chown -R spike:spike /home/spike/.ssh
chmod 700 /home/spike/.ssh && chmod 600 /home/spike/.ssh/authorized_keys

# Swap (mandatory on a 4 GB box; harmless on bigger ones)
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# ── ship the repo: public repo → plain HTTPS clone, no credentials needed ────
# First, from your laptop: commit + push the spike files (container/, docs/plans/)
# so the clone includes them. Then, as spike on the box:
git clone https://github.com/appx-org/agent-server.git ~/agent-server
cd ~/agent-server && git switch -c stage0-spike
git config user.name "stage0 spike agent" && git config user.email spike@localhost
# Deliberately NO push credentials on the box (the agent has sudo); results
# come back via git-over-SSH fetch from the laptop — see acceptance below.

# ── as spike user: install the coding agent + a DISPOSABLE API key ──────────
ssh spike@<SERVER_IP>
npm config set prefix ~/.npm-global && echo 'export PATH=$HOME/.npm-global/bin:$PATH' >> ~/.bashrc
npm install -g @earendil-works/pi-coding-agent     # or however you install pi
echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.bashrc   # fresh key, revoke after spike
source ~/.bashrc

# ── launch (inside tmux so it survives SSH drops) ───────────────────────────
tmux new -s spike
cd ~/agent-server && pi
```

Kickoff prompt to paste into the agent:

> Read `docs/plans/stage0-spike-brief.md` in this repo — section 0 is already
> done; execute sections 1–7. You have passwordless sudo for host-level
> changes; record every host change and every finding in
> `container/SPIKE-FINDINGS.md` as you go. Commit your work to the current
> `stage0-spike` branch in small, described steps (you cannot push — that's
> expected; the operator fetches from this box). The definition of done is
> `./container/smoke.sh` exiting 0 under the brief's hard constraints (no
> `--privileged`, no `SYS_ADMIN`, non-root outer user).

**Acceptance (operator, when the agent reports done):**

```bash
# Re-verify from a clean slate — proves the findings, not the accumulated state:
cd ~/agent-server/container
docker rm -f builder-outer; docker volume rm -f builder-workspace builder-podman-storage
docker system prune -af
./smoke.sh    # must exit 0
```

Then: check `SPIKE-FINDINGS.md` is fully filled (every flag justified, host
prereqs listed), and pull the agent's branch straight off the box — commit
history included, still no credentials on the server:

```bash
# from laptop, inside the agent-server repo
git remote add spikebox spike@<SERVER_IP>:agent-server
git fetch spikebox stage0-spike
git switch stage0-spike   # review, then merge/PR and push from the laptop
```

Finally: revoke the spike API key; destroy the server or keep it for Stage 1/2
iteration (resizing up is easier than re-provisioning if you keep it).

---

## 1. Mission (coding agent starts here)

Prove that an **unprivileged** Docker container can run **rootless Podman** well enough to build and serve real apps, on this exact host. Produce a known-good, *minimal* configuration that later stages will copy verbatim.

Success is binary: `./container/smoke.sh` exits 0 on this box, with a flag set you can justify line by line.

You are NOT building agent-server integration, prompts, or anything product-shaped. Infrastructure validation only.

## 2. What is on disk

| Path | What it is |
|---|---|
| `container/Dockerfile` | Draft outer image (Ubuntu 24.04 + podman stack). Starting point — expect to fix it. |
| `container/entrypoint.sh` | Runtime-dir setup + podman warmup, then execs CMD. |
| `container/run-outer.sh` | Builds the image and (re)starts the outer container with the **candidate** flag set. |
| `container/smoke.sh` | The acceptance test. Your iteration loop is: edit → `./smoke.sh` → read failures → repeat. |
| `container/SPIKE-FINDINGS.md` | Findings template. Fill it in **as you go**, not at the end. |

## 3. Hard constraints

1. **No `--privileged`. Ever.** The outer container being unprivileged *is the security boundary of the whole architecture* — a privileged "pass" is worthless.
2. **No `--cap-add SYS_ADMIN`** unless you have exhausted alternatives; if you genuinely cannot avoid it, that is a major finding — document the exact error and stop to flag it.
3. The outer container's main process must run as a **non-root user** (uid 1000 `builder`). `--user 0` workarounds are failures.
4. Host-level changes (sysctls, apparmor profiles, packages) are **allowed but must be recorded** in findings — they become requirements for appx's deploy scripts (`system-setup.sh`).
5. Work only in `~/agent-server/container/` and on docker state. Don't touch the rest of the repo.

## 4. Tasks and acceptance criteria

### T1 — Make the nested chain work
- [ ] `./container/run-outer.sh` brings up the outer container; `docker exec builder-outer id -u` → `1000`
- [ ] Inside: `podman run -d -p 10000:80 docker.io/library/nginx:alpine` succeeds
- [ ] From the **host**: `curl -fsS http://127.0.0.1:10000` returns the nginx page (host → docker publish → outer netns → podman forward → inner container)
- [ ] Inside: `podman build` of a trivial image succeeds and the built image runs

### T2 — Minimise and justify the flag set
- [ ] Deletion-test every `docker run` security flag and every host-level change: remove one, re-run `smoke.sh`, record the exact error it causes (or remove it permanently if nothing breaks)
- [ ] Try replacing `seccomp=unconfined` with a tailored profile (Podman ships one that allows `mount`; see hints). If it works, prefer it; if not, record why — `unconfined` is acceptable for now with a documented TODO
- [ ] **Outer-runtime sub-question (informs appx Stage 3):** the host runtime can be docker *or* podman. Podman's default seccomp profile allows `mount(2)` where docker's blocks it, so a podman *outer* may not need `seccomp=unconfined` at all. If podman is available on the box, run the same nested test with `podman run` as the outer command and record which flags become unnecessary. This decides whether `system-setup.sh` should prefer podman-on-host for a smaller attack surface
- [ ] Outcome: `run-outer.sh` contains only flags that each carry a one-line justification in findings

### T3 — Persistence and restart semantics
- [ ] `docker restart builder-outer`: workspace volume content and podman images (named volume) survive
- [ ] Record what happens to *running* inner containers across the restart (expected: stopped). Test whether `podman start --all` resurrects them cleanly — this decides Stage 4's recovery mechanism
- [ ] Record first-`podman info` cold warmup time vs warmed (entrypoint logs it)

### T4 — Storage driver determination
- [ ] The draft pins `fuse-overlayfs`. Test native rootless overlayfs (kernel ≥ 5.13 supports it; this host is 6.8+): remove `mount_program` from `storage.conf`, reset podman storage, re-run smoke. Record which works and which is faster; pin the winner
- [ ] Last-resort fallback if both overlay variants fail: `driver = "vfs"` — needs no FUSE device and no overlay nesting at all, at the cost of full-copy layers (slow, disk-hungry). If only VFS works, that's a major finding: record it and flag before Stage 2 builds on it

### T5 — Findings
- [ ] `container/SPIKE-FINDINGS.md` fully filled in (template provided). The Stage 2 image and appx's Stage 3 container-supervisor transcribe your flag set verbatim — incomplete findings = repeated debugging later

## 5. Known pitfalls (read before debugging blind)

These are researched, not guessed — check them in this order when something EPERMs:

1. **Ubuntu 24.04 blocks unprivileged user namespaces via AppArmor.** `kernel.apparmor_restrict_unprivileged_userns=1` is default; nested podman fails with `apparmor="DENIED" operation="userns_create"` (visible in host `dmesg`/`journalctl -k`). Candidate fixes, in preference order — test which is actually sufficient:
   a. `--security-opt apparmor=unconfined` on the outer container (containment loss is acceptable: seccomp/userns remain);
   b. a host AppArmor profile granting `userns` to the container runtime;
   c. host sysctl `kernel.apparmor_restrict_unprivileged_userns=0` (bluntest; if this is the only thing that works, record it as a deploy-script requirement).
2. **Docker's default seccomp profile blocks `mount(2)`**, which rootless podman needs even for unprivileged FUSE/bind mounts. Hence `seccomp=unconfined` in the draft. The tailored alternative: Podman's own `seccomp.json` (in the `containers-common` package, `/usr/share/containers/seccomp.json`) allows `mount` — try `--security-opt seccomp=/path/on/host/seccomp.json`.
3. **`/etc/subuid` / `/etc/subgid`** entries for `builder` must exist *inside the image* (draft has them). Errors like `cannot find UID/GID for user builder` point here; `podman system migrate` after changing them.
4. **No systemd inside the container** → `cgroup_manager = "cgroupfs"` and `events_logger = "file"` (draft sets both in `containers.conf`). Resource limits inside the nest may be unavailable; that's fine, record it.
5. **`XDG_RUNTIME_DIR`** must exist and be writable (no systemd-logind to create `/run/user/1000`). Draft uses `/tmp/runtime-builder` via entrypoint.
6. **Use fully-qualified image names** (`docker.io/library/nginx:alpine`) — Ubuntu's podman has no unqualified-search registries configured and will error or prompt.
7. **`--userns=keep-id` is a podman flag, not docker.** The reference doc's draft run command mixes them up; ignore it. With docker, "unprivileged" = `USER builder` in the image + no added caps.
8. **Sanity-check trick:** `quay.io/podman/stable` is the upstream podman-in-container reference image. If our image fails mysteriously, run the same nested command in `podman/stable` with the same docker flags — if that also fails, the problem is host/flags; if it passes, the problem is our Dockerfile. Note the image only solves the *in-image* half (packages, subuid, conf); the docker-run flags and host prereqs are required with it too.
9. **Sanctioned fallback:** if our Ubuntu-based Dockerfile fights you past ~2 hours of in-image issues, switching the base to `quay.io/podman/stable` (adding the `builder` uid-1000 user on top) is an acceptable T1 outcome — record the trade-off (Fedora base, unpinned podman version) in findings and keep the rest of the constraints unchanged. Host-side flag minimisation (T2) is unaffected by the base choice. There is field evidence this matters: in-image config differences alone have made the difference between needing `--privileged` and not (stackoverflow.com/q/75244579).
10. **Canonical reference:** Dan Walsh's "How to use Podman inside of a container" (redhat.com/en/blog/podman-inside-container) is the authoritative walkthrough of every rootful/rootless nesting combination; our candidate flag set matches its non-privileged rootless-in-docker recipe. Consult it before inventing anything novel.

## 6. Method

- Iterate exclusively through `./container/smoke.sh` — it is the definition of done. Improve it if it misses something real (e.g. you discover DNS inside inner containers is broken — add a check), but never weaken a check to pass.
- One change at a time; record each finding immediately in `SPIKE-FINDINGS.md`.
- Host kernel logs are your AppArmor/seccomp oracle: `sudo journalctl -k --since -5min | grep -i -E 'apparmor|audit'`.
- Disk hygiene on a small box: `docker system prune -f` and `podman system prune -f` (inside) between heavy iterations.

## 7. Timebox & escalation

This spike is timeboxed to ~1 day of focused work. If the chain fundamentally cannot work unprivileged on Ubuntu 24.04 (constraint 1–2 violations are the only outs), stop and write up: the exact failure, kernel/audit evidence, and which of the architecture's escalation paths (Sysbox runtime, different host distro, host-level podman) looks cheapest. Do not silently downgrade the constraints to get a green smoke run.
