# RPC Mode vs Custom Server Architecture

## Context

Agent-server is built directly on Pi's `AgentSession` library rather than using Pi's built-in RPC mode. This document explains the architectural decision and trade-offs.

## What is Pi's RPC Mode?

Pi's RPC mode (`@earendil-works/pi-coding-agent/modes/rpc`) provides a headless JSON-RPC protocol over stdin/stdout:

```typescript
import { RpcClient } from "@earendil-works/pi-coding-agent/modes/rpc";

// Spawns: pi --rpc
const client = new RpcClient({ cwd: "/project" });
await client.start();

// Commands sent as JSON lines to stdin
await client.prompt("hello");

// Events emitted as JSON lines from stdout
client.onEvent((event) => console.log(event));
```

**Design intent:** Embed a coding agent in desktop apps, IDEs, or non-Node.js environments where spawning a child process is natural.

**Reference:** [`node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.d.ts`](../../node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.d.ts)

## Why Agent-Server Uses Direct AgentSession

### 1. Multi-Project Architecture

**Requirement:** Serve multiple isolated projects in a single HTTP server, each with its own system prompt, skills, and session storage.

**RPC limitation:** One RPC process = one runtime with one project directory:

```typescript
// Pi RPC: Single project per process
const client = new RpcClient({ cwd: "/project-a" });
// Can only switch between sessions within /project-a
await client.switchSession("other.jsonl");
```

**Agent-server solution:** `AgentRuntimeRegistry` manages multiple in-process runtimes:

```typescript
// src/runtimeRegistry.ts
export class AgentRuntimeRegistry {
  private readonly runtimes = new Map<string, RuntimeEntry>();

  forProject(context: ProjectRuntimeContext): AgentRuntime {
    const projectDir = resolve(context.projectDir);
    const existing = this.runtimes.get(context.id);
    if (existing?.projectDir === projectDir) return existing.runtime;

    return this.createRuntime({ ...context, projectDir });
  }
}
```

Each runtime gets isolated:
- `projectDir`: Root for skill/extension discovery
- `sessionsDir`: `${projectDir}/data/sessions`
- `agentsFile`: Project-specific system prompt
- Extensions: Project-local `.pi/extensions/`

**With RPC, we would need:**
1. Spawn N `pi --rpc` child processes (one per project)
2. Build a router to map `projectId` → RPC client
3. Handle process lifecycle (spawn, crash recovery, cleanup)
4. Serialize access to each project's stdio pipe

**Reference:** [`src/runtimeRegistry.ts`](../../src/runtimeRegistry.ts)

### 2. Web-Native Protocol

**Requirement:** Serve browser clients with standard HTTP REST + SSE streaming.

**RPC protocol:** stdin/stdout JSON lines, designed for process embedding:

```typescript
// Command (written to stdin)
{"type":"prompt","message":"hello","id":"req-123"}

// Response (read from stdout)
{"type":"response","command":"prompt","success":true,"id":"req-123"}

// Event (read from stdout)
{"type":"message_update","message":{...}}
```

**Agent-server protocol:** Native HTTP endpoints:

```typescript
// src/routes.ts
POST   /v1/projects/{id}/sessions/{sessionId}/prompt
GET    /v1/projects/{id}/sessions/{sessionId}/events  (SSE)
GET    /v1/projects/{id}/sessions
PATCH  /v1/projects/{id}/sessions/{sessionId}/settings
```

Browser consumption:
```typescript
// Standard fetch + EventSource
await fetch('/v1/projects/abc/sessions/123/prompt', {
  method: 'POST',
  body: JSON.stringify({ message: 'hello' })
});

const events = new EventSource('/v1/projects/abc/sessions/123/events');
events.onmessage = (e) => console.log(JSON.parse(e.data));
```

**With RPC, we would need:**
1. HTTP server that writes to RPC stdin
2. Bridge stdout JSON lines → SSE data frames
3. Request correlation (HTTP request ID → stdin/stdout ID)
4. Handle protocol differences (HTTP timeouts, SSE keepalive, stdio buffering)

**Reference:** [`src/routes.ts`](../../src/routes.ts), [`node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts`](../../node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts)

### 3. Concurrent Multi-Client Support

**Requirement:** Multiple browser clients (tabs, users) can watch the same session or different sessions concurrently.

**RPC mode:** Single client owns the process, receives all events:

```typescript
// RpcClient is 1:1 with the RPC process
const client = new RpcClient();
client.onEvent((event) => {
  // This callback receives ALL events for ALL sessions
  // Filtering and routing is the client's responsibility
});
```

**Agent-server solution:** SSE broker with pub/sub fan-out:

```typescript
// src/sseBroker.ts
const channels = new Map<string, Set<Response>>();

export function publish(sessionId: string, event: unknown): void {
  const subs = channels.get(sessionId);
  if (!subs) return;
  for (const res of subs) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

export function subscribe(sessionId: string, res: Response): void {
  if (!channels.has(sessionId)) channels.set(sessionId, new Set());
  channels.get(sessionId)!.add(res);
}
```

