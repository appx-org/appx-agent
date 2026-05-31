/**
 * HTTP routes — Hono OpenAPIHono app exposing ProjectRuntime over REST + SSE.
 *
 * Surface (mounted on the server under no prefix; the server adds /v1):
 *   GET    /sessions                list sessions (disk + in-memory)
 *   POST   /sessions                create new session
 *   GET    /sessions/models         list selectable models
 *   GET    /auth/providers          list provider auth status without secrets
 *   PUT    /auth/providers/{provider}/api-key
 *                                      store a provider API key in Pi auth storage
 *   DELETE /auth/providers/{provider}
 *                                      remove a stored provider credential
 *   POST   /auth/providers/{provider}/subscription/start
 *                                      start a Pi subscription OAuth flow
 *   GET    /auth/subscription/{flowId}
 *                                      read subscription OAuth flow state
 *   POST   /auth/subscription/{flowId}/continue
 *                                      continue OAuth prompt/code input
 *   DELETE /auth/subscription/{flowId}
 *                                      cancel a pending OAuth flow
 *   GET    /custom/providers          list custom models.json providers
 *   PUT    /custom/providers          create/update a custom provider
 *   DELETE /custom/providers/{provider}
 *                                      remove a custom provider
 *   GET    /sessions/{id}           persisted message history
 *   GET    /sessions/{id}/settings  return current model/thinking settings
 *   PATCH  /sessions/{id}/settings  switch model and/or thinking level while idle
 *   GET    /sessions/{id}/events    SSE stream of pi AgentSessionEvents
 *   GET    /sessions/{id}/extension-ui
 *                                      list pending extension UI requests
 *   POST   /sessions/{id}/extension-ui/{requestId}/response
 *                                      answer extension UI request
 *   POST   /sessions/{id}/prompt    send a user prompt
 *   POST   /sessions/{id}/abort     abort in-flight run
 *   GET    /healthz                 liveness + channel stats
 *
 * The SSE endpoint is *not* declared via @hono/zod-openapi — its response
 * is a long-lived stream, not a JSON body, and the OpenAPI tooling for
 * SSE is weak. We register a plain Hono GET for it and document it in the
 * spec manually below so consumers see the path.
 */
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { ProjectRuntime } from "./projectRuntime.js";
import type { AgentCredentialsService } from "./credentialsService.js";
import {
  CreateSessionResponseSchema,
  ContinueOAuthFlowRequestSchema,
  CustomProviderRowSchema,
  ErrorResponseSchema,
  ExtensionUiRequestIdParamSchema,
  ExtensionUiResponseRequestSchema,
  HealthResponseSchema,
  ListCustomProvidersResponseSchema,
  ListAuthProvidersResponseSchema,
  ListSessionsResponseSchema,
  ListModelsResponseSchema,
  OAuthFlowIdParamSchema,
  OAuthFlowStateSchema,
  OkResponseSchema,
  PatchSessionSettingsRequestSchema,
  PendingExtensionUiRequestsResponseSchema,
  PromptRequestSchema,
  ProviderParamSchema,
  SetProviderApiKeyRequestSchema,
  SessionIdParamSchema,
  SessionMessagesResponseSchema,
  SessionModelSettingsResponseSchema,
  UpsertCustomProviderRequestSchema,
} from "./schemas.js";
import { channelStats, subscribe } from "./sseBroker.js";

/** Heartbeat cadence for SSE keepalive. Keeps proxies / LBs from closing idle streams. */
const SSE_HEARTBEAT_MS = 15_000;

export type ProjectRuntimeResolver = (c: Context) => ProjectRuntime | Promise<ProjectRuntime>;
export type CreateSessionsAppOptions = Record<string, never>;

export type AgentCredentialsResolver = (c: Context) => AgentCredentialsService | Promise<AgentCredentialsService>;
export type CreateCredentialsAppOptions = {
  /** Liveness endpoint for this mounted API. Default true. */
  healthRoute?: boolean;
};

function isRuntimeResolver(
  runtime: ProjectRuntime | ProjectRuntimeResolver,
): runtime is ProjectRuntimeResolver {
  return typeof runtime === "function";
}

function isCredentialsResolver(
  credentials: AgentCredentialsService | AgentCredentialsResolver,
): credentials is AgentCredentialsResolver {
  return typeof credentials === "function";
}

function settingsErrorStatus(err: unknown): 400 | 404 | 409 | 500 {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("not found")) return 404;
  if (message.includes("running")) return 409;
  if (message.includes("No API key")) return 400;
  return 500;
}

/**
 * Build the Hono app exposing the runtime. Versioning is the caller's
 * job (server.ts mounts this under /v1) so we can move /v2 alongside
 * later without rewriting routes.
 */
