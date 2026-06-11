#!/usr/bin/env bash
# Regenerate container/seccomp-builder.json from podman's stock seccomp profile.
#
# Why this profile exists (Stage 0 spike, task T2): docker's DEFAULT seccomp
# profile blocks mount(2), which rootless podman needs even for unprivileged
# overlay/bind mounts, so the naive fix is seccomp=unconfined. Podman ships a
# profile that allows mount, but it gates a handful of syscalls behind
# "CAP_SYS_ADMIN" via the runtime's `includes.caps` mechanism. Our OUTER
# container is unprivileged (no CAP_SYS_ADMIN), so those rules are dropped and
# the gated syscalls fall through to ERRNO. Inner-container setup then dies at
# `sethostname: Operation not permitted`.
#
# This profile = podman's stock profile with the CAP_SYS_ADMIN gate removed
# from ONLY the namespace-setup syscalls the nested runtime needs
# (sethostname, setdomainname, setns). The genuinely dangerous gated syscalls
# (bpf, perf_event_open, quotactl, fanotify_init, lookup_dcookie) stay denied.
# Net result: a tailored profile that is strictly tighter than `unconfined`.
set -euo pipefail
cd "$(dirname "$0")"
docker build -t builder-outer . >/dev/null
cid=$(docker create builder-outer)
docker cp "$cid:/usr/share/containers/seccomp.json" /tmp/stock-seccomp.json
docker rm "$cid" >/dev/null
python3 - <<'PY'
import json
d=json.load(open('/tmp/stock-seccomp.json'))
NEED={'sethostname','setdomainname','setns'}
for s in d['syscalls']:
    inc=s.get('includes',{})
    if s['action']=='SCMP_ACT_ALLOW' and inc.get('caps')==['CAP_SYS_ADMIN']:
        s['names']=[n for n in s['names'] if n in NEED]
        s.pop('includes',None)
json.dump(d,open('seccomp-builder.json','w'),indent=1)
print("wrote seccomp-builder.json")
PY
