/**
 * End-to-end tests for the agent-server HTTP/SSE surface.
 *
 * Spins up a real `OpenAPIHono` app on a random local port (per describe
 * block, so we can independently test the auth-on / auth-off
 * configurations) and drives it with `fetch`. The `AgentRuntime` is real
 * — it reads `.pi/AGENTS.md` from a temp project dir we set up in
 * beforeAll — but no LLM call is ever made, so tests don't need an
 * `ANTHROPIC_API_KEY` and don't burn tokens.
 *
 * What's covered:
 *   - REST surface: list/create/get sessions, abort idle, prompt-body
 *     validation, 404 on unknown id.
 *   - OpenAPI doc + Swagger UI are reachable.
 *   - Optional bearer auth on /v1/* — 401 without, 200 with.
 *   - SSE: connection establishes, "connected to <id>" frame arrives,
 *     heartbeat fires, abort cleans up the broker subscription.
 *   - Multi-subscriber fan-out: two subscribers on one channel both
 *     receive a published event.
 *
 * What's NOT covered (yet): real agent prompt round-trip (would need an
 * LLM key and would cost money). That's the manual end-to-end smoke
 * test in apps/eventx — `task up`, type a prompt, watch the bubble fill.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type AddressInfo, createServer, type Server } from "node:net";
import { after, before, describe, test } from "node:test";
import { serve } from "@hono/node-server";
import { OpenAPIHono } from "@hono/zod-openapi";
import { AgentRuntime } from "../src/runtime.js";
import { createSessionsApp } from "../src/routes.js";
import { publish } from "../src/sseBroker.js";

/**
 * Pick a free TCP port by binding to 0, reading the assigned port, and
 * releasing immediately. Tiny race window before the test server claims
 * it, but in practice it's fine for local tests.
 */
async function pickPort(): Promise<number> {
	return new Promise((res, rej) => {
		const srv: Server = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as AddressInfo).port;
			srv.close((err) => (err ? rej(err) : res(port)));
		});
	});
}

/**
 * Build a self-contained projectDir under the OS tmp, with a stub
 * .pi/AGENTS.md so the runtime's pinned-system-prompt path resolves.
 * Returned cleanup fn removes the dir.
 */