export function createSessionsApp(
  runtime: ProjectRuntime | ProjectRuntimeResolver,
): OpenAPIHono {
  const app = new OpenAPIHono();
  const getRuntime = (c: Context) =>
    isRuntimeResolver(runtime) ? runtime(c) : runtime;

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
      const runtime = await getRuntime(c);
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
      const runtime = await getRuntime(c);
      const session = await runtime.createNewSession();
      return c.json({ id: session.sessionId, createdAt: session.boundAt }, 200);
    },
  );

  // ── GET /sessions/{id}/settings ─────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/sessions/{id}/settings",
      tags: ["models"],
      summary: "Return the active model/thinking settings for a session.",
      request: { params: SessionIdParamSchema },
      responses: {
        200: {
          description: "Session model settings.",
          content: {
            "application/json": { schema: SessionModelSettingsResponseSchema },
          },
        },
        404: {
          description: "Unknown session id.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
      },
    }),
    async (c) => {
      const runtime = await getRuntime(c);
      const { id } = c.req.valid("param");
      const session = await runtime.getSession(id);
      if (!session) return c.json({ error: "session not found" }, 404);
      return c.json(session.getModelSettings(), 200);
    },
  );

  // ── PATCH /sessions/{id}/settings ────────────────────────────────
  app.openapi(
    createRoute({
      method: "patch",
      path: "/sessions/{id}/settings",
      tags: ["models"],
      summary: "Switch model and/or thinking level while a session is idle.",
      request: {
        params: SessionIdParamSchema,
        body: {
          required: true,
          content: { "application/json": { schema: PatchSessionSettingsRequestSchema } },
        },
      },
      responses: {
        200: {
          description: "Effective session model settings.",
          content: {
            "application/json": { schema: SessionModelSettingsResponseSchema },
          },
        },
        400: {
          description: "Invalid settings body.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
        404: {
          description: "Unknown session id or model id.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
        409: {
          description: "Session is currently running.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
        500: {
          description: "Unexpected settings update error.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
      },
    }),
    async (c) => {
      const runtime = await getRuntime(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const hasProvider = Boolean(body.provider);
      const hasModelId = Boolean(body.modelId);
      if (hasProvider !== hasModelId) {
        return c.json({ error: "provider and modelId must be supplied together" }, 400);
      }
      if (!body.provider && !body.thinkingLevel) {
        return c.json({ error: "provider/modelId or thinkingLevel is required" }, 400);
      }
      const session = await runtime.getSession(id);
      if (!session) return c.json({ error: "session not found" }, 404);
      try {
        const settings = await session.updateModelSettings(body);
        return c.json(settings, 200);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, settingsErrorStatus(err));
      }
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
      const runtime = await getRuntime(c);
      const { id } = c.req.valid("param");
      const session = await runtime.getSession(id);
      if (!session) return c.json({ error: "session not found" }, 404);
      return c.json({ id, messages: session.getMessages() }, 200);
    },
  );

  // ── GET /sessions/{id}/extension-ui ─────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/sessions/{id}/extension-ui",
      tags: ["extensions"],
      summary: "List pending extension UI requests for a session.",
      request: { params: SessionIdParamSchema },
      responses: {
        200: {
          description: "Pending extension UI request events.",
          content: {
            "application/json": { schema: PendingExtensionUiRequestsResponseSchema },
          },
        },
        404: {
          description: "Unknown session id.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
      },
    }),
    async (c) => {
      const runtime = await getRuntime(c);
      const { id } = c.req.valid("param");
      const session = await runtime.getSession(id);
      if (!session) return c.json({ error: "session not found" }, 404);
      return c.json({ requests: session.pendingExtensionUiRequests() }, 200);
    },
  );

  // ── POST /sessions/{id}/extension-ui/{requestId}/response ───────
  app.openapi(
    createRoute({
      method: "post",
      path: "/sessions/{id}/extension-ui/{requestId}/response",
      tags: ["extensions"],
      summary: "Resolve a pending extension UI request.",
      request: {
        params: SessionIdParamSchema.merge(ExtensionUiRequestIdParamSchema),
        body: {
          required: true,
          content: { "application/json": { schema: ExtensionUiResponseRequestSchema } },
        },
      },
      responses: {
        200: {
          description: "Extension UI response accepted.",
          content: { "application/json": { schema: OkResponseSchema } },
        },
        404: {
          description: "Unknown session id or request id.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
      },
    }),
    async (c) => {
      const runtime = await getRuntime(c);
      const { id, requestId } = c.req.valid("param");
      const body = c.req.valid("json");
      const session = await runtime.getSession(id);
      if (!session) return c.json({ error: "session not found" }, 404);
      const ok = session.resolveExtensionUiRequest(requestId, body);
      if (!ok) return c.json({ error: "extension UI request not found" }, 404);
      return c.json({ ok: true } as const, 200);
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
      const runtime = await getRuntime(c);
      const { id } = c.req.valid("param");
      const { text } = c.req.valid("json");
      const session = await runtime.getSession(id);
      if (!session) return c.json({ error: "session not found" }, 404);
      // Fire-and-forget: events flow over SSE, errors surface there too.
      session.sendPrompt(text).catch((err) => {
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
      const runtime = await getRuntime(c);
      const { id } = c.req.valid("param");
      const session = await runtime.getSession(id);
      if (!session) return c.json({ error: "session not found" }, 404);
      try {
        await session.abort();
        return c.json({ ok: true } as const, 200);
      } catch (err) {
        return c.json({ error: String(err) }, 404);
      }
    },
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
    const runtime = await getRuntime(c);
    const id = c.req.param("id");
    const session = await runtime.getSession(id);
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
      for (const request of session.pendingExtensionUiRequests()) {
        await stream.writeSSE({ data: JSON.stringify(request) });
      }

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

/**
 * Build the Hono app exposing credential management routes. Versioning is
 * the caller's job (server.ts mounts this under /v1).
 */
export function createCredentialsApp(
  credentials: AgentCredentialsService | AgentCredentialsResolver,
  options: CreateCredentialsAppOptions = {},
): OpenAPIHono {
  const app = new OpenAPIHono();
  const healthRoute = options.healthRoute ?? true;
  const getCredentials = (c: Context) =>
    isCredentialsResolver(credentials) ? credentials(c) : credentials;

  // ── GET /sessions/models ────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/sessions/models",
      tags: ["models"],
      summary: "List models known to this runtime, including unavailable ones for diagnostics.",
      responses: {
        200: {
          description: "Known models.",
          content: {
            "application/json": { schema: ListModelsResponseSchema },
          },
        },
      },
    }),
    async (c) => {
      const credentials = await getCredentials(c);
      return c.json({ models: credentials.listModels() }, 200);
    },
  );

  // ── GET /auth/providers ─────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/auth/providers",
      tags: ["auth"],
      summary: "List non-secret provider auth status for the runtime.",
      responses: {
        200: {
          description: "Known providers and whether each has configured auth.",
          content: {
            "application/json": { schema: ListAuthProvidersResponseSchema },
          },
        },
      },
    }),
    async (c) => {
      const credentials = await getCredentials(c);
      return c.json({ providers: credentials.listAuthProviders() }, 200);
    },
  );

  // ── PUT /auth/providers/{provider}/api-key ──────────────────────
  app.openapi(
    createRoute({
      method: "put",
      path: "/auth/providers/{provider}/api-key",
      tags: ["auth"],
      summary: "Store an API key for a provider in Pi auth storage.",
      request: {
        params: ProviderParamSchema,
        body: {
          required: true,
          content: { "application/json": { schema: SetProviderApiKeyRequestSchema } },
        },
      },
      responses: {
        200: {
          description: "Credential stored.",
          content: { "application/json": { schema: OkResponseSchema } },
        },
        400: {
          description: "Invalid provider or key.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
      },
    }),
    async (c) => {
      const credentials = await getCredentials(c);
      const { provider } = c.req.valid("param");
      const { key } = c.req.valid("json");
      try {
        credentials.setProviderApiKey(provider, key);
        return c.json({ ok: true as const }, 200);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    },
  );

  // ── DELETE /auth/providers/{provider} ───────────────────────────
  app.openapi(
    createRoute({
      method: "delete",
      path: "/auth/providers/{provider}",
      tags: ["auth"],
      summary: "Remove a stored provider credential from Pi auth storage.",
      request: { params: ProviderParamSchema },
      responses: {
        200: {
          description: "Credential removed if it existed.",
          content: { "application/json": { schema: OkResponseSchema } },
        },
        400: {
          description: "Invalid provider.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
      },
    }),
    async (c) => {
      const credentials = await getCredentials(c);
      const { provider } = c.req.valid("param");
      try {
        credentials.removeProviderCredential(provider);
        return c.json({ ok: true as const }, 200);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    },
  );

  // ── POST /auth/providers/{provider}/subscription/start ──────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/auth/providers/{provider}/subscription/start",
      tags: ["auth"],
      summary: "Start a Pi subscription OAuth login flow.",
      request: { params: ProviderParamSchema },
      responses: {
        200: {
          description: "Current flow state. Continue if a prompt or pasted redirect is required.",
          content: { "application/json": { schema: OAuthFlowStateSchema } },
        },
        400: {
          description: "Provider does not support subscription auth.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
      },
    }),
    async (c) => {
      const credentials = await getCredentials(c);
      const { provider } = c.req.valid("param");
      try {
        return c.json(await credentials.startProviderSubscriptionLogin(provider), 200);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    },
  );

  // ── GET /auth/subscription/{flowId} ──────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/auth/subscription/{flowId}",
      tags: ["auth"],
      summary: "Return subscription login flow state.",
      request: { params: OAuthFlowIdParamSchema },
      responses: {
        200: {
          description: "Current flow state.",
          content: { "application/json": { schema: OAuthFlowStateSchema } },
        },
        404: {
          description: "Flow not found.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
      },
    }),
    async (c) => {
      const credentials = await getCredentials(c);
      const { flowId } = c.req.valid("param");
      const state = credentials.getProviderSubscriptionLogin(flowId);
      if (!state) return c.json({ error: "subscription auth flow not found" }, 404);
      return c.json(state, 200);
    },
  );

  // ── POST /auth/subscription/{flowId}/continue ────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/auth/subscription/{flowId}/continue",
      tags: ["auth"],
      summary: "Continue a subscription login flow with prompt input or pasted redirect URL.",
      request: {
        params: OAuthFlowIdParamSchema,
        body: {
          required: true,
          content: { "application/json": { schema: ContinueOAuthFlowRequestSchema } },
        },
      },
      responses: {
        200: {
          description: "Updated flow state.",
          content: { "application/json": { schema: OAuthFlowStateSchema } },
        },
        400: {
          description: "Invalid input.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
        404: {
          description: "Flow not found.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
      },
    }),
    async (c) => {
      const credentials = await getCredentials(c);
      const { flowId } = c.req.valid("param");
      const { value } = c.req.valid("json");
      try {
        return c.json(await credentials.continueProviderSubscriptionLogin(flowId, value), 200);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, message.includes("not found") ? 404 : 400);
      }
    },
  );

  // ── DELETE /auth/subscription/{flowId} ───────────────────────────
  app.openapi(
    createRoute({
      method: "delete",
      path: "/auth/subscription/{flowId}",
      tags: ["auth"],
      summary: "Cancel a pending subscription login flow.",
      request: { params: OAuthFlowIdParamSchema },
      responses: {
        200: {
          description: "Cancelled flow state.",
          content: { "application/json": { schema: OAuthFlowStateSchema } },
        },
        404: {
          description: "Flow not found.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
      },
    }),
    async (c) => {
      const credentials = await getCredentials(c);
      const { flowId } = c.req.valid("param");
      const state = credentials.cancelProviderSubscriptionLogin(flowId);
      if (!state) return c.json({ error: "subscription auth flow not found" }, 404);
      return c.json(state, 200);
    },
  );

  // ── GET /custom/providers ────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/custom/providers",
      tags: ["models"],
      summary: "List custom models.json providers without secret values.",
      responses: {
        200: {
          description: "Custom providers.",
          content: { "application/json": { schema: ListCustomProvidersResponseSchema } },
        },
      },
    }),
    async (c) => {
      const credentials = await getCredentials(c);
      return c.json({ providers: credentials.listCustomProviders() }, 200);
    },
  );

  // ── PUT /custom/providers ────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "put",
      path: "/custom/providers",
      tags: ["models"],
      summary: "Create or update a custom Pi provider in models.json.",
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: UpsertCustomProviderRequestSchema } },
        },
      },
      responses: {
        200: {
          description: "Custom provider saved.",
          content: { "application/json": { schema: CustomProviderRowSchema } },
        },
        400: {
          description: "Invalid custom provider config.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
      },
    }),
    async (c) => {
      const credentials = await getCredentials(c);
      try {
        return c.json(credentials.upsertCustomProvider(c.req.valid("json")), 200);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    },
  );

  // ── DELETE /custom/providers/{provider} ──────────────────────────
  app.openapi(
    createRoute({
      method: "delete",
      path: "/custom/providers/{provider}",
      tags: ["models"],
      summary: "Remove a custom Pi provider from models.json.",
      request: { params: ProviderParamSchema },
      responses: {
        200: {
          description: "Custom provider removed if it existed.",
          content: { "application/json": { schema: OkResponseSchema } },
        },
        400: {
          description: "Invalid provider.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
      },
    }),
    async (c) => {
      const credentials = await getCredentials(c);
      const { provider } = c.req.valid("param");
      try {
        credentials.removeCustomProvider(provider);
        return c.json({ ok: true as const }, 200);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    },
  );

  // ── GET /healthz ─────────────────────────────────────────────────
  if (healthRoute) app.openapi(
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

  return app;
}
