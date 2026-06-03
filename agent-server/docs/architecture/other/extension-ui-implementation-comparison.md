# Extension UI Implementation: RPC Mode vs Agent-Server

## Overview

Both RPC mode and agent-server implement Pi's `ExtensionUIContext` interface, but with different architectural patterns driven by their concurrency models:

- **RPC mode**: Single "current session" model → one global ExtensionUIContext
- **Agent-server**: N concurrent sessions → ExtensionUIContext per session

This document analyzes the implementation differences and validates agent-server's design choices.

## Implementation Location Comparison

### RPC Mode

**File:** `/Users/max/misc/pj/misc/agents/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts`

```typescript
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
  // Closure scope - shared across entire RPC process
  const pendingExtensionRequests = new Map();
  
  const output = (obj) => {
    writeRawStdout(serializeJsonLine(obj));
  };
  
  // Create context once, in function scope
  const createExtensionUIContext = (): ExtensionUIContext => ({
    select: (title, options, opts) => 
      createDialogPromise(opts, undefined, 
        { method: "select", title, options, timeout: opts?.timeout },
        (r) => "cancelled" in r ? undefined : r.value
      ),
    confirm: (title, message, opts) => 
      createDialogPromise(opts, false,
        { method: "confirm", title, message, timeout: opts?.timeout },
        (r) => "cancelled" in r ? false : r.confirmed
      ),
    // ... other methods
  });
  
  // Bind to session
  const rebindSession = async () => {
    session = runtimeHost.session;
    await session.bindExtensions({
      uiContext: createExtensionUIContext(),  // ← Same context factory
      commandContextActions: { ... },
      onError: (err) => { output({ type: "extension_error", ... }); }
    });
  };
}
```

**Key characteristics:**
1. ✅ **Function scope** - All state lives in `runRpcMode()` closure
2. ✅ **Process-global state** - One `pendingExtensionRequests` map
3. ✅ **Shared output channel** - One `output()` function writes to stdout
4. ✅ **Session rebinding** - Same context factory reused when switching sessions

### Agent-Server

**File:** `src/runtime.ts`

```typescript
export class AgentRuntime {
  private readonly live = new Map<string, LiveSession>();
  private readonly pendingExtensionUi = new Map<string, PendingExtensionUiRequest>();
  
  // Instance method - creates session-scoped context
  private createExtensionUiContext(sessionId: string): ExtensionUIContext {
    return {
      select: (title, options, opts) =>
        this.createDialogPromise(
          sessionId,  // ← Session-scoped!
          opts,
          undefined,
          { method: "select", title, options, timeout: opts?.timeout },
          (response) => ("cancelled" in response ? undefined : response.value),
        ),
      confirm: (title, message, opts) =>
        this.createDialogPromise(
          sessionId,  // ← Session-scoped!
          opts,
          false,
          { method: "confirm", title, message, timeout: opts?.timeout },
          (response) => ("cancelled" in response ? false : response.confirmed),
        ),
      // ... other methods
    };
  }
  
  // Bind to session
  private bind(session: AgentSession): void {
    const id = session.sessionId;
    const extensionsReady = session.bindExtensions({
      uiContext: this.createExtensionUiContext(id),  // ← Session-specific
      commandContextActions: this.extensionCommandActions(session),
      onError: (err) => {
        publish(id, { type: "extension_error", ... });
      },
    });
    this.live.set(id, { session, unsubscribe, boundAt, extensionsReady });
  }
}
```

**Key characteristics:**
1. ✅ **Class scope** - State lives in `AgentRuntime` instance
2. ✅ **Per-session context** - Each session gets `createExtensionUiContext(sessionId)`
3. ✅ **Session-routed output** - `publish(sessionId, event)` routes to correct SSE clients
4. ✅ **Concurrent binding** - Multiple sessions bound simultaneously

## Concurrency Model Differences

### RPC Mode: Sequential Session Model

```
Time ──────────────────────────────────────────────►

┌─────────────────────┐  Switch  ┌─────────────────────┐
│  Session A          │  ──────► │  Session B          │
│  (current session)  │  Unbind  │  (new current)      │
│                     │  Rebind  │                     │
└─────────────────────┘          └─────────────────────┘
         ▲                                  ▲
         │                                  │
    ONE context                        ONE context
    (rebound to B)                     (same factory)
```

**RPC process state at any moment:**
```typescript
// Single global state
let session = runtimeHost.session;  // ← ONE current session
const pendingExtensionRequests = new Map();  // ← All requests for current session
const createExtensionUIContext = () => ({ ... });  // ← Factory reused on switch
```

