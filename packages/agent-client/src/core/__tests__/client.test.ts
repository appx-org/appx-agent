/**
 * Tests for `AgentClient`: the typed REST surface (via the injected `fetch`) plus
 * the SSE seam (`openEvents` via `eventSourceFactory`), and the `unwrap` policy
 * that turns HTTP outcomes into resolved values / thrown errors.
 */
import { describe, it, expect, vi } from "vitest";
import { AgentClient } from "../client";
import { FakeEventSource, makeMockFetch } from "./helpers";

function client(
  routes: Parameters<typeof makeMockFetch>[0],
  extra: Partial<ConstructorParameters<typeof AgentClient>[0]> = {},
) {
  const mock = makeMockFetch(routes);
  const instance = new AgentClient({
    baseUrl: "http://localhost",
    fetch: mock.fetch,
    eventSourceFactory: (url) => new FakeEventSource(url),
    ...extra,
  });
  return { instance, requests: mock.requests };
}

describe("AgentClient — REST requests", () => {
  it("builds the contract URL and returns the parsed body", async () => {
    const { instance, requests } = client({
      "GET /v1/projects": () => ({ body: { projects: [{ id: "p1", name: "Game" }] } }),
    });

    const result = await instance.listProjects();

    expect(result.projects[0]!.name).toBe("Game");
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.path).toBe("/v1/projects");
  });

  it("sends a JSON body on POST", async () => {
    const { instance, requests } = client({
      "POST /v1/projects/p1/sessions/s1/prompt": () => ({ body: { ok: true } }),
    });

    await instance.sendPrompt("p1", "s1", "hallo");

    const post = requests[0]!;
    expect(post.method).toBe("POST");
    expect((post.body as { text?: string }).text).toBe("hallo");
  });

  it("sends a DELETE for deleteSession", async () => {
    const { instance, requests } = client({
      "DELETE /v1/projects/p1/sessions/s1": () => ({ body: { ok: true } }),
    });

    await instance.deleteSession("p1", "s1");

    expect(requests[0]!.method).toBe("DELETE");
    expect(requests[0]!.path).toBe("/v1/projects/p1/sessions/s1");
  });

  it("rewrites the /v1 prefix when a custom pathPrefix is configured", async () => {
    const { instance, requests } = client(
      { "GET /api/projects": () => ({ body: { projects: [] } }) },
      { pathPrefix: "/api" },
    );

    await instance.listProjects();

    expect(requests[0]!.path).toBe("/api/projects");
  });

  it("injects configured headers per request", async () => {
    const { instance, requests } = client(
      { "GET /v1/projects": () => ({ body: { projects: [] } }) },
      { headers: { authorization: "Bearer test-token" } },
    );

    await instance.listProjects();

    expect(requests[0]!.headers.get("authorization")).toBe("Bearer test-token");
  });
});

