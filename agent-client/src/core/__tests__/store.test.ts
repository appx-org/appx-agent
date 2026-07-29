/**
 * Integration tests for `SessionStore` driven entirely through the SDK's
 * dependency-injection seams: a `FakeEventSource` (via `eventSourceFactory`) and
 * a mock `fetch`. No real network, no DOM — this is exactly the use case those
 * `AgentClientConfig` hooks exist for.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentClient } from "../client";
import { SessionStore } from "../store";
import { FakeEventSource, makeMockFetch, type RecordedRequest } from "./helpers";

const PROJECT = "proj";
const SESSION = "sess";
const EVENTS_PATH = "/v1/projects/proj/sessions/sess/events";

/** Resolve queued microtasks/promises (mock fetch resolves asynchronously). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function defaultRoutes(): Parameters<typeof makeMockFetch>[0] {
  return {
    "GET /v1/projects/proj/sessions/sess": () => ({ body: { id: SESSION, messages: [] } }),
    "GET /v1/projects/proj/sessions/sess/extension-ui": () => ({ body: { requests: [] } }),
    "GET /v1/projects/proj/sessions/sess/settings": () => ({
      body: {
        isStreaming: false,
        model: null,
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        supportsThinking: false,
      },
    }),
    "POST /v1/projects/proj/sessions/sess/prompt": () => ({ body: { ok: true } }),
    "POST /v1/projects/proj/sessions/sess/abort": () => ({ body: { ok: true } }),
    "DELETE /v1/projects/proj/sessions/sess": () => ({ body: { ok: true } }),
  };
}

let store: SessionStore;
let requests: RecordedRequest[];

function makeStore(routes = defaultRoutes()): SessionStore {
  const mock = makeMockFetch(routes);
  requests = mock.requests;
  const client = new AgentClient({
    baseUrl: "http://localhost",
    fetch: mock.fetch,
    eventSourceFactory: (url) => new FakeEventSource(url),
  });
  return new SessionStore(client);
}

beforeEach(() => {
  FakeEventSource.reset();
  store = makeStore();
});

afterEach(() => {
  // Clears the recovery-poll interval and closes the fake stream.
  store.detach(PROJECT, SESSION);
});

describe("SessionStore — connection lifecycle", () => {
  it("opens exactly one EventSource via the injected factory, at the events URL", async () => {
    store.attach(PROJECT, SESSION);
    await tick();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.last().url).toContain(EVENTS_PATH);
  });

  it("reuses a single stream across repeated attach calls", async () => {
    store.attach(PROJECT, SESSION);
    store.attach(PROJECT, SESSION);
    await tick();

    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("tracks connected state from onopen/onerror", () => {
    store.attach(PROJECT, SESSION);
    const stream = FakeEventSource.last();

    stream.open();
    expect(store.getSnapshot(PROJECT, SESSION).connected).toBe(true);

    stream.error();
    expect(store.getSnapshot(PROJECT, SESSION).connected).toBe(false);
  });

  it("closes the stream when the last subscriber unsubscribes", () => {
    store.attach(PROJECT, SESSION);
    const stream = FakeEventSource.last();
    const unsubscribe = store.subscribe(PROJECT, SESSION, () => {});

    unsubscribe();
    expect(stream.closed).toBe(true);
  });
});

describe("SessionStore — SSE events drive the reducer", () => {
  it("applies streamed wire events to the snapshot", async () => {
    store.attach(PROJECT, SESSION);
    await tick();
    const stream = FakeEventSource.last();

    stream.send({
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: "t0" },
    });
    stream.send({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Hi",
        partial: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      },
    });

    const snapshot = store.getSnapshot(PROJECT, SESSION);
    expect(snapshot.status).toBe("streaming");
    expect(snapshot.messages[0]!.parts[0]).toMatchObject({ type: "text", text: "Hi" });
  });

  it("notifies subscribers when state changes", async () => {
    store.attach(PROJECT, SESSION);
    await tick();
    let notifications = 0;
    store.subscribe(PROJECT, SESSION, () => {
      notifications += 1;
    });

    FakeEventSource.last().send({
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: "t0" },
    });

    expect(notifications).toBeGreaterThan(0);
  });

  it("ignores non-JSON keepalive lines", async () => {
    store.attach(PROJECT, SESSION);
    await tick();
    const stream = FakeEventSource.last();

    stream.send("connected to sess");
    stream.send("heartbeat");

    expect(store.getSnapshot(PROJECT, SESSION).messages).toHaveLength(0);
  });
});

describe("SessionStore — deleteSession", () => {
  it("DELETEs the session and tears down the live stream", async () => {
    store.attach(PROJECT, SESSION);
    await tick();
    const stream = FakeEventSource.last();

    await store.deleteSession(PROJECT, SESSION);

    const del = requests.find((request) => request.method === "DELETE");
    expect(del).toBeDefined();
    expect(del!.path).toBe("/v1/projects/proj/sessions/sess");
    // Detach runs after the call: the stream is closed and state is reset.
    expect(stream.closed).toBe(true);
    expect(store.getSnapshot(PROJECT, SESSION).messages).toHaveLength(0);
  });

  it("still tears down the stream when the server delete fails", async () => {
    store = makeStore({
      ...defaultRoutes(),
      "DELETE /v1/projects/proj/sessions/sess": () => ({
        status: 500,
        body: { error: "boom" },
      }),
    });
    store.attach(PROJECT, SESSION);
    await tick();
    const stream = FakeEventSource.last();

    await expect(store.deleteSession(PROJECT, SESSION)).rejects.toThrow();
    expect(stream.closed).toBe(true);
  });
});

describe("SessionStore — sendPrompt", () => {
  it("adds an optimistic user bubble and POSTs the prompt", async () => {
    await store.sendPrompt(PROJECT, SESSION, "hallo");

    const snapshot = store.getSnapshot(PROJECT, SESSION);
    expect(snapshot.messages.some((m) => m.role === "user")).toBe(true);

    const promptPost = requests.find(
      (request) => request.method === "POST" && request.path.endsWith("/prompt"),
    );
    expect(promptPost).toBeDefined();
    expect((promptPost!.body as { text?: string }).text).toBe("hallo");
  });

  it("surfaces a send failure as an error and ends the turn", async () => {
    store = makeStore({
      ...defaultRoutes(),
      "POST /v1/projects/proj/sessions/sess/prompt": () => ({
        status: 500,
        body: { error: "boom" },
      }),
    });

    await expect(store.sendPrompt(PROJECT, SESSION, "x")).rejects.toThrow();

    const snapshot = store.getSnapshot(PROJECT, SESSION);
    expect(snapshot.error).toBeTruthy();
    expect(snapshot.status).toBe("idle");
  });
});

describe("SessionStore — abort", () => {
  const countMessageGets = () =>
    requests.filter(
      (request) => request.method === "GET" && request.path === "/v1/projects/proj/sessions/sess",
    ).length;

  it("relies on the SSE agent_end and does not refetch history while connected", async () => {
    store.attach(PROJECT, SESSION);
    await tick();
    const stream = FakeEventSource.last();
    stream.open(); // mark the stream connected
    const before = countMessageGets();

    await store.abort(PROJECT, SESSION);
    await tick();

    // Abort was POSTed, but no extra history GET was issued (the stream's
    // agent_end settles the state instead).
    expect(requests.some((r) => r.method === "POST" && r.path.endsWith("/abort"))).toBe(true);
    expect(countMessageGets()).toBe(before);
  });

  it("falls back to a history reload when the stream is disconnected", async () => {
    store.attach(PROJECT, SESSION);
    await tick();
    // Stream never opened -> entry.state.connected stays false.
    const before = countMessageGets();

    await store.abort(PROJECT, SESSION);
    await tick();

    expect(countMessageGets()).toBe(before + 1);
  });
});

describe("SessionStore — model settings", () => {
  const modelsRoute = {
    "GET /v1/sessions/models": () => ({
      body: {
        models: [
          {
            provider: "openai",
            id: "gpt-5",
            name: "GPT-5",
            api: "responses",
            reasoning: true,
            available: true,
            input: ["text"],
            contextWindow: 200000,
            maxTokens: 64000,
          },
        ],
      },
    }),
  };

  it("loads models + settings once into shared state and skips redundant fetches", async () => {
    store = makeStore({ ...defaultRoutes(), ...modelsRoute });
    await store.loadModelSettings(PROJECT, SESSION);

    const snapshot = store.getSnapshot(PROJECT, SESSION);
    expect(snapshot.models).toHaveLength(1);
    expect(snapshot.modelSettings).not.toBeNull();
    expect(snapshot.modelSettingsError).toBeNull();

    const settingsGets = () =>
      requests.filter((r) => r.method === "GET" && r.path.endsWith("/settings")).length;
    const after = settingsGets();
    // A second call is a no-op once settings are present (no extra round-trip).
    await store.loadModelSettings(PROJECT, SESSION);
    expect(settingsGets()).toBe(after);
  });

  it("updates settings through the store and reflects the result", async () => {
    store = makeStore({
      ...defaultRoutes(),
      ...modelsRoute,
      "PATCH /v1/projects/proj/sessions/sess/settings": () => ({
        body: {
          isStreaming: false,
          model: null,
          thinkingLevel: "high",
          availableThinkingLevels: ["off", "high"],
          supportsThinking: true,
        },
      }),
    });

    await store.updateModelSettings(PROJECT, SESSION, { thinkingLevel: "high" });

    const snapshot = store.getSnapshot(PROJECT, SESSION);
    expect(snapshot.modelSettings?.thinkingLevel).toBe("high");
    expect(snapshot.modelSettingsBusy).toBe(false);
  });

  it("records a model-settings error without throwing", async () => {
    store = makeStore({
      ...defaultRoutes(),
      "GET /v1/sessions/models": () => ({ status: 500, body: { error: "boom" } }),
      "GET /v1/projects/proj/sessions/sess/settings": () => ({
        status: 500,
        body: { error: "boom" },
      }),
    });

    await store.loadModelSettings(PROJECT, SESSION);
    expect(store.getSnapshot(PROJECT, SESSION).modelSettingsError).toBeTruthy();
  });
});