When switching sessions:
```typescript
// 1. Teardown
await session.dispose();

// 2. Switch
await runtimeHost.switchSession("other.jsonl");

// 3. Rebind (same context, new session)
session = runtimeHost.session;
await session.bindExtensions({
  uiContext: createExtensionUIContext(),  // ← Same factory, bound to new session
  ...
});
```

### Agent-Server: Concurrent Session Model

```
Time ──────────────────────────────────────────────►

┌─────────────────────┐                              
│  Session A          │  ◄─── Client 1 POST/GET      
│  Context A          │                              
└─────────────────────┘                              
                                                     
┌─────────────────────┐                              
│  Session B          │  ◄─── Client 2 POST/GET      
│  Context B          │                              
└─────────────────────┘                              
                                                     
┌─────────────────────┐                              
│  Session C          │  ◄─── Client 3 POST/GET      
│  Context C          │                              
└─────────────────────┘                              
```

**Agent-server state at any moment:**
```typescript
// N concurrent sessions
private readonly live = new Map<string, LiveSession>();
// ├─ "session-a" → { session, context: createExtensionUiContext("session-a") }
// ├─ "session-b" → { session, context: createExtensionUiContext("session-b") }
// └─ "session-c" → { session, context: createExtensionUiContext("session-c") }

private readonly pendingExtensionUi = new Map<string, PendingExtensionUiRequest>();
// ├─ "req-uuid-1" → { sessionId: "session-a", request, resolve }
// ├─ "req-uuid-2" → { sessionId: "session-b", request, resolve }
// └─ "req-uuid-3" → { sessionId: "session-a", request, resolve }  // Another for A
```

When handling HTTP requests:
```typescript
// POST /projects/abc/sessions/session-a/prompt
const session = await this.ensureSession("session-a");  // ← Get or create
await session.prompt(text);  // ← Session A keeps running

// POST /projects/abc/sessions/session-b/prompt (concurrent!)
const session = await this.ensureSession("session-b");  // ← Different session
await session.prompt(text);  // ← Session B runs in parallel
```

## Extension UI Request Routing

### RPC Mode: Implicit Routing (Current Session Only)

```typescript
// Extension calls ui.select()
await session.extensionRunner.uiContext.select("Pick one", ["A", "B"]);

// Flows to:
const createExtensionUIContext = () => ({
  select: (title, options, opts) =>
    createDialogPromise(opts, undefined, 
      { method: "select", title, options },
      (r) => r.value
    )
});

function createDialogPromise(...) {
  const id = crypto.randomUUID();
  
  // Register in closure-scoped map (implicitly for current session)
  pendingExtensionRequests.set(id, { resolve, reject });
  
  // Write to stdout
  output({ type: "extension_ui_request", id, method: "select", ... });
  
  return promise;
}

// Client response comes in via stdin:
// {"type":"extension_ui_response","id":"<uuid>","value":"A"}

// Lookup in single global map
const pending = pendingExtensionRequests.get(response.id);
if (pending) {
  pending.resolve(response);  // ← Completes the promise
}
```

**Why this works:**
- ONE current session → only one session's extensions can emit UI requests at a time
- No ambiguity about which session a request belongs to
- Single stdin/stdout pair → natural serialization

### Agent-Server: Explicit Routing (Session ID Required)

```typescript
// Extension calls ui.select()
await session.extensionRunner.uiContext.select("Pick one", ["A", "B"]);

// Flows to:
private createExtensionUiContext(sessionId: string): ExtensionUIContext {
  return {
    select: (title, options, opts) =>
      this.createDialogPromise(
        sessionId,  // ← Captures session ID in closure!
        opts,
        undefined,
        { method: "select", title, options },
        (response) => response.value
      )
  };
}

private createDialogPromise<T>(
  sessionId: string,  // ← Session context
  opts,
  defaultValue,
  request,
  mapResponse
): Promise<T> {
  const id = randomUUID();
  
  const pending: PendingExtensionUiRequest = {
    sessionId,  // ← Store which session this request belongs to
    request: { type: "extension_ui_request", id, ...request },
    resolve: (response) => {
      cleanup();
      resolve(mapResponse(response));
    },
  };
  
  // Register in class-scoped map (tagged with sessionId)
  this.pendingExtensionUi.set(id, pending);
  
  // Publish to SSE broker (routes to all clients watching this session)
  this.publishExtensionUiRequest(sessionId, pending.request);
  
  return promise;
}

// Client response via HTTP:
// POST /projects/abc/sessions/session-a/extension-ui/req-123/response
// {"value":"A"}

public resolveExtensionUiRequest(sessionId: string, requestId: string, response: ExtensionUiResponse): boolean {
  const pending = this.pendingExtensionUi.get(requestId);
  
  // Verify sessionId matches (prevents cross-session hijacking)
  if (!pending || pending.sessionId !== sessionId) return false;
  
  pending.resolve(response);  // ← Completes the promise for the right session
  return true;
}
```

