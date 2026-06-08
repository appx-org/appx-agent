/**
 * Shared test doubles for the transport seams `AgentClientConfig` exposes.
 *
 * These exist precisely because the SDK is dependency-injectable: `FakeEventSource`
 * is supplied via `eventSourceFactory` and `makeMockFetch` via `fetch`, letting us
 * exercise the full client → store → reducer loop with zero network.
 */
import type { EventSourceLike } from "../client";

/**
 * A controllable `EventSource` test double. Implements the minimal
 * `EventSourceLike` contract and records every instance so tests can assert how
 * many streams were opened and drive events into them.
 */
export class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];

  onopen: ((this: unknown, ev: Event) => unknown) | null = null;
  onerror: ((this: unknown, ev: Event) => unknown) | null = null;
  onmessage: ((this: unknown, ev: MessageEvent) => unknown) | null = null;
  closed = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  /** Most recently constructed instance — the one a single-session test just opened. */
  static last(): FakeEventSource {
    const instance = FakeEventSource.instances.at(-1);
    if (!instance) throw new Error("no FakeEventSource has been opened");
    return instance;
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }

  /** Simulate the stream connecting. */
  open(): void {
    this.onopen?.call(this, {} as Event);
  }

  /** Simulate the stream erroring/dropping. */
  error(): void {
    this.onerror?.call(this, {} as Event);
  }

  /** Push one SSE `data:` line. Objects are JSON-encoded like the real wire. */
  send(data: unknown): void {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    this.onmessage?.call(this, { data: payload } as MessageEvent);
  }
}

type RouteHandler = (request: Request, url: URL) => {
  status?: number;
  body?: unknown;
};

/** A recorded request, exposed so tests can assert method/path/body. */
export interface RecordedRequest {
  method: string;
  path: string;
  url: string;
  body: unknown;
  headers: Headers;
}

export interface MockFetch {
  fetch: typeof fetch;
  requests: RecordedRequest[];
}

/**
 * Build a `fetch` double that routes by `"METHOD /path"` keys and records every
 * request. Unmatched routes resolve to 404 so a missing stub fails loudly.
 */
export function makeMockFetch(
  routes: Record<string, RouteHandler>,
): MockFetch {
  const requests: RecordedRequest[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const rawBody = await request
      .clone()
      .text()
      .catch(() => "");
    const body = rawBody ? safeJsonParse(rawBody) : undefined;
    requests.push({
      method: request.method,
      path: url.pathname,
      url: request.url,
      body,
      headers: request.headers,
    });

    const handler =
      routes[`${request.method} ${url.pathname}`] ?? routes[url.pathname];
    if (!handler) {
      return jsonResponse({ error: `no route for ${request.method} ${url.pathname}` }, 404);
    }
    const { status = 200, body: responseBody } = handler(request, url);
    return jsonResponse(responseBody, status);
  }) as typeof fetch;

  return { fetch: fetchImpl, requests };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function jsonResponse(body: unknown, status: number): Response {
  if (status === 204 || status === 202) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body ?? null), {
    status,
    headers: { "content-type": "application/json" },
  });
}
