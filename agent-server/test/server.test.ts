/**
 * End-to-end tests for the agent-server HTTP/SSE surface.
 *
 * Spins up a real `OpenAPIHono` app on a random local port (per describe
 * block, so we can independently test the auth-on / auth-off
 * configurations) and drives it with `fetch`. The `ProjectRuntime` is real
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
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { litellmRuntimeConfig, resetLiteLlmConfigForTests, resolveLiteLlmConfig } from "../src/providers/litellm.js";
import { ProjectRuntime } from "../src/runtime/projectRuntime.js";
import { AgentCredentialsService } from "../src/credentials/credentialsService.js";
import { ProjectRegistry, type ProjectRegistryConfig } from "../src/runtime/projectRegistry.js";
import { createSessionsApp } from "../src/http/sessionsRoutes.js";
import { createCredentialsApp } from "../src/http/credentialsRoutes.js";
import { createProjectsApp } from "../src/http/projectsRoutes.js";
import { publish } from "../src/http/sseBroker.js";

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
 * Build a self-contained workspace dir under the OS tmp. In the new model a
 * project is created inside the workspace via `registry.createProject`; this
 * just hands back an empty WORKSPACE_DIR root.
 */
function makeProject(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(resolve(tmpdir(), "agent-server-test-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Build auth/model/credentials for test runtimes.
 */
function makeCredentials(agentDir: string): {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	credentials: AgentCredentialsService;
} {
	const authStorage = AuthStorage.create(resolve(agentDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, resolve(agentDir, "models.json"));
	const credentials = new AgentCredentialsService({
		authStorage,
		modelRegistry,
		modelsJsonPath: resolve(agentDir, "models.json"),
		logger: { log: () => {}, error: () => {} },
	});
	return { authStorage, modelRegistry, credentials };
}

/**
 * Start a fully-wired agent-server (mirroring server.ts) on the given port,
 * optionally with bearer auth. Creates a `default` project inside the workspace
 * so session tests have a project to target. Returns the server handle, the
 * base URL, and `sessionsBase` (the project-scoped prefix for session routes).
 */
async function startServer(opts: {
	projectDir: string;
	port: number;
	token?: string;
	runtimeConfig?: Partial<ProjectRegistryConfig>;
}): Promise<{ baseUrl: string; sessionsBase: string; close: () => Promise<void> }> {
	const root = new OpenAPIHono();

	if (opts.token) {
		root.use("/v1/*", async (c, next) => {
			const auth = c.req.header("authorization") ?? "";
			const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
			if (presented !== opts.token) return c.json({ error: "unauthorized" }, 401);
			await next();
		});
	}

	const registry = await ProjectRegistry.create({
		workspaceDir: opts.projectDir,
		logger: { log: () => {}, error: () => {} },
		...(opts.runtimeConfig ?? {}),
	});

	// Create the project the session tests operate on, and give it a stub
	// .pi/AGENTS.md so the runtime's pinned-system-prompt path resolves.
	const project = registry.createProject({ name: "default" });
	mkdirSync(resolve(project.projectDir, ".pi"), { recursive: true });
	writeFileSync(resolve(project.projectDir, ".pi/AGENTS.md"), "# test agents file\n");

	root.route("/v1", createCredentialsApp(registry.credentials));
	root.route("/v1", createProjectsApp(registry));
	root.route("/v1/projects/:projectId", createSessionsApp(async (c) => {
		const runtime = await registry.getRuntime(c.req.param("projectId"));
		if (!runtime) throw new Error("project not registered");
		return runtime;
	}));
	root.onError((err, c) => {
		if (err instanceof Error && err.message.includes("project not registered")) {
			return c.json({ error: err.message }, 404);
		}
		return c.json({ error: "internal server error" }, 500);
	});
	root.doc("/openapi.json", {
		openapi: "3.1.0",
		info: { title: "Test Agent Server", version: "0.0.0" },
	});

	const server = serve({ fetch: root.fetch, hostname: "127.0.0.1", port: opts.port });

	return {
		baseUrl: `http://127.0.0.1:${opts.port}`,
		sessionsBase: `http://127.0.0.1:${opts.port}/v1/projects/${project.id}`,
		close: () =>
			new Promise<void>((res, rej) => {
				server.close((err) => (err ? rej(err) : res()));
			}),
	};
}

describe("agent-server: LiteLLM config", () => {
	const envKeys = [
		"LITELLM_BASE_URL",
		"LITELLM_API_KEY",
		"LITELLM_MODELS",
		"LITELLM_MODELS_JSON",
		"LITELLM_DEFAULT_MODEL",
		"LITELLM_DEFAULT_THINKING",
		"LITELLM_COMPAT_JSON",
		"LITELLM_API",
		"LITELLM_REASONING",
		"LITELLM_CONTEXT_WINDOW",
		"LITELLM_MAX_TOKENS",
	];

	after(() => {
		resetLiteLlmConfigForTests();
	});

	test("registers configured LiteLLM models with thinking defaults", async () => {
		const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
		const project = makeProject();
		try {
			process.env.LITELLM_BASE_URL = "http://litellm.test/v1";
			process.env.LITELLM_API_KEY = "test-key";
			process.env.LITELLM_DEFAULT_MODEL = "openai/gpt-5.5";
			process.env.LITELLM_DEFAULT_THINKING = "high";
			process.env.LITELLM_MODELS_JSON = JSON.stringify([{ id: "openai/gpt-5.5" }]);
			resetLiteLlmConfigForTests();

			const agentDir = resolve(project.dir, ".pi-agent");
			const authStorage = AuthStorage.create(resolve(agentDir, "auth.json"));
			const modelRegistry = ModelRegistry.create(authStorage, resolve(agentDir, "models.json"));
			const litellmConfig = litellmRuntimeConfig();
			litellmConfig.configureModelRegistry?.(modelRegistry);
			const credentials = new AgentCredentialsService({
				authStorage,
				modelRegistry,
				modelsJsonPath: resolve(agentDir, "models.json"),
				defaultModelProvider: litellmConfig.defaultModelProvider,
				defaultModelId: litellmConfig.defaultModelId,
				defaultThinkingLevel: litellmConfig.defaultThinkingLevel,
				modelThinkingDefaults: litellmConfig.modelThinkingDefaults,
				logger: { log: () => {}, error: () => {} },
			});
			await ProjectRuntime.create({
				...litellmConfig,
				configureModelRegistry: undefined,
				projectDir: project.dir,
				agentDir,
				credentials,
				authStorage,
				modelRegistry,
				logger: { log: () => {}, error: () => {} },
			});

			const models = credentials.listModels().filter((model) => model.provider === "litellm");
			assert.equal(models.length, 1);
			assert.equal(models[0]!.id, "openai/gpt-5.5");
			assert.equal(models[0]!.reasoning, true);
			assert.equal(models[0]!.available, true);
			assert.equal(models[0]!.defaultThinkingLevel, "xhigh");
		} finally {
			for (const key of envKeys) {
				const value = previous.get(key);
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			resetLiteLlmConfigForTests();
			project.cleanup();
		}
	});

	test("applies preset compat when only a default LiteLLM model is configured", () => {
		const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
		try {
			process.env.LITELLM_BASE_URL = "http://litellm.test/v1";
			process.env.LITELLM_API_KEY = "test-key";
			process.env.LITELLM_DEFAULT_MODEL = "openai/gpt-5.5";
			delete process.env.LITELLM_MODELS;
			delete process.env.LITELLM_MODELS_JSON;
			delete process.env.LITELLM_COMPAT_JSON;
			resetLiteLlmConfigForTests();

			const config = resolveLiteLlmConfig();
			const compat = config?.defaultModel.compat as Record<string, unknown> | undefined;
			assert.equal(config?.defaultModel.api, "openai-responses");
			assert.equal(config?.defaultModel.reasoning, true);
			assert.equal(compat?.thinkingFormat, "openai");
			assert.equal(compat?.supportsReasoningEffort, true);
			assert.equal(compat?.maxTokensField, "max_output_tokens");
		} finally {
			for (const key of envKeys) {
				const value = previous.get(key);
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			resetLiteLlmConfigForTests();
		}
	});
});

describe("agent-server: REST surface", () => {
	const project = makeProject();
	let baseUrl: string;
	let sessionsBase: string;
	let close: () => Promise<void>;

	before(async () => {
		const port = await pickPort();
		({ baseUrl, sessionsBase, close } = await startServer({ projectDir: project.dir, port }));
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
		const res = await fetch(`${sessionsBase}/sessions`);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { sessions: unknown[] };
		assert.deepEqual(body.sessions, []);
	});

	test("POST /v1/sessions creates a session, GET /v1/sessions lists it", async () => {
		const create = await fetch(`${sessionsBase}/sessions`, { method: "POST" });
		assert.equal(create.status, 200);
		const created = (await create.json()) as { id: string; createdAt: string };
		assert.match(created.id, /[0-9a-f-]{16,}/);
		assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T/);

		const list = await fetch(`${sessionsBase}/sessions`);
		const { sessions } = (await list.json()) as { sessions: { id: string }[] };
		assert.ok(sessions.some((s) => s.id === created.id));
	});

	test("GET /v1/sessions/models lists public model metadata", async () => {
		const res = await fetch(`${baseUrl}/v1/sessions/models`);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { models: Array<{ provider: string; id: string; available: boolean }> };
		assert.ok(Array.isArray(body.models));
		assert.ok(body.models.length > 0);
		assert.equal(typeof body.models[0]!.provider, "string");
		assert.equal(typeof body.models[0]!.id, "string");
		assert.equal(typeof body.models[0]!.available, "boolean");
	});

	test("provider auth API stores status without exposing keys", async () => {
		const before = await fetch(`${baseUrl}/v1/auth/providers`);
		assert.equal(before.status, 200);
		const initial = (await before.json()) as {
			providers: Array<{ provider: string; configured: boolean; source?: string }>;
		};
		assert.ok(initial.providers.some((p) => p.provider === "anthropic"));

		const put = await fetch(`${baseUrl}/v1/auth/providers/anthropic/api-key`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key: "sk-ant-test-secret" }),
		});
		assert.equal(put.status, 200);
		assert.deepEqual((await put.json()) as { ok: boolean }, { ok: true });

		const afterSet = await fetch(`${baseUrl}/v1/auth/providers`);
		assert.equal(afterSet.status, 200);
		const setText = await afterSet.text();
		assert.equal(setText.includes("sk-ant-test-secret"), false);
		const setBody = JSON.parse(setText) as {
			providers: Array<{ provider: string; configured: boolean; source?: string }>;
		};
		const anthropic = setBody.providers.find((p) => p.provider === "anthropic");
		assert.equal(anthropic?.configured, true);
		assert.equal(anthropic?.source, "stored");

		const del = await fetch(`${baseUrl}/v1/auth/providers/anthropic`, { method: "DELETE" });
		assert.equal(del.status, 200);
		assert.deepEqual((await del.json()) as { ok: boolean }, { ok: true });
	});

	test("provider auth status treats runtime credentials as configured", async () => {
		const project = makeProject();
		try {
			const agentDir = resolve(project.dir, ".pi-agent");
			const { authStorage, modelRegistry, credentials } = makeCredentials(agentDir);
			await ProjectRuntime.create({
				projectDir: project.dir,
				agentDir,
				credentials,
				authStorage,
				modelRegistry,
				anthropicApiKey: "sk-ant-runtime-test",
				logger: { log: () => {}, error: () => {} },
			});
			const anthropic = credentials.listAuthProviders().find((p) => p.provider === "anthropic");
			assert.equal(anthropic?.configured, true);
			assert.equal(anthropic?.source, "runtime");
		} finally {
			project.cleanup();
		}
	});

	test("subscription auth flow stores OAuth credentials without exposing tokens", async () => {
		const project = makeProject();
		const port = await pickPort();
		const server = await startServer({
			projectDir: project.dir,
			port,
			runtimeConfig: {
				configureModelRegistry: (modelRegistry) => {
					modelRegistry.registerProvider("test-oauth", {
						name: "Test OAuth",
						baseUrl: "https://example.test/v1",
						api: "openai-completions",
						oauth: {
							name: "Test Subscription",
							login: async (callbacks: any) => {
								callbacks.onAuth?.({
									url: "https://login.example.test/device",
									instructions: "Paste the redirect URL.",
								});
								const code = await callbacks.onManualCodeInput?.();
								if (code !== "ok") throw new Error("unexpected code");
								return {
									access: "oauth-access-token",
									refresh: "oauth-refresh-token",
									expires: Date.now() + 60_000,
								};
							},
							refreshToken: async (credentials: any) => credentials,
							getApiKey: (credentials: any) => credentials.access,
						},
						models: [
							{
								id: "test-model",
								name: "Test Model",
								api: "openai-completions",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 4096,
								maxTokens: 1024,
							},
						],
					});
				},
			},
		});
		try {
			const start = await fetch(`${server.baseUrl}/v1/auth/providers/test-oauth/subscription/start`, {
				method: "POST",
			});
			assert.equal(start.status, 200);
			const flow = (await start.json()) as { id: string; status: string; authUrl?: string };
			assert.equal(flow.status, "auth");
			assert.equal(flow.authUrl, "https://login.example.test/device");

			const cont = await fetch(`${server.baseUrl}/v1/auth/subscription/${flow.id}/continue`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ value: "ok" }),
			});
			assert.equal(cont.status, 200);
			const completed = await cont.text();
			assert.equal(completed.includes("oauth-access-token"), false);
			const completedState = JSON.parse(completed) as { status: string };
			assert.equal(completedState.status, "complete");

			const providers = await fetch(`${server.baseUrl}/v1/auth/providers`);
			const providerText = await providers.text();
			assert.equal(providerText.includes("oauth-access-token"), false);
			const providerBody = JSON.parse(providerText) as {
				providers: Array<{ provider: string; configured: boolean; credentialType?: string; source?: string }>;
			};
			const provider = providerBody.providers.find((entry) => entry.provider === "test-oauth");
			assert.equal(provider?.configured, true);
			assert.equal(provider?.credentialType, "oauth");
			assert.equal(provider?.source, "stored");
		} finally {
			await server.close();
			project.cleanup();
		}
	});

	test("subscription auth start reuses an active provider flow", async () => {
		const project = makeProject();
		const port = await pickPort();
		let loginCalls = 0;
		const server = await startServer({
			projectDir: project.dir,
			port,
			runtimeConfig: {
				configureModelRegistry: (modelRegistry) => {
					modelRegistry.registerProvider("test-reuse-oauth", {
						name: "Test Reuse OAuth",
						baseUrl: "https://example.test/v1",
						api: "openai-completions",
						oauth: {
							name: "Test Reuse Subscription",
							login: async (callbacks: any) => {
								loginCalls += 1;
								callbacks.onAuth?.({
									url: "https://login.example.test/reuse",
									instructions: "Complete login.",
								});
								await callbacks.onManualCodeInput?.();
								return {
									access: "oauth-access-token",
									refresh: "oauth-refresh-token",
									expires: Date.now() + 60_000,
								};
							},
							refreshToken: async (credentials: any) => credentials,
							getApiKey: (credentials: any) => credentials.access,
						},
						models: [
							{
								id: "test-reuse-model",
								name: "Test Reuse Model",
								api: "openai-completions",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 4096,
								maxTokens: 1024,
							},
						],
					});
				},
			},
		});
		try {
			const first = await fetch(`${server.baseUrl}/v1/auth/providers/test-reuse-oauth/subscription/start`, {
				method: "POST",
			});
			assert.equal(first.status, 200);
			const firstFlow = (await first.json()) as { id: string; status: string; authUrl?: string };
			assert.equal(firstFlow.status, "auth");

			const second = await fetch(`${server.baseUrl}/v1/auth/providers/test-reuse-oauth/subscription/start`, {
				method: "POST",
			});
			assert.equal(second.status, 200);
			const secondFlow = (await second.json()) as { id: string; status: string; authUrl?: string };
			assert.equal(secondFlow.id, firstFlow.id);
			assert.equal(secondFlow.status, "auth");
			assert.equal(secondFlow.authUrl, "https://login.example.test/reuse");
			assert.equal(loginCalls, 1);

			const cancel = await fetch(`${server.baseUrl}/v1/auth/subscription/${firstFlow.id}`, {
				method: "DELETE",
			});
			assert.equal(cancel.status, 200);
		} finally {
			await server.close();
			project.cleanup();
		}
	});

	test("subscription auth surfaces callback port conflicts as actionable errors", async () => {
		const project = makeProject();
		const port = await pickPort();
		const server = await startServer({
			projectDir: project.dir,
			port,
			runtimeConfig: {
				configureModelRegistry: (modelRegistry) => {
					modelRegistry.registerProvider("test-port-oauth", {
						name: "Test Port OAuth",
						baseUrl: "https://example.test/v1",
						api: "openai-completions",
						oauth: {
							name: "Test Port Subscription",
							login: async () => {
								throw new Error("listen EADDRINUSE: address already in use 127.0.0.1:53692");
							},
							refreshToken: async (credentials: any) => credentials,
							getApiKey: (credentials: any) => credentials.access,
						},
						models: [
							{
								id: "test-port-model",
								name: "Test Port Model",
								api: "openai-completions",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 4096,
								maxTokens: 1024,
							},
						],
					});
				},
			},
		});
		try {
			const start = await fetch(`${server.baseUrl}/v1/auth/providers/test-port-oauth/subscription/start`, {
				method: "POST",
			});
			assert.equal(start.status, 200);
			const flow = (await start.json()) as { status: string; error?: string };
			assert.equal(flow.status, "error");
			assert.equal(
				flow.error,
				"Test Port Subscription login callback is already running on its local port. Finish or cancel the existing login, then try again.",
			);
		} finally {
			await server.close();
			project.cleanup();
		}
	});

	test("custom provider API manages LiteLLM-style models without returning secrets", async () => {
		const providerId = "litellm-ui-test";
		const save = await fetch(`${baseUrl}/v1/custom/providers`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				provider: providerId,
				name: "LiteLLM UI Test",
				baseUrl: "http://litellm.test/v1",
				api: "openai-responses",
				apiKey: "test-litellm-secret",
				models: [
					{
						id: "openai/gpt-5.5",
						name: "GPT 5.5 via LiteLLM",
						api: "openai-responses",
						reasoning: true,
						thinkingLevelMap: {
							off: "none",
							minimal: "minimal",
							low: "low",
							medium: "medium",
							high: "high",
							xhigh: "xhigh",
						},
						input: ["text"],
						contextWindow: 128000,
						maxTokens: 16384,
						compat: { supportsReasoningEffort: true, maxTokensField: "max_output_tokens" },
					},
				],
			}),
		});
		assert.equal(save.status, 200);
		const savedText = await save.text();
		assert.equal(savedText.includes("test-litellm-secret"), false);
		const saved = JSON.parse(savedText) as { provider: string; apiKeyConfigured: boolean; modelCount: number };
		assert.equal(saved.provider, providerId);
		assert.equal(saved.apiKeyConfigured, true);
		assert.equal(saved.modelCount, 1);

		const list = await fetch(`${baseUrl}/v1/custom/providers`);
		const listText = await list.text();
		assert.equal(listText.includes("test-litellm-secret"), false);
		const listBody = JSON.parse(listText) as { providers: Array<{ provider: string; modelCount: number }> };
		assert.ok(listBody.providers.some((provider) => provider.provider === providerId && provider.modelCount === 1));

		const models = await fetch(`${baseUrl}/v1/sessions/models`);
		const modelBody = (await models.json()) as {
			models: Array<{ provider: string; id: string; available: boolean; reasoning: boolean }>;
		};
		const customModel = modelBody.models.find((model) => model.provider === providerId && model.id === "openai/gpt-5.5");
		assert.equal(customModel?.available, true);
		assert.equal(customModel?.reasoning, true);

		const del = await fetch(`${baseUrl}/v1/custom/providers/${providerId}`, { method: "DELETE" });
		assert.equal(del.status, 200);
	});

	test("GET/PATCH /v1/sessions/{id}/settings exposes model and thinking controls", async () => {
		const create = await fetch(`${sessionsBase}/sessions`, { method: "POST" });
		const { id } = (await create.json()) as { id: string };

		const settings = await fetch(`${sessionsBase}/sessions/${id}/settings`);
		assert.equal(settings.status, 200);
		const body = (await settings.json()) as {
			thinkingLevel: string;
			availableThinkingLevels: string[];
			isStreaming: boolean;
		};
		assert.equal(typeof body.thinkingLevel, "string");
		assert.ok(Array.isArray(body.availableThinkingLevels));
		assert.equal(body.isStreaming, false);

		const patch = await fetch(`${sessionsBase}/sessions/${id}/settings`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ thinkingLevel: "off" }),
		});
		assert.equal(patch.status, 200);
		const patched = (await patch.json()) as { thinkingLevel: string };
		assert.equal(patched.thinkingLevel, "off");
	});

	test("PATCH /v1/sessions/{id}/settings rejects incomplete model pairs and empty bodies", async () => {
		const create = await fetch(`${sessionsBase}/sessions`, { method: "POST" });
		const { id } = (await create.json()) as { id: string };

		const missingModelId = await fetch(`${sessionsBase}/sessions/${id}/settings`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ provider: "anthropic" }),
		});
		assert.equal(missingModelId.status, 400);

		const empty = await fetch(`${sessionsBase}/sessions/${id}/settings`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		assert.equal(empty.status, 400);
	});

	test("GET /v1/sessions/{id} returns persisted history (empty for new session)", async () => {
		const create = await fetch(`${sessionsBase}/sessions`, { method: "POST" });
		const { id } = (await create.json()) as { id: string };

		const res = await fetch(`${sessionsBase}/sessions/${id}`);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { id: string; messages: unknown[] };
		assert.equal(body.id, id);
		assert.deepEqual(body.messages, []);
	});

	test("GET /v1/sessions/{unknown} → 404", async () => {
		const res = await fetch(`${sessionsBase}/sessions/does-not-exist`);
		assert.equal(res.status, 404);
		const body = (await res.json()) as { error: string };
		assert.match(body.error, /not found/i);
	});

	test("POST /v1/sessions/{id}/prompt with empty body → 400 from Zod", async () => {
		const create = await fetch(`${sessionsBase}/sessions`, { method: "POST" });
		const { id } = (await create.json()) as { id: string };

		const res = await fetch(`${sessionsBase}/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "" }),
		});
		// @hono/zod-openapi rejects schema-invalid bodies with 400 by default.
		assert.equal(res.status, 400);
	});

	test("POST /v1/sessions/{unknown}/prompt → 404", async () => {
		const res = await fetch(`${sessionsBase}/sessions/does-not-exist/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "hello" }),
		});
		assert.equal(res.status, 404);
		const body = (await res.json()) as { error: string };
		assert.match(body.error, /not found/i);
	});

	test("POST /v1/sessions/{id}/abort on idle session → 200 ok", async () => {
		const create = await fetch(`${sessionsBase}/sessions`, { method: "POST" });
		const { id } = (await create.json()) as { id: string };

		const res = await fetch(`${sessionsBase}/sessions/${id}/abort`, { method: "POST" });
		assert.equal(res.status, 200);
		const body = (await res.json()) as { ok: boolean };
		assert.equal(body.ok, true);
	});

	test("GET /openapi.json exposes the contract with all paths", async () => {
		const res = await fetch(`${baseUrl}/openapi.json`);
		assert.equal(res.status, 200);
		const doc = (await res.json()) as { paths: Record<string, unknown> };
		for (const path of [
			"/v1/auth/providers",
			"/v1/auth/providers/{provider}/api-key",
			"/v1/auth/providers/{provider}/subscription/start",
			"/v1/auth/providers/{provider}",
			"/v1/auth/subscription/{flowId}",
			"/v1/auth/subscription/{flowId}/continue",
			"/v1/custom/providers",
			"/v1/custom/providers/{provider}",
			"/v1/projects",
			"/v1/projects/{id}",
			"/v1/sessions/models",
			"/v1/projects/{projectId}/sessions",
			"/v1/projects/{projectId}/sessions/{id}",
			"/v1/projects/{projectId}/sessions/{id}/settings",
			"/v1/projects/{projectId}/sessions/{id}/prompt",
			"/v1/projects/{projectId}/sessions/{id}/abort",
			"/v1/projects/{projectId}/sessions/{id}/events",
			"/v1/projects/{projectId}/sessions/{id}/extension-ui",
			"/v1/projects/{projectId}/sessions/{id}/extension-ui/{requestId}/response",
			"/v1/healthz",
		]) {
			assert.ok(doc.paths[path], `missing path ${path}`);
		}
	});

	test("extension UI pending/response endpoints are wired", async () => {
		const create = await fetch(`${sessionsBase}/sessions`, { method: "POST" });
		const { id } = (await create.json()) as { id: string };

		const pending = await fetch(`${sessionsBase}/sessions/${id}/extension-ui`);
		assert.equal(pending.status, 200);
		assert.deepEqual((await pending.json()) as { requests: unknown[] }, { requests: [] });

		const response = await fetch(`${sessionsBase}/sessions/${id}/extension-ui/not-real/response`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cancelled: true }),
		});
		assert.equal(response.status, 404);
	});
});