**Why this is necessary:**
- N concurrent sessions → multiple sessions' extensions can emit UI requests simultaneously
- Need to route response back to correct session's waiting extension
- Multiple SSE clients → need to know which session to broadcast to

## State Management Comparison

### RPC Mode: Closure Scope

```typescript
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
  // ─────────────────────────────────────────────────
  // Closure scope - accessible to all nested functions
  // ─────────────────────────────────────────────────
  
  let session = runtimeHost.session;  // Mutable: updated on switch
  let unsubscribe: (() => void) | undefined;
  
  const pendingExtensionRequests = new Map();  // Request correlation
  const signalCleanupHandlers: Array<() => void> = [];  // SIGTERM handlers
  let shutdownRequested = false;
  let shuttingDown = false;
  
  const output = (obj) => { ... };  // Writes to stdout
  const createDialogPromise = (...) => { ... };  // Accesses pendingExtensionRequests
  const createExtensionUIContext = () => ({ ... });  // Accesses createDialogPromise
  const rebindSession = async () => { ... };  // Accesses session, createExtensionUIContext
  
  // All functions form a closure over shared state
  // ─────────────────────────────────────────────────
}
```

**Characteristics:**
- ✅ Natural JavaScript pattern for single-context apps
- ✅ Clear lifetime - state dies when function returns (never)
- ✅ No need for explicit scoping - closure captures everything
- ⚠️ Not extensible to multi-session without major refactoring

### Agent-Server: Class Instance Scope

```typescript
export class AgentRuntime {
  // ─────────────────────────────────────────────────
  // Instance members - accessible to all methods
  // ─────────────────────────────────────────────────
  
  private readonly live = new Map<string, LiveSession>();  // N sessions
  private readonly pendingExtensionUi = new Map<string, PendingExtensionUiRequest>();
  private readonly projectDir: string;
  private readonly sessionsDir: string;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  // ... other config
  
  private bind(session: AgentSession): void { ... }
  private createDialogPromise<T>(sessionId: string, ...): Promise<T> { ... }
  private createExtensionUiContext(sessionId: string): ExtensionUIContext { ... }
  private publishExtensionUiRequest(sessionId: string, request): void { ... }
  
  // Methods operate on class state + per-session routing
  // ─────────────────────────────────────────────────
}
```

**Characteristics:**
- ✅ Handles multiple sessions naturally (Map-based)
- ✅ Explicit lifetime management (create/destroy instances)
- ✅ State isolation per-session via `sessionId` parameter
- ✅ Can instantiate multiple `AgentRuntime` (multi-project via `ProjectRegistry`)

## Key Architectural Differences

| Aspect | RPC Mode | Agent-Server |
|--------|----------|--------------|
| **Scope** | Function closure | Class instance |
| **Sessions** | ONE (mutable `let session`) | N concurrent (`Map<id, LiveSession>`) |
| **Context creation** | `createExtensionUIContext()` - no params | `createExtensionUiContext(sessionId)` - scoped |
| **Request correlation** | Single Map (implicitly current session) | Map with `sessionId` field (explicit routing) |
| **Output** | `output()` → stdout | `publish(sessionId, ...)` → SSE broker |
| **Rebinding** | `rebindSession()` switches to new current | `bind(session)` adds to live set |
| **State lifetime** | Process lifetime (never returns) | Instance lifetime (can dispose) |

## Is Agent-Server's Approach Correct?

### ✅ Yes - Required by Multi-Session Model

**RPC mode's pattern doesn't scale to concurrent sessions:**

```typescript
// What if we tried RPC's pattern with N sessions?

// PROBLEM 1: No way to know which session emitted the request
const pendingExtensionRequests = new Map();  // ← No sessionId!
// Extension A calls ui.select() while extension B also calls ui.select()
// Both get UUIDs, but nothing ties them back to sessions

// PROBLEM 2: Output goes to single stdout
output({ type: "extension_ui_request", id: "uuid-1", ... });
// Which HTTP client should receive this? All? One? How do we know?

// PROBLEM 3: Response can't be routed
// Client responds to uuid-1, but we don't know which session's promise to resolve
```

**Agent-server's solution:**

