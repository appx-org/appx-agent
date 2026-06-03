/**
 * HTTP routes for credentials, models, and provider auth — a Hono OpenAPIHono
 * app exposing the org-shared AgentCredentialsService.
 *
 * Surface (mounted by the server under /v1):
 *   GET    /sessions/models         list selectable models
 *   GET    /auth/providers          list provider auth status without secrets
 *   PUT    /auth/providers/{provider}/api-key   store a provider API key
 *   DELETE /auth/providers/{provider}           remove a stored credential
 *   POST   /auth/providers/{provider}/subscription/start
 *                                   start a Pi subscription OAuth flow
 *   GET    /auth/subscription/{flowId}          read OAuth flow state
 *   POST   /auth/subscription/{flowId}/continue continue OAuth input
 *   DELETE /auth/subscription/{flowId}          cancel a pending flow
 *   GET    /custom/providers        list custom models.json providers
 *   PUT    /custom/providers        create/update a custom provider
 *   DELETE /custom/providers/{provider}         remove a custom provider
 *   GET    /healthz                 liveness + channel stats  // FIXME: Do we need healthz here?
 *
 * Session routes live in sessionsRoutes.ts; project-lifecycle routes in
 * projectsRoutes.ts.
 */
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AgentCredentialsService } from "../credentials/credentialsService.js";
import {
  ContinueOAuthFlowRequestSchema,
  CustomProviderRowSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  ListCustomProvidersResponseSchema,
  ListAuthProvidersResponseSchema,
  ListModelsResponseSchema,
  OAuthFlowIdParamSchema,
  OAuthFlowStateSchema,
  OkResponseSchema,
  ProviderParamSchema,
  SetProviderApiKeyRequestSchema,
  UpsertCustomProviderRequestSchema,
} from "./schemas.js";
import { channelStats } from "./sseBroker.js";

export type AgentCredentialsResolver = (
  c: Context,
) => AgentCredentialsService | Promise<AgentCredentialsService>;
export type CreateCredentialsAppOptions = {
  /** Liveness endpoint for this mounted API. Default true. */
  healthRoute?: boolean;
};

function isCredentialsResolver(
  credentials: AgentCredentialsService | AgentCredentialsResolver,
): credentials is AgentCredentialsResolver {
  return typeof credentials === "function";
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
      summary:
        "List models known to this runtime, including unavailable ones for diagnostics.",
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
          content: {
            "application/json": { schema: SetProviderApiKeyRequestSchema },
          },
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
        return c.json(
          { error: err instanceof Error ? err.message : String(err) },
          400,
        );
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
        return c.json(
          { error: err instanceof Error ? err.message : String(err) },
          400,
        );
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
          description:
            "Current flow state. Continue if a prompt or pasted redirect is required.",
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
        return c.json(
          await credentials.startProviderSubscriptionLogin(provider),
          200,
        );
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : String(err) },
          400,
        );
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
      if (!state)
        return c.json({ error: "subscription auth flow not found" }, 404);
      return c.json(state, 200);
    },
  );

  // ── POST /auth/subscription/{flowId}/continue ────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/auth/subscription/{flowId}/continue",
      tags: ["auth"],
      summary:
        "Continue a subscription login flow with prompt input or pasted redirect URL.",
      request: {
        params: OAuthFlowIdParamSchema,
        body: {
          required: true,
          content: {
            "application/json": { schema: ContinueOAuthFlowRequestSchema },
          },
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
        return c.json(
          await credentials.continueProviderSubscriptionLogin(flowId, value),
          200,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json(
          { error: message },
          message.includes("not found") ? 404 : 400,
        );
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
      if (!state)
        return c.json({ error: "subscription auth flow not found" }, 404);
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
          content: {
            "application/json": { schema: ListCustomProvidersResponseSchema },
          },
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
          content: {
            "application/json": { schema: UpsertCustomProviderRequestSchema },
          },
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
        return c.json(
          credentials.upsertCustomProvider(c.req.valid("json")),
          200,
        );
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : String(err) },
          400,
        );
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
        return c.json(
          { error: err instanceof Error ? err.message : String(err) },
          400,
        );
      }
    },
  );

  // ── GET /healthz ─────────────────────────────────────────────────
  if (healthRoute)
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

  return app;
}