describe("agent-server: project-scoped runtimes", () => {
	/** Wire credentials + projects + session routes exactly like server.ts. */
	function mountServer(registry: ProjectRegistry, port: number) {
		const root = new OpenAPIHono();
		root.route("/v1", createCredentialsApp(registry.credentials));
		root.route("/v1", createProjectsApp(registry));
		root.route("/v1/projects/:projectId", createSessionsApp(async (c) => {
			const runtime = await registry.getRuntime(c.req.param("projectId"));
			if (!runtime) throw new Error("project not registered");
			return runtime;
		}));
		root.onError((err, c) => {
			if (err instanceof Error && err.message.includes("project not registered")) {
				return c.json({ error: err.message }, 404);
			}
			return c.json({ error: "internal server error" }, 500);
		});
		return serve({ fetch: root.fetch, hostname: "127.0.0.1", port });
	}

	test("credentials stay global; sessions require a registered project", async () => {
		const workspace = makeProject();
		const port = await pickPort();
		const registry = await ProjectRegistry.create({
			workspaceDir: workspace.dir,
			logger: { log: () => {}, error: () => {} },
		});
		const server = mountServer(registry, port);
		const baseUrl = `http://127.0.0.1:${port}`;

		try {
			const globalAuth = await fetch(`${baseUrl}/v1/auth/providers`);
			assert.equal(globalAuth.status, 200);

			// Sessions for an unregistered project 404 — no implicit creation.
			const unregistered = await fetch(`${baseUrl}/v1/projects/project-a/sessions`, {
				method: "POST",
			});
			assert.equal(unregistered.status, 404);

			// Create the project explicitly, then sessions resolve.
			const created = await fetch(`${baseUrl}/v1/projects`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "project-a" }),
			});
			assert.equal(created.status, 200);
			const createdBody = (await created.json()) as { id: string };
			assert.equal(createdBody.id, "project-a");

			const create = await fetch(`${baseUrl}/v1/projects/project-a/sessions`, {
				method: "POST",
			});
			assert.equal(create.status, 200);
		} finally {
			await new Promise<void>((res, rej) => {
				server.close((err) => (err ? rej(err) : res()));
			});
			workspace.cleanup();
		}
	});

	test("POST /v1/projects is idempotent on name across restarts", async () => {
		const workspace = makeProject();
		const port = await pickPort();
		const registry = await ProjectRegistry.create({
			workspaceDir: workspace.dir,
			logger: { log: () => {}, error: () => {} },
		});
		const server = mountServer(registry, port);
		const baseUrl = `http://127.0.0.1:${port}`;

		try {
			const first = await fetch(`${baseUrl}/v1/projects`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "my-app" }),
			});
			const firstBody = (await first.json()) as { id: string; createdAt: string };

			const again = await fetch(`${baseUrl}/v1/projects`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "my-app" }),
			});
			const againBody = (await again.json()) as { id: string; createdAt: string };

			// Same id, same createdAt — the existing project is returned untouched.
			assert.equal(againBody.id, firstBody.id);
			assert.equal(againBody.createdAt, firstBody.createdAt);

			// A second registry over the same workspace rehydrates from projects.json.
			const reopened = await ProjectRegistry.create({
				workspaceDir: workspace.dir,
				logger: { log: () => {}, error: () => {} },
			});
			assert.ok(reopened.getProject("my-app"));
			assert.equal(reopened.listProjects().length, 1);
		} finally {
			await new Promise<void>((res, rej) => {
				server.close((err) => (err ? rej(err) : res()));
			});
			workspace.cleanup();
		}
	});

	test("project routes isolate sessions by project", async () => {
		const workspace = makeProject();
		const port = await pickPort();
		const registry = await ProjectRegistry.create({
			workspaceDir: workspace.dir,
			logger: { log: () => {}, error: () => {} },
		});
		registry.createProject({ name: "project-a" });
		registry.createProject({ name: "project-b" });
		const server = mountServer(registry, port);
		const baseUrl = `http://127.0.0.1:${port}`;

		try {
			const create = await fetch(`${baseUrl}/v1/projects/project-a/sessions`, {
				method: "POST",
			});
			assert.equal(create.status, 200);
			const created = (await create.json()) as { id: string };

			const listA = await fetch(`${baseUrl}/v1/projects/project-a/sessions`);
			assert.equal(listA.status, 200);
			const bodyA = (await listA.json()) as { sessions: { id: string }[] };
			assert.ok(bodyA.sessions.some((session) => session.id === created.id));

			const listB = await fetch(`${baseUrl}/v1/projects/project-b/sessions`);
			assert.equal(listB.status, 200);
			const bodyB = (await listB.json()) as { sessions: { id: string }[] };
			assert.deepEqual(bodyB.sessions, []);
		} finally {
			await new Promise<void>((res, rej) => {
				server.close((err) => (err ? rej(err) : res()));
			});
			workspace.cleanup();
		}
	});
});