```typescript
// Explicit session routing
private createExtensionUiContext(sessionId: string): ExtensionUIContext {
  return {
    select: (...) => this.createDialogPromise(sessionId, ...)  // ← Closure captures sessionId
  };
}

// Request tagged with session
const pending = {
  sessionId,  // ← We know which session this belongs to
  request,
  resolve,
};

// Output routed to session's subscribers
publish(sessionId, request);  // ← SSE broker fans out to that session's clients

// Response validated against session
resolveExtensionUiRequest(sessionId, requestId, response) {
  const pending = this.pendingExtensionUi.get(requestId);
  if (pending.sessionId !== sessionId) return false;  // ← Prevent hijacking
  pending.resolve(response);
}
```

### ✅ Yes - Follows Pi's Layering Pattern

From `docs/misc/edu/pi/pi-component-responsibilities.md`:

> **RPC mode** is an adapter over `AgentSessionRuntime` (single-session lifecycle).  
> **Agent-server** is an adapter over `AgentSession` (N concurrent sessions).

Both implement `ExtensionUIContext`, but adapt it to their transport and concurrency model:

| Mode | Transport | Concurrency | Context Creation |
|------|-----------|-------------|------------------|
| Interactive (TUI) | Terminal I/O | Single session | Function closure |
| RPC | stdin/stdout | Single session (switchable) | Function closure |
| Agent-server | HTTP+SSE | N concurrent | Class instance + session param |

**All are valid implementations of the same interface, adapted to their environment.**

### ✅ Yes - Class vs Closure is Style, Not Substance

RPC mode could be refactored as a class:

```typescript
class RpcMode {
  private session: AgentSession;
  private pendingExtensionRequests = new Map();
  
  private createExtensionUIContext(): ExtensionUIContext {
    return {
      select: (...) => this.createDialogPromise(...)
    };
  }
  
  async run(runtimeHost: AgentSessionRuntime) { ... }
}
```

Agent-server could be refactored as nested functions:

```typescript
export function createAgentRuntime(config): AgentRuntime {
  const live = new Map<string, LiveSession>();
  const pendingExtensionUi = new Map();
  
  const createExtensionUiContext = (sessionId) => ({ ... });
  
  return {
    createNewSession: async () => { ... },
    sendPrompt: async (id, text) => { ... },
    // ...
  };
}
```

**The real difference is multi-session vs single-session, not class vs closure.**

## Recommendations

### ✅ Keep Agent-Server's Current Implementation

1. **Class-based state** is appropriate for multi-session lifecycle management
2. **Session-scoped context** (`createExtensionUiContext(sessionId)`) is necessary for routing
3. **Map-based tracking** (`pendingExtensionUi` with `sessionId` field) prevents cross-session contamination
4. **Publish-based output** (`publish(sessionId, event)`) correctly fans out to N SSE clients

### 📖 Document the Difference

Already done in `docs/architecture/pi-modes-analysis.md`:

> **Fundamental Difference: Single vs Multi-Session**
>
> RPC uses `AgentSessionRuntime` for single-session-switching.  
> Agent-server's concurrent multi-session model requires managing sessions differently (Map of live sessions).

### 🎯 Pattern Consistency

Both implementations follow the same **core pattern** from Pi:

```typescript
// 1. Pending request correlation
const pending = new Map<requestId, { resolve, reject }>();

// 2. Dialog promise with timeout/abort
function createDialogPromise(opts, defaultValue, request, parseResponse) {
  const id = randomUUID();
  return new Promise((resolve) => {
    // Timeout handling
    if (opts?.timeout) setTimeout(() => resolve(defaultValue), opts.timeout);
    
    // Abort signal handling
    opts?.signal?.addEventListener("abort", () => resolve(defaultValue));
    
    // Store resolver
    pending.set(id, { resolve: (response) => resolve(parseResponse(response)) });
    
    // Emit request
    emitRequest({ id, ...request });
  });
}

// 3. Extension UI context as interface implementation
const createExtensionUIContext = () => ({
  select: (...) => createDialogPromise(...),
  confirm: (...) => createDialogPromise(...),
  notify: (...) => emitRequest(...),  // Fire-and-forget
  // ...
});
```

Agent-server adds **one parameter** (`sessionId`) to route requests in a multi-session environment. That's the only architectural difference.

## Conclusion

**Agent-server's ExtensionUI implementation is architecturally sound.**

It correctly adapts Pi's RPC mode pattern to a multi-session HTTP+SSE environment:

- ✅ Uses same request/response correlation pattern
- ✅ Uses same timeout/abort handling
- ✅ Adds session routing where RPC mode has implicit current session
- ✅ Publishes to SSE where RPC mode writes to stdout

**The choice of class vs closure is a stylistic consequence of the concurrency model, not a deviation from Pi's architecture.**

RPC mode = single-session closure  
Agent-server = multi-session class instance

Both are valid implementations of `ExtensionUIContext` for their respective environments.
