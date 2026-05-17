/**
 * HTTP routes — Hono OpenAPIHono app exposing AgentRuntime over REST + SSE.
 *
 * Surface (mounted on the server under no prefix; the server adds /v1):
 *   GET    /sessions                list sessions (disk + in-memory)
 *   POST   /sessions                create new session
 *   GET    /sessions/{id}           persisted message history
 *   GET    /sessions/{id}/events    SSE stream of pi AgentSessionEvents
 *   POST   /sessions/{id}/prompt    send a user prompt
 *   POST   /sessions/{id}/abort     abort in-flight run
 *   GET    /healthz                 liveness + channel stats
 *
 * The SSE endpoint is *not* declared via @hono/zod-openapi — its response
 * is a long-lived stream, not a JSON body, and the OpenAPI tooling for
 * SSE is weak. We register a plain Hono GET for it and document it in the
 * spec manually below so consumers see the path.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import type { AgentRuntime } from "./runtime.js";
import {
  CreateSessionResponseSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  ListSessionsResponseSchema,
  OkResponseSchema,
  PromptRequestSchema,
  SessionIdParamSchema,
  SessionMessagesResponseSchema,
} from "./schemas.js";
import { channelStats, subscribe } from "./sseBroker.js";

/** Heartbeat cadence for SSE keepalive. Keeps proxies / LBs from closing idle streams. */
const SSE_HEARTBEAT_MS = 15_000;

/**
 * Build the Hono app exposing the runtime. Versioning is the caller's
 * job (server.ts mounts this under /v1) so we can move /v2 alongside
 * later without rewriting routes.
 */
export function createSessionsApp(runtime: AgentRuntime): OpenAPIHono {
  const app = new OpenAPIHono();

  // ── GET /sessions ────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/sessions",
      tags: ["sessions"],
      summary: "List sessions (persisted + in-memory not yet flushed).",
      responses: {
        200: {
          description: "Sessions, newest first.",
          content: {
            "application/json": { schema: ListSessionsResponseSchema },
          },
        },
      },
    }),
    async (c) => {
      const sessions = await runtime.listSessions();
      return c.json({ sessions }, 200);
    },
  );

  // ── POST /sessions ───────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/sessions",
      tags: ["sessions"],
      summary: "Create a new session.",
      responses: {
        200: {
          description: "Newly created session metadata.",
          content: {
            "application/json": { schema: CreateSessionResponseSchema },
          },
        },
      },
    }),
    async (c) => {
      const created = await runtime.createNewSession();
      return c.json(created, 200);
    },
  );

  // ── GET /sessions/{id} ───────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/sessions/{id}",
      tags: ["sessions"],
      summary: "Persisted message history for a session.",
      request: { params: SessionIdParamSchema },
      responses: {
        200: {
          description: "Messages for the session.",
          content: {
            "application/json": { schema: SessionMessagesResponseSchema },
          },
        },
        404: {
          description: "Unknown session id.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const messages = await runtime.getSessionMessages(id);
      if (messages === null) return c.json({ error: "session not found" }, 404);
      return c.json({ id, messages }, 200);
    },
  );

  // ── POST /sessions/{id}/prompt ───────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/sessions/{id}/prompt",
      tags: ["sessions"],
      summary: "Send a user prompt. Events flow over the SSE stream.",
      request: {
        params: SessionIdParamSchema,
        body: {
          required: true,
          content: { "application/json": { schema: PromptRequestSchema } },
        },
      },
      responses: {
        200: {
          description: "Prompt accepted and queued.",
          content: { "application/json": { schema: OkResponseSchema } },
        },
        404: {
          description: "Unknown session id.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { text } = c.req.valid("json");
      // Fire-and-forget: events flow over SSE, errors surface there too.
      runtime.sendPrompt(id, text).catch((err) => {
        console.error("[agent-server] prompt failed:", err);
      });
      return c.json({ ok: true } as const, 200);
    },
  );

  // ── POST /sessions/{id}/abort ────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/sessions/{id}/abort",
      tags: ["sessions"],
      summary: "Abort the in-flight run on a session. No-op if idle.",
      request: { params: SessionIdParamSchema },
      responses: {
        200: {
          description: "Abort accepted (or no-op if session was idle).",
          content: { "application/json": { schema: OkResponseSchema } },
        },
        404: {
          description: "Unknown session id.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        await runtime.abortSession(id);
        return c.json({ ok: true } as const, 200);
      } catch (err) {
        return c.json({ error: String(err) }, 404);
      }
    },
  );

  // ── GET /healthz ─────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/healthz",
      tags: ["meta"],
      summary: "Liveness + diagnostic counters.",
      responses: {
        200: {
          description: "OK.",
          content: { "application/json": { schema: HealthResponseSchema } },
        },
      },
    }),
    (c) =>
      c.json(
        {
          ok: true as const,
          service: "agent-server" as const,
          time: new Date().toISOString(),
          channels: channelStats(),
        },
        200,
      ),
  );

  // ── GET /sessions/{id}/events  (SSE — not in OpenAPI body schemas) ──
  //
  // Documented in the OpenAPI registry as text/event-stream so consumers
  // see the path, but no JSON schema is generated for it. The frontend
  // consumes this via `EventSource`; eventx-backend pipes the upstream
  // stream byte-for-byte.
  app.openAPIRegistry.registerPath({
    // pure documentation for reference
    method: "get",
    path: "/sessions/{id}/events",
    tags: ["sessions"],
    summary:
      "Server-Sent Events stream of pi AgentSessionEvents for the session.",
    request: { params: SessionIdParamSchema },
    responses: {
      200: {
        description:
          "SSE stream. Each event is `data: <json>` carrying a pi AgentSessionEvent.",
        content: {
          "text/event-stream": { schema: { type: "string" } as never },
        },
      },
      404: {
        description: "Unknown session id.",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
    },
  });

  // actual handler for the SSE endpoint
  app.get("/sessions/:id/events", async (c) => {
    const id = c.req.param("id");
    const session = await runtime.ensureSession(id);
    if (!session) return c.json({ error: "session not found" }, 404);

    return streamSSE(c, async (stream) => {
      // Per-subscriber queue + wakeup. Listener pushes; loop drains.
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const wait = () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        });

      const unsubscribe = subscribe(id, (event) => {
        queue.push(JSON.stringify(event));
        if (wake) {
          wake();
          wake = null;
        }
      });

      stream.onAbort(() => {
        unsubscribe();
        if (wake) {
          wake();
          wake = null;
        }
      });

      await stream.writeSSE({ data: `connected to ${id}` });

      let lastBeat = Date.now();
      while (!stream.aborted) {
        if (queue.length === 0) {
          const timer = new Promise<void>((resolve) =>
            setTimeout(resolve, SSE_HEARTBEAT_MS),
          );
          await Promise.race([wait(), timer]);
        }
        if (stream.aborted) break;

        while (queue.length > 0) {
          await stream.writeSSE({ data: queue.shift()! });
        }

        if (Date.now() - lastBeat >= SSE_HEARTBEAT_MS) {
          // Named event — frontend EventSource ignores it (no listener),
          // but the bytes keep proxies happy.
          await stream.writeSSE({ event: "heartbeat", data: "ping" });
          lastBeat = Date.now();
        }
      }

      unsubscribe();
    });
  });

  return app;
}
