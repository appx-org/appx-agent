---
"@appx-org/agent-server": patch
---

Stop the deploy-app skill telling the agent to publish app ports on `127.0.0.1`.

The skill held two contradictory instructions. Its runnable example published
correctly (`-p <devPort>:<containerPort>`, no address), but a contract bullet said:

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

- The contract now requires a bare `-p` and forbids an address prefix.
- **The health check verifies the binding.** `curl 127.0.0.1:<port>` from inside
  the builder container reaches the app over the same loopback a wrongly-bound
  publish uses, so it returned `200` for an app nobody outside could load — the
  check could not detect this failure, which is why agents reported success. It now
  also asserts `port <container>` does not report `127.0.0.1`.
- The multi-container section restates the rule and clarifies that sibling services
  publish nothing.

Three drift-guard tests added: no address-prefixed publish appears unless marked as
wrong, the rule and its one-line justification are present, and the health check
inspects the binding.