describe("agent-server: bearer auth seam", () => {
	const project = makeProject();
	let baseUrl: string;
	let sessionsBase: string;
	let close: () => Promise<void>;
	const token = "test-token-deadbeef";

	before(async () => {
		const port = await pickPort();
		({ baseUrl, sessionsBase, close } = await startServer({
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
		const res = await fetch(`${sessionsBase}/sessions`);
		assert.equal(res.status, 401);
	});

	test("wrong token → 401", async () => {
		const res = await fetch(`${sessionsBase}/sessions`, {
			headers: { authorization: "Bearer nope" },
		});
		assert.equal(res.status, 401);
	});

	test("correct token → 200", async () => {
		const res = await fetch(`${sessionsBase}/sessions`, {
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
	let sessionsBase: string;
	let close: () => Promise<void>;

	before(async () => {
		const port = await pickPort();
		({ baseUrl, sessionsBase, close } = await startServer({ projectDir: project.dir, port }));
	});

	after(async () => {
		await close();
		project.cleanup();
	});

	test("connects, receives 'connected to <id>' frame, then a published event", async () => {
		const create = await fetch(`${sessionsBase}/sessions`, { method: "POST" });
		const { id } = (await create.json()) as { id: string };

		const ac = new AbortController();
		const res = await fetch(`${sessionsBase}/sessions/${id}/events`, {
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
		const res = await fetch(`${sessionsBase}/sessions/does-not-exist/events`);
		assert.equal(res.status, 404);
	});

	test("two subscribers on one channel both get a published event", async () => {
		const create = await fetch(`${sessionsBase}/sessions`, { method: "POST" });
		const { id } = (await create.json()) as { id: string };

		const open = async () => {
			const ac = new AbortController();
			const r = await fetch(`${sessionsBase}/sessions/${id}/events`, {
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
