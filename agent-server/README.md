# @appx/agent-server

Pi-SDK-based agent orchestration server, shared across Appx apps.

This is the `Agent Server Source` from the [Appx App Anatomy diagram](../docs/intro/app-anatomy.png): a
TypeScript package that wraps the [pi coding agent SDK](https://github.com/earendil-works/pi)
into a reusable runtime + HTTP/SSE surface. Each Appx app instantiates an
`AgentRuntime` pointed at its own project dir + sessions dir, mounts the
sessions router on its Express app, and the rest of the app code only sees
a stable REST/SSE contract.

## Usage

```ts
import express from "express";
import { AgentRuntime, createSessionsRouter } from "@appx/agent-server";

const runtime = new AgentRuntime({
  projectDir: "/abs/path/to/app", // pi session cwd; skill discovery rooted here
  sessionsDir: "/abs/path/to/data/sessions",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY, // optional
});

const app = express();
app.use(express.json());
app.use("/api/sessions", createSessionsRouter(runtime));
app.listen(3001);
```

## Surface

REST + SSE endpoints exposed by `createSessionsRouter`:

- `GET    /` list sessions (disk + in-memory unflushed)
- `POST   /` create a new session, returns `{ id, createdAt }`
- `GET    /:id` persisted message history
- `GET    /:id/events` SSE stream of pi-shaped `AgentSessionEvent`s
- `POST   /:id/prompt` `{ text }` — send a user prompt; events flow over SSE

## Pi specifics

See `apps/eventx/CLAUDE.md` "Pi specifics" section. Key points:

- Pi writes session JSONL files lazily (on first `message_end`), so listing
  merges disk + live in-memory sessions.
- `text_delta` events carry chunks in `delta`; `partial` is the full message
  object, not a string.
- Tool result messages have `role: "toolResult"` and arrive after the
  tool-using assistant `message_end`.
