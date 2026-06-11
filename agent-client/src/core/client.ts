/**
 * Transport client for the agent-server `/v1` contract.
 *
 * The REST surface is backed by `openapi-fetch`, which is typed directly against
 * the generated `paths` (from `agent-server.generated.ts`). That means request
 * bodies, path params, and **response types are inferred from the contract** —
 * there are no hand-written return-type annotations that could silently drift
 * from agent-server. If a response shape changes in the OpenAPI spec, the
 * affected method stops compiling. The SSE stream is not part of `openapi-fetch`
 * (it's a long-lived `text/event-stream`), so it keeps a native `EventSource`
 * with the published `WireEvent` type applied by the store/reducer.
 *
 * The client is intentionally configuration-driven so the same package works
 * against agent-server directly (`baseUrl: 'http://127.0.0.1:4001'`) or behind
 * a same-origin reverse proxy that mirrors the `/v1` layout
 * (`baseUrl: '/agent'`). Auth headers are injected per request; SSE uses a
 * same-origin native `EventSource` by default (no custom headers needed when a
 * proxy injects credentials server-side), but an `eventSourceFactory` override
 * is available for advanced setups.
 */
import createClient, { type Client } from "openapi-fetch";
import type { paths } from "./agent-server.generated";
import type {
  AgentModel,
  AgentProject,
  AgentSessionInfo,
  AgentSessionModelSettings,
  AgentMessage,
  AgentAuthProvider,
  AgentOAuthFlowState,
  AgentCustomProvider,
  UpsertCustomProviderRequest,
  ExtensionUiRequest,
  ExtensionUiResponse,
  ThinkingLevel,
} from "./types";

/** The contract prefix baked into the generated `paths` keys (`/v1/...`). */
const CONTRACT_PREFIX = "/v1";

/** Minimal structural type so callers may inject a polyfilled EventSource. */
export interface EventSourceLike {
  onopen: ((this: unknown, ev: Event) => unknown) | null;
  onerror: ((this: unknown, ev: Event) => unknown) | null;
  onmessage: ((this: unknown, ev: MessageEvent) => unknown) | null;
  close: () => void;
}

export interface AgentClientConfig {
  /** Origin (and optional path) the API is mounted at. Default: '' (same origin). */
  baseUrl?: string;
  /**
   * Path prefix for the contract. Default: '/v1' (agent-server native layout).
   * The generated `paths` are keyed under `/v1`; if a deployment mounts the
   * contract under a different prefix, set this and the client rewrites the
   * leading `/v1` of each request URL accordingly.
   */
  pathPrefix?: string;
  /** Static headers or a (possibly async) provider invoked per request. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /** Custom fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch;
  /** Factory for the SSE connection (defaults to native EventSource). */
  eventSourceFactory?: (url: string) => EventSourceLike;
  /** Invoked on a 401 response (e.g. to redirect to a login page). */
  onUnauthorized?: () => void;
}

/** The shape every `openapi-fetch` operation resolves to. */
type ApiResult<TData> = { data?: TData; error?: unknown; response: Response };

function extractErrorMessage(body: unknown, fallback: string): string {
  if (!body) return fallback;
  if (typeof body === "string") return body || fallback;
  if (typeof body === "object") {
    const record = body as Record<string, unknown>;
    const message = record.error ?? record.message;
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(body);
    } catch {
      return fallback;
    }
  }
  return String(body);
}

/** A typed client over the agent-server REST + SSE surface. */
export class AgentClient {
  private readonly baseUrl: string;
  private readonly pathPrefix: string;
  private readonly http: Client<paths>;
  private readonly eventSourceFactory: (url: string) => EventSourceLike;
  private readonly onUnauthorized?: () => void;

  constructor(config: AgentClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? "").replace(/\/$/, "");
    this.pathPrefix = config.pathPrefix ?? CONTRACT_PREFIX;
    this.onUnauthorized = config.onUnauthorized;
    this.eventSourceFactory =
      config.eventSourceFactory ?? ((url) => new EventSource(url) as unknown as EventSourceLike);

    this.http = createClient<paths>({
      baseUrl: this.baseUrl,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });

    // Per-request header injection (supports static, sync, or async providers).
    const headers = config.headers;
    if (headers) {
      this.http.use({
        async onRequest({ request }) {
          const resolved = typeof headers === "function" ? await headers() : headers;
          new Headers(resolved).forEach((value, key) => request.headers.set(key, value));
          return request;
        },
      });
    }