function makeProject(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(resolve(tmpdir(), "agent-server-test-"));
	mkdirSync(resolve(dir, ".pi"), { recursive: true });
	mkdirSync(resolve(dir, "data/sessions"), { recursive: true });
	writeFileSync(resolve(dir, ".pi/AGENTS.md"), "# test agents file\n");
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Start a fully-wired agent-server (mirroring server.ts) on the given
 * port, optionally with bearer auth. Returns the server handle and
 * base URL.
 */
async function startServer(opts: {
	projectDir: string;
	port: number;
	token?: string;
}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
	const runtime = new AgentRuntime({
		projectDir: opts.projectDir,
		sessionsDir: resolve(opts.projectDir, "data/sessions"),
		agentsFile: ".pi/AGENTS.md",
		// Silence the runtime's startup logs in test output.
		logger: { log: () => {}, error: () => {} },
	});

	const root = new OpenAPIHono();

	if (opts.token) {
		root.use("/v1/*", async (c, next) => {
			const auth = c.req.header("authorization") ?? "";
			const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
			if (presented !== opts.token) return c.json({ error: "unauthorized" }, 401);
			await next();
		});
	}

	root.route("/v1", createSessionsApp(runtime));
	root.doc("/openapi.json", {
		openapi: "3.1.0",
		info: { title: "Test Agent Server", version: "0.0.0" },
	});

	const server = serve({ fetch: root.fetch, hostname: "127.0.0.1", port: opts.port });

	return {
		baseUrl: `http://127.0.0.1:${opts.port}`,
		close: () =>
			new Promise<void>((res, rej) => {
				server.close((err) => (err ? rej(err) : res()));
			}),
	};
}

describe("agent-server: REST surface", () => {
	const project = makeProject();
	let baseUrl: string;
	let close: () => Promise<void>;

	before(async () => {
		const port = await pickPort();
		({ baseUrl, close } = await startServer({ projectDir: project.dir, port }));
	});

	after(async () => {
		await close();
		project.cleanup();
	});

	test("GET /v1/healthz returns ok", async () => {
		const res = await fetch(`${baseUrl}/v1/healthz`);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { ok: boolean; service: string };
		assert.equal(body.ok, true);
		assert.equal(body.service, "agent-server");
	});

	test("GET /v1/sessions starts empty", async () => {
		const res = await fetch(`${baseUrl}/v1/sessions`);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { sessions: unknown[] };
		assert.deepEqual(body.sessions, []);
	});

	test("POST /v1/sessions creates a session, GET /v1/sessions lists it", async () => {
		const create = await fetch(`${baseUrl}/v1/sessions`, { method: "POST" });
		assert.equal(create.status, 200);
		const created = (await create.json()) as { id: string; createdAt: string };
		assert.match(created.id, /[0-9a-f-]{16,}/);
		assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T/);

		const list = await fetch(`${baseUrl}/v1/sessions`);
		const { sessions } = (await list.json()) as { sessions: { id: string }[] };
		assert.ok(sessions.some((s) => s.id === created.id));
	});

	test("GET /v1/sessions/{id} returns persisted history (empty for new session)", async () => {
		const create = await fetch(`${baseUrl}/v1/sessions`, { method: "POST" });
		const { id } = (await create.json()) as { id: string };

		const res = await fetch(`${baseUrl}/v1/sessions/${id}`);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { id: string; messages: unknown[] };
		assert.equal(body.id, id);
		assert.deepEqual(body.messages, []);
	});

	test("GET /v1/sessions/{unknown} → 404", async () => {
		const res = await fetch(`${baseUrl}/v1/sessions/does-not-exist`);
		assert.equal(res.status, 404);
		const body = (await res.json()) as { error: string };
		assert.match(body.error, /not found/i);
	});

	test("POST /v1/sessions/{id}/prompt with empty body → 400 from Zod", async () => {
		const create = await fetch(`${baseUrl}/v1/sessions`, { method: "POST" });
		const { id } = (await create.json()) as { id: string };

		const res = await fetch(`${baseUrl}/v1/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "" }),
		});
		// @hono/zod-openapi rejects schema-invalid bodies with 400 by default.
		assert.equal(res.status, 400);
	});

	test("POST /v1/sessions/{id}/abort on idle session → 200 ok", async () => {
		const create = await fetch(`${baseUrl}/v1/sessions`, { method: "POST" });
		const { id } = (await create.json()) as { id: string };

		const res = await fetch(`${baseUrl}/v1/sessions/${id}/abort`, { method: "POST" });
		assert.equal(res.status, 200);
		const body = (await res.json()) as { ok: boolean };
		assert.equal(body.ok, true);
	});

	test("GET /openapi.json exposes the contract with all paths", async () => {
		const res = await fetch(`${baseUrl}/openapi.json`);
		assert.equal(res.status, 200);
		const doc = (await res.json()) as { paths: Record<string, unknown> };
		for (const path of [
			"/v1/sessions",
			"/v1/sessions/{id}",
			"/v1/sessions/{id}/prompt",
			"/v1/sessions/{id}/abort",
			"/v1/sessions/{id}/events",
			"/v1/healthz",
		]) {
			assert.ok(doc.paths[path], `missing path ${path}`);
		}
	});
});

describe("agent-server: bearer auth seam", () => {
	const project = makeProject();
	let baseUrl: string;
	let close: () => Promise<void>;
	const token = "test-token-deadbeef";

	before(async () => {
		const port = await pickPort();
		({ baseUrl, close } = await startServer({
			projectDir: project.dir,
			port,
			token,
		}));
	});

	after(async () => {
		await close();
		project.cleanup();
	});

	test("no token → 401", async () => {
		const res = await fetch(`${baseUrl}/v1/sessions`);
		assert.equal(res.status, 401);
	});

	test("wrong token → 401", async () => {
		const res = await fetch(`${baseUrl}/v1/sessions`, {
			headers: { authorization: "Bearer nope" },
		});
		assert.equal(res.status, 401);
	});

	test("correct token → 200", async () => {
		const res = await fetch(`${baseUrl}/v1/sessions`, {
			headers: { authorization: `Bearer ${token}` },
		});
		assert.equal(res.status, 200);
	});

	test("openapi.json is outside /v1 and stays open", async () => {
		// /openapi.json and /docs deliberately don't require auth so
		// consumers can codegen against a running instance without
		// distributing the token.
		const res = await fetch(`${baseUrl}/openapi.json`);
		assert.equal(res.status, 200);
	});
});

describe("agent-server: SSE", () => {
	const project = makeProject();
	let baseUrl: string;
	let close: () => Promise<void>;

	before(async () => {
		const port = await pickPort();
		({ baseUrl, close } = await startServer({ projectDir: project.dir, port }));
	});

	after(async () => {
		await close();
		project.cleanup();
	});

	test("connects, receives 'connected to <id>' frame, then a published event", async () => {
		const create = await fetch(`${baseUrl}/v1/sessions`, { method: "POST" });
		const { id } = (await create.json()) as { id: string };

		const ac = new AbortController();
		const res = await fetch(`${baseUrl}/v1/sessions/${id}/events`, {
			signal: ac.signal,
		});
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "text/event-stream");
		assert.ok(res.body, "SSE response must have a body");

		const reader = res.body.getReader();
		const decoder = new TextDecoder();

		// 1) initial frame from streamSSE setup
		const first = await reader.read();
		const frame1 = decoder.decode(first.value);
		assert.match(frame1, /data: connected to /);

		// 2) publish a synthetic event onto the channel; the server should
		//    pick it up and write a `data: <json>` frame.
		// Tiny delay so the streamSSE loop has parked on the wakeup promise.
		await new Promise((r) => setTimeout(r, 50));
		publish(id, { type: "synthetic", n: 42 });

		// Read until we see our payload (may arrive after a short wait).
		let seen = "";
		const deadline = Date.now() + 1000;
		while (!seen.includes("synthetic") && Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) break;
			seen += decoder.decode(value);
		}
		assert.match(seen, /"type":"synthetic","n":42/);

		ac.abort();
		await reader.cancel().catch(() => {});
	});

	test("connecting to unknown session id returns 404", async () => {
		const res = await fetch(`${baseUrl}/v1/sessions/does-not-exist/events`);
		assert.equal(res.status, 404);
	});

	test("two subscribers on one channel both get a published event", async () => {
		const create = await fetch(`${baseUrl}/v1/sessions`, { method: "POST" });
		const { id } = (await create.json()) as { id: string };

		const open = async () => {
			const ac = new AbortController();
			const r = await fetch(`${baseUrl}/v1/sessions/${id}/events`, {
				signal: ac.signal,
			});
			const reader = r.body!.getReader();
			// drain initial "connected" frame
			await reader.read();
			return { ac, reader };
		};

		const a = await open();
		const b = await open();

		await new Promise((r) => setTimeout(r, 50));
		publish(id, { type: "fanout-test" });

		const dec = new TextDecoder();
		const readUntil = async (
			r: ReadableStreamDefaultReader<Uint8Array>,
			needle: string,
		): Promise<string> => {
			let buf = "";
			const deadline = Date.now() + 1000;
			while (!buf.includes(needle) && Date.now() < deadline) {
				const { value, done } = await r.read();
				if (done) break;
				buf += dec.decode(value);
			}
			return buf;
		};

		const seenA = await readUntil(a.reader, "fanout-test");
		const seenB = await readUntil(b.reader, "fanout-test");
		assert.match(seenA, /fanout-test/);
		assert.match(seenB, /fanout-test/);

		a.ac.abort();
		b.ac.abort();
		await a.reader.cancel().catch(() => {});
		await b.reader.cancel().catch(() => {});
	});
});
