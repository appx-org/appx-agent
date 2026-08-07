---
"@appx-org/agent-server": patch
---

Make the deploy-app skill state the app port publish rule in one unambiguous,
positive form.

The skill held two contradictory instructions. Its runnable example published
correctly (`-p <devPort>:<containerPort>`), but a contract bullet said:

> **Loopback only.** Do not publish on `0.0.0.0`; appx is the only edge.

An agent that followed the bullet ran `-p 127.0.0.1:<hostPort>:<containerPort>`,
binding the **builder container's own** loopback. Requests from outside arrive on
that container's bridge address, so nothing answered them: every real user got a
connection reset while the app stayed perfectly healthy from inside. Which
instruction won depended on how the model weighted them, so the failure appeared
intermittently rather than reproducibly.

The bullet was also wrong on its own terms. Inside the builder container `0.0.0.0`
means "all interfaces of this container", not "exposed to the internet"; the
loopback restriction belongs to the control plane's publish of the outer
container's ports, which the inner binding cannot weaken.

- The contract now says what to do — publish as exactly two numbers, reachable on
  every interface of this container — with the one clause of reasoning that stops
  an agent "hardening" it back. The `--network=host` prohibition is replaced by the
  positive rule it implied: give each app container its own network, or the default.
- **The health check asserts the binding.** `curl 127.0.0.1:<port>` from inside the
  builder container reaches the app over the same loopback a wrongly-bound publish
  uses, so it returned `200` for an app nobody outside could load — the check could
  not detect this failure, which is why agents reported success. It now also expects
  `port <container>` to report `0.0.0.0:<port>`.
- The multi-container section restates the same two-number form.

Three drift-guard tests added: every `-p` in the file is a bare `host:container`
pair, the rule and its reason are present, and the health check inspects the
binding.