    // Honor a non-default mount prefix by rewriting the contract's `/v1` segment.
    if (this.pathPrefix !== CONTRACT_PREFIX) {
      const prefix = this.pathPrefix;
      this.http.use({
        onRequest({ request }) {
          return new Request(request.url.replace(CONTRACT_PREFIX, prefix), request);
        },
      });
    }
  }

  /** Builds an absolute URL from a contract-relative path (already including the prefix). */
  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /**
   * Normalize an `openapi-fetch` result into the success payload, mirroring the
   * previous client's throwing behavior: 401 invokes `onUnauthorized` and
   * throws, other non-2xx responses throw the server's error message, and
   * 202/204 resolve to `undefined`.
   */
  private unwrap<TData>(result: ApiResult<TData>): TData {
    const { data, error, response } = result;
    if (response.ok) {
      if (response.status === 204 || response.status === 202) return undefined as TData;
      return data as TData;
    }
    if (response.status === 401) {
      this.onUnauthorized?.();
      throw new Error("Unauthorized");
    }
    throw new Error(extractErrorMessage(error, `${response.status} ${response.statusText}`));
  }

  // --- Projects -----------------------------------------------------------

  async listProjects(): Promise<{ projects: AgentProject[] }> {
    return this.unwrap(await this.http.GET("/v1/projects"));
  }

  /** Create-or-get a project; idempotent on name. */
  async createProject(name: string): Promise<AgentProject> {
    return this.unwrap(await this.http.POST("/v1/projects", { body: { name } }));
  }

  // --- Models -------------------------------------------------------------

  async listModels(): Promise<{ models: AgentModel[] }> {
    return this.unwrap(await this.http.GET("/v1/sessions/models"));
  }

  // --- Provider auth ------------------------------------------------------

  /** Lists provider auth status (no secret values are returned). */
  async listAuthProviders(): Promise<{ providers: AgentAuthProvider[] }> {
    return this.unwrap(await this.http.GET("/v1/auth/providers"));
  }

  /** Stores an API key for a provider in the runtime's auth storage. */
  async setProviderApiKey(provider: string, key: string): Promise<{ ok: true }> {
    return this.unwrap(
      await this.http.PUT("/v1/auth/providers/{provider}/api-key", {
        params: { path: { provider } },
        body: { key },
      }),
    );
  }

  /** Removes a stored provider credential from the runtime's auth storage. */
  async deleteProviderCredential(provider: string): Promise<{ ok: true }> {
    return this.unwrap(
      await this.http.DELETE("/v1/auth/providers/{provider}", {
        params: { path: { provider } },
      }),
    );
  }

  /** Starts a subscription (OAuth) login flow for a provider. */
  async startProviderSubscription(provider: string): Promise<AgentOAuthFlowState> {
    return this.unwrap(
      await this.http.POST("/v1/auth/providers/{provider}/subscription/start", {
        params: { path: { provider } },
      }),
    );
  }

  /** Reads the current state of a pending subscription login flow. */
  async getSubscriptionFlow(flowId: string): Promise<AgentOAuthFlowState> {
    return this.unwrap(
      await this.http.GET("/v1/auth/subscription/{flowId}", {
        params: { path: { flowId } },
      }),
    );
  }

  /** Continues a pending subscription flow with prompt input or a pasted redirect/code. */
  async continueSubscriptionFlow(flowId: string, value: string): Promise<AgentOAuthFlowState> {
    return this.unwrap(
      await this.http.POST("/v1/auth/subscription/{flowId}/continue", {
        params: { path: { flowId } },
        body: { value },
      }),
    );
  }

  /** Cancels a pending subscription login flow. */
  async cancelSubscriptionFlow(flowId: string): Promise<AgentOAuthFlowState> {
    return this.unwrap(
      await this.http.DELETE("/v1/auth/subscription/{flowId}", {
        params: { path: { flowId } },
      }),
    );
  }

  // --- Custom providers ---------------------------------------------------

  /** Lists custom (models.json) providers without secret values. */
  async listCustomProviders(): Promise<{ providers: AgentCustomProvider[] }> {
    return this.unwrap(await this.http.GET("/v1/custom/providers"));
  }

  /** Creates or updates a custom provider (e.g. a LiteLLM-compatible endpoint). */
  async upsertCustomProvider(body: UpsertCustomProviderRequest): Promise<AgentCustomProvider> {
    return this.unwrap(await this.http.PUT("/v1/custom/providers", { body }));
  }

  /** Removes a custom provider from models.json. */
  async deleteCustomProvider(provider: string): Promise<{ ok: true }> {
    return this.unwrap(
      await this.http.DELETE("/v1/custom/providers/{provider}", {
        params: { path: { provider } },
      }),
    );
  }

  // --- Sessions -----------------------------------------------------------

  async listSessions(projectId: string): Promise<{ sessions: AgentSessionInfo[] }> {
    return this.unwrap(
      await this.http.GET("/v1/projects/{projectId}/sessions", {
        params: { path: { projectId } },
      }),
    );
  }

  async createSession(projectId: string): Promise<{ id: string; createdAt: string }> {
    return this.unwrap(
      await this.http.POST("/v1/projects/{projectId}/sessions", {
        params: { path: { projectId } },
      }),
    );
  }

  /** Permanently delete a session and its persisted history. */
  async deleteSession(projectId: string, sessionId: string): Promise<{ ok: true }> {
    return this.unwrap(
      await this.http.DELETE("/v1/projects/{projectId}/sessions/{id}", {
        params: { path: { projectId, id: sessionId } },
      }),
    );
  }

  async getSessionMessages(
    projectId: string,
    sessionId: string,
  ): Promise<{ id: string; messages: AgentMessage[] }> {
    return this.unwrap(
      await this.http.GET("/v1/projects/{projectId}/sessions/{id}", {
        params: { path: { projectId, id: sessionId } },
      }),
    );
  }

  async getSessionSettings(
    projectId: string,
    sessionId: string,
  ): Promise<AgentSessionModelSettings> {
    return this.unwrap(
      await this.http.GET("/v1/projects/{projectId}/sessions/{id}/settings", {
        params: { path: { projectId, id: sessionId } },
      }),
    );
  }

  async updateSessionSettings(
    projectId: string,
    sessionId: string,
    body: {
      provider?: string;
      modelId?: string;
      thinkingLevel?: ThinkingLevel;
    },
  ): Promise<AgentSessionModelSettings> {
    return this.unwrap(
      await this.http.PATCH("/v1/projects/{projectId}/sessions/{id}/settings", {
        params: { path: { projectId, id: sessionId } },
        body,
      }),
    );
  }

  async sendPrompt(projectId: string, sessionId: string, text: string): Promise<{ ok: true }> {
    return this.unwrap(
      await this.http.POST("/v1/projects/{projectId}/sessions/{id}/prompt", {
        params: { path: { projectId, id: sessionId } },
        body: { text },
      }),
    );
  }

  async abortSession(projectId: string, sessionId: string): Promise<{ ok: true }> {
    return this.unwrap(
      await this.http.POST("/v1/projects/{projectId}/sessions/{id}/abort", {
        params: { path: { projectId, id: sessionId } },
      }),
    );
  }

  async listExtensionUiRequests(
    projectId: string,
    sessionId: string,
  ): Promise<{ requests: ExtensionUiRequest[] }> {
    return this.unwrap(
      await this.http.GET("/v1/projects/{projectId}/sessions/{id}/extension-ui", {
        params: { path: { projectId, id: sessionId } },
      }),
    );
  }

  async respondExtensionUiRequest(
    projectId: string,
    sessionId: string,
    requestId: string,
    body: ExtensionUiResponse,
  ): Promise<{ ok: true }> {
    return this.unwrap(
      await this.http.POST(
        "/v1/projects/{projectId}/sessions/{id}/extension-ui/{requestId}/response",
        {
          params: { path: { projectId, id: sessionId, requestId } },
          body,
        },
      ),
    );
  }

  /** Opens an SSE stream of `AgentEvent`s for a session. */
  openEvents(projectId: string, sessionId: string): EventSourceLike {
    return this.eventSourceFactory(this.url(this.sessionEventsPath(projectId, sessionId)));
  }

  /** Builds the prefixed SSE events path (the one route not served by openapi-fetch). */
  private sessionEventsPath(projectId: string, sessionId: string): string {
    return `${this.pathPrefix}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(
      sessionId,
    )}/events`;
  }
}

/** Convenience factory mirroring the `AgentClient` constructor. */
export function createAgentClient(config?: AgentClientConfig): AgentClient {
  return new AgentClient(config);
}
