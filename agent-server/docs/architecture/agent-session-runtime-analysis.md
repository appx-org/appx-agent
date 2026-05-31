# AgentSessionRuntime: Do We Need It?

TL;DR analysis of Pi's `AgentSessionRuntime` and what agent-server should and shouldn't adopt from it.

**Reference:** [`/Users/max/misc/pj/misc/agents/pi/packages/coding-agent/src/core/agent-session-runtime.ts`](/Users/max/misc/pj/misc/agents/pi/packages/coding-agent/src/core/agent-session-runtime.ts)

## What It Is

A wrapper around `AgentSession` that owns the **single "current session"** for one Pi invocation. Manages the lifecycle of replacing that session via `/new`, `/resume`, `/fork`, `/import`. Used by `interactive` and `rpc` modes.

Owns: one mutable `session`, one `services` bundle, optional rebind/teardown callbacks for the host.

## Verdict for Agent-Server

**We don't need the class. We do want a handful of patterns from inside it.**

Why: `AgentSessionRuntime`'s reason to exist is single-session-replacement (`teardownCurrent` + `apply` on every switch/new/fork). Our model is multi-session-concurrent (`Map<sessionId, AgentSession>`, route by id). Most of its surface is dead weight for us; the rest is replicable in ~10 lines per case.

## Full Surface, Categorized

| Category | Members | Useful? |
|---|---|---|
| **Session-replacement lifecycle** | `switchSession`, `newSession`, `fork`, `importFromJsonl` | ❌ Wrong semantics (replace vs add). Reimplement directly via `SessionManager` when needed |
| **Extension hook orchestration** | `emitBeforeSwitch`, `emitBeforeFork`, `emitSessionShutdownEvent` on teardown | ⚠️ **Hooks valuable, wrapping not.** Call `session.extensionRunner.emit(...)` directly |
| **Host callbacks** | `setRebindSession`, `setBeforeSessionInvalidate` | ❌ Both exist for the single-current-session model and TUI sync teardown. Irrelevant for HTTP/SSE |
| **Diagnostics & fallback messaging** | `diagnostics`, `modelFallbackMessage` | ✅ **Adopt.** Real UX wins. We currently discard these |
| **CWD transition handling** | Recreates `AgentSessionServices` on cwd change inside `createRuntime` factory | ❌ Per-project runtime fixes cwd per session; never triggered |
| **Cleanup** | `dispose()` emits `session_shutdown` then disposes session | ✅ **Adopt the pattern.** We currently skip both |

## AgentSessionServices: Bundle vs Members

The bundle exists to make cwd transitions atomic — irrelevant for us.

| Member | Status in agent-server |
|---|---|
| `cwd`, `agentDir` | Already on `AgentRuntime` |
| `authStorage`, `modelRegistry` | Shared on `AgentRuntimeRegistry` |
| `resourceLoader` | Created per session via `makeResourceLoader()` |
| `settingsManager` | Not used; could enable future project-settings API |
| `diagnostics` | **Currently dropped on the floor** — should surface |

**Conclusion:** The struct adds no value. The members are already where they need to be; just capture the two we miss (`diagnostics`, optionally `settingsManager`).

## Concrete Gaps to Close (Without Adopting the Class)

These are ~10-line fixes worth doing regardless of architecture path:

### 1. Emit `session_shutdown` on session dispose

We currently `unsubscribe()` and stop tracking, but never call `session.dispose()` or fire the extension shutdown event. Stateful extensions never get cleanup signal. Becomes a real leak if we ever evict idle sessions.

```typescript
// Add to AgentRuntime
async disposeSession(id: string): Promise<void> {
  const entry = this.live.get(id);
  if (!entry) return;
  await emitSessionShutdownEvent(entry.session.extensionRunner, {
    type: "session_shutdown",
    reason: "quit",
  });
  entry.unsubscribe();
  entry.session.dispose();
  this.live.delete(id);
}
```

### 2. Capture and expose `diagnostics` + `modelFallbackMessage`

Today we destructure only `{ session }` from `createAgentSession()`. The full result has both diagnostic fields. Capture them on `LiveSession` and surface via API.

UX value: "3 extensions failed to load", "default model unavailable, using fallback".

### 3. Emit `session_before_fork` if/when we add fork

When implementing `forkSession`, give extensions a chance to veto:

```typescript
const result = await session.extensionRunner.emit({
  type: "session_before_fork",
  entryId,
  position: "before",
});
if (result?.cancel === true) return { cancelled: true };
```

Currently no extension uses this hook, but it's the right contract.

## What We'd Pay to Adopt the Whole Class

If we restructured around `AgentSessionRuntime` (one per session or one per project):

- ~1-2 weeks refactor
- New chat/runtime lifecycle to design
- Reservation registry to prevent same-JSONL-in-two-runtimes (Pi has no lock; concurrent writes silently fork the session tree — see `agent-session-runtime.ts` analysis in extension-ui-implementation-comparison.md)
- Carrying `setRebindSession`/`setBeforeSessionInvalidate` ceremony we'd never use

What we'd get: ~15 lines of fork code "for free", and the four extension hooks fired in the right places. All replicable directly in less code than the wrapper costs.

## Bottom Line

**Architecture:** Keep `AgentRuntime` (multi-session manager, rename to `ProjectRuntime` for clarity vs Pi's `AgentSessionRuntime`). Don't wrap sessions in `AgentSessionRuntime`.

**Patterns to adopt:** Fire `session_shutdown` on dispose; capture diagnostics; emit `session_before_fork` when adding fork. These are hygiene fixes, not architecture changes.

**Strategic stance:** We are the multi-session analogue of `AgentSessionRuntime`, not a consumer of it. Same shape (lifecycle owner over `AgentSession`), different concurrency model (N concurrent vs 1 current).