describe("AgentClient — provider auth + custom providers", () => {
  it("lists provider auth status", async () => {
    const { instance, requests } = client({
      "GET /v1/auth/providers": () => ({
        body: { providers: [{ provider: "anthropic", configured: true }] },
      }),
    });

    const result = await instance.listAuthProviders();

    expect(result.providers[0]!.provider).toBe("anthropic");
    expect(requests[0]!.path).toBe("/v1/auth/providers");
  });

  it("PUTs an API key for a provider", async () => {
    const { instance, requests } = client({
      "PUT /v1/auth/providers/anthropic/api-key": () => ({ body: { ok: true } }),
    });

    await instance.setProviderApiKey("anthropic", "sk-123");

    expect(requests[0]!.method).toBe("PUT");
    expect((requests[0]!.body as { key?: string }).key).toBe("sk-123");
  });

  it("URL-encodes the provider id in credential routes", async () => {
    const { instance, requests } = client({
      "DELETE /v1/auth/providers/openai%2Fcodex": () => ({ body: { ok: true } }),
    });

    await instance.deleteProviderCredential("openai/codex");

    expect(requests[0]!.method).toBe("DELETE");
    expect(requests[0]!.path).toBe("/v1/auth/providers/openai%2Fcodex");
  });

  it("starts, continues, and cancels a subscription flow", async () => {
    const { instance, requests } = client({
      "POST /v1/auth/providers/anthropic/subscription/start": () => ({
        body: { id: "flow-1", provider: "anthropic", providerName: "Anthropic", status: "auth", progress: [], expiresAt: "x" },
      }),
      "POST /v1/auth/subscription/flow-1/continue": () => ({
        body: { id: "flow-1", provider: "anthropic", providerName: "Anthropic", status: "complete", progress: [], expiresAt: "x" },
      }),
      "DELETE /v1/auth/subscription/flow-1": () => ({
        body: { id: "flow-1", provider: "anthropic", providerName: "Anthropic", status: "cancelled", progress: [], expiresAt: "x" },
      }),
    });

    const started = await instance.startProviderSubscription("anthropic");
    expect(started.id).toBe("flow-1");

    const continued = await instance.continueSubscriptionFlow("flow-1", "code-abc");
    expect(continued.status).toBe("complete");
    expect((requests[1]!.body as { value?: string }).value).toBe("code-abc");

    const cancelled = await instance.cancelSubscriptionFlow("flow-1");
    expect(cancelled.status).toBe("cancelled");
  });

  it("upserts and deletes custom providers", async () => {
    const { instance, requests } = client({
      "PUT /v1/custom/providers": () => ({
        body: { provider: "litellm", apiKeyConfigured: true, modelCount: 1, models: [] },
      }),
      "DELETE /v1/custom/providers/litellm": () => ({ body: { ok: true } }),
    });

    const saved = await instance.upsertCustomProvider({
      provider: "litellm",
      baseUrl: "http://127.0.0.1:4000/v1",
      api: "openai-responses",
      models: [{ id: "openai/gpt-5.5" }],
    });
    expect(saved.provider).toBe("litellm");
    expect(requests[0]!.method).toBe("PUT");

    await instance.deleteCustomProvider("litellm");
    expect(requests[1]!.method).toBe("DELETE");
    expect(requests[1]!.path).toBe("/v1/custom/providers/litellm");
  });
});

describe("AgentClient — unwrap policy", () => {
  it("throws the server error message on non-2xx", async () => {
    const { instance } = client({
      "GET /v1/projects": () => ({ status: 500, body: { error: "kaboom" } }),
    });

    await expect(instance.listProjects()).rejects.toThrow("kaboom");
  });

  it("invokes onUnauthorized and throws on 401", async () => {
    const onUnauthorized = vi.fn();
    const { instance } = client(
      { "GET /v1/projects": () => ({ status: 401, body: { error: "nope" } }) },
      { onUnauthorized },
    );

    await expect(instance.listProjects()).rejects.toThrow("Unauthorized");
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("resolves to undefined on 202/204 (no content)", async () => {
    const { instance } = client({
      "POST /v1/projects/p1/sessions/s1/abort": () => ({ status: 202 }),
    });

    await expect(instance.abortSession("p1", "s1")).resolves.toBeUndefined();
  });
});

describe("AgentClient — SSE seam", () => {
  it("opens the events stream through the injected factory at the right URL", () => {
    const { instance } = client({});

    const stream = instance.openEvents("p1", "s1") as FakeEventSource;

    expect(stream).toBeInstanceOf(FakeEventSource);
    expect(stream.url).toBe("http://localhost/v1/projects/p1/sessions/s1/events");
  });

  it("URL-encodes ids in the events path", () => {
    const { instance } = client({});

    const stream = instance.openEvents("p/1", "s 1") as FakeEventSource;

    expect(stream.url).toContain("/projects/p%2F1/sessions/s%201/events");
  });
});