Usage in appx (Go proxy):
```go
// appx/internal/server/agent_proxy.go
// Multiple browser tabs can stream same session
GET /appx/projects/{id}/agent/sessions/{sessionId}/events

// All receive same AgentSessionEvent stream via SSE broker
```

**With RPC, we would need:**
1. Parse every stdout event to extract session ID
2. Maintain `Map<sessionId, Set<SseConnection>>`
3. Fan out each event to N connections
4. Handle connection lifecycle (reconnect, cleanup)
5. Queue events during reconnection gaps

Agent-session events published via `runtime.ts`:
```typescript
// src/runtime.ts
private bind(session: AgentSession): void {
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    publish(id, event); // SSE broker handles fan-out
  });
}
```

**Reference:** [`src/sseBroker.ts`](../../src/sseBroker.ts), [`src/runtime.ts`](../../src/runtime.ts)

### 4. Deployment and Integration Simplicity

**Requirement:** Single-process deployment with standard HTTP reverse proxy integration.

**RPC approach would require:**

```
┌─────────────────────────────────────┐
│  HTTP Server (Node.js)              │
│  ├─ Process Manager                 │
│  │  ├─ spawn("pi", ["--rpc"])       │
│  │  ├─ respawn on crash             │
│  │  └─ monitor N processes          │
│  ├─ Request Router                  │
│  │  └─ projectId → RPC client       │
│  ├─ Protocol Bridge                 │
│  │  ├─ HTTP → stdin JSON            │
│  │  ├─ stdout JSON → SSE            │
│  │  └─ correlation tracking         │
│  └─ Error Handling                  │
│     ├─ stdio errors                 │
│     ├─ process crashes              │
│     └─ buffer overflows             │
└─────────────────────────────────────┘
```

**Agent-server approach:**

```
┌─────────────────────────────────────┐
│  HTTP Server (Node.js)              │
│  ├─ AgentRuntimeRegistry            │
│  │  └─ Map<projectId, AgentRuntime> │
│  ├─ Direct method calls             │
│  │  └─ runtime.sendPrompt(id, text) │
│  └─ Standard HTTP error handling    │
└─────────────────────────────────────┘
```

From `runtimeRegistry.ts`:
```typescript
forProject(context: ProjectRuntimeContext): AgentRuntime {
  const existing = this.runtimes.get(context.id);
  if (existing?.projectDir === projectDir) return existing.runtime;
  
  // Just instantiate in-memory, no process spawning
  return this.createRuntime(context);
}
```

**Operational advantages:**
- **Single process**: Standard systemd/Docker deployment
- **No IPC**: Direct method calls, no serialization overhead
- **Simpler debugging**: One process to attach, standard Node.js profiling
- **Standard monitoring**: Single PID, memory/CPU in one view
- **Graceful shutdown**: Just `server.close()`, no child process cleanup

**Integration with appx:**
```go
// appx/internal/server/agent_proxy.go
// Standard HTTP reverse proxy to agent-server
proxy := &httputil.ReverseProxy{
  Director: func(req *http.Request) {
    req.URL.Scheme = "http"
    req.URL.Host = "localhost:8001" // agent-server
    req.Header.Set("X-Appx-Project-Id", projectID)
  },
}
```

No special handling for child processes, stdio, or IPC.

**Reference:** [`src/runtimeRegistry.ts`](../../src/runtimeRegistry.ts), [`appx/internal/server/agent_proxy.go`](https://github.com/neuromaxer/appx/blob/main/internal/server/agent_proxy.go)

## When to Use RPC Mode

Pi's RPC mode is excellent for:

1. **Non-Node.js environments**: Python, Go, Rust clients that can spawn processes and parse JSON
2. **Process isolation**: Security boundaries where the agent must run sandboxed
3. **Desktop apps**: Embedding in Electron, VSCode extensions, CLI tools
4. **Single-project workflows**: Traditional IDE-style agent interactions

## Conclusion

Agent-server's architecture is optimized for its requirements:

- ✅ **Multi-project**: N isolated runtimes in one process
- ✅ **Web-native**: HTTP+SSE without protocol bridging
- ✅ **Multi-client**: Native pub/sub event fan-out
- ✅ **Simple deployment**: Single Node.js process, standard reverse proxy

Using RPC mode would add complexity (process management, IPC bridging, event routing) without providing benefits for a Node.js web server use case.

**Trade-off:** We're coupled to Pi's Node.js SDK and running in the same process. If we needed language-agnostic clients or process isolation, RPC mode would be the right choice.

**Industry alignment:** This follows the pattern of web frameworks that provide both library (Express, Fastify) and standalone server (nginx, Apache) modes. We're using the library mode because we're already in the same runtime.
