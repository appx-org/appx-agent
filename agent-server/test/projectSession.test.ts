/**
 * Unit tests for ProjectSession.
 *
 * Rather than spinning up a real AgentSession (which requires resource
 * loading, extension binding, and a session manager), we drive ProjectSession
 * with a hand-rolled fake AgentSession that implements only the surface
 * ProjectSession actually touches:
 *
 *   - subscribe / dispatchEvent
 *   - bindExtensions (resolves with the bindings object so we can introspect it)
 *   - isStreaming / state.messages / model / thinkingLevel /
 *     getAvailableThinkingLevels / supportsThinking
 *   - prompt / abort / setModel / setThinkingLevel / reload
 *   - agent.waitForIdle (used by commandActions)
 *
 * The fake captures bindings passed into bindExtensions so tests can drive
 * the ExtensionUIContext directly (e.g. invoke ui.confirm() and observe the
 * SSE publish + pendingExtensionUiRequests bookkeeping).
 *
 * SSE publishing is a process-wide singleton; tests `subscribe` to a per-test
 * sessionId and assert the events that arrived. Each test uses a unique
 * sessionId to avoid cross-test interference.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentSession, ExtensionBindings } from "@earendil-works/pi-coding-agent";
import type { AgentCredentialsService, AgentModelRow } from "../src/credentials/credentialsService.js";
import { ProjectSession } from "../src/runtime/projectSession.js";
import { subscribe } from "../src/http/sseBroker.js";
import type { ThinkingLevel } from "../src/shared/thinking.js";

type FakeListener = (event: unknown) => void;

interface FakeAgentSession {
	sessionId: string;
	model: { provider: string; id: string } | undefined;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	state: { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> };
	subscribe: AgentSession["subscribe"];
	bindExtensions: AgentSession["bindExtensions"];
	prompt: AgentSession["prompt"];
	abort: AgentSession["abort"];
	setModel: AgentSession["setModel"];
	setThinkingLevel: AgentSession["setThinkingLevel"];
	getAvailableThinkingLevels: AgentSession["getAvailableThinkingLevels"];
	supportsThinking: AgentSession["supportsThinking"];
	reload: AgentSession["reload"];
	agent: AgentSession["agent"];
	// test-only helpers
	dispatch(event: unknown): void;
	bindings(): ExtensionBindings | undefined;
	bindExtensionsResolveAfter?: Promise<void>;
}

interface MakeFakeOptions {
	sessionId?: string;
	isStreaming?: boolean;
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
	availableThinkingLevels?: ThinkingLevel[];
	supportsThinking?: boolean;
	bindExtensionsBehavior?: "resolve" | "reject";
	messages?: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
}

interface FakeRecording {
	prompts: Array<{ text: string; options?: unknown }>;
	aborts: number;
	setModelCalls: Array<{ provider: string; id: string }>;
	setThinkingLevelCalls: ThinkingLevel[];
	reloads: number;
}

function makeFakeSession(opts: MakeFakeOptions = {}): {
	session: AgentSession;
	rec: FakeRecording;
	dispatch: (event: unknown) => void;
	bindings: () => ExtensionBindings | undefined;
} {
	const listeners = new Set<FakeListener>();
	const rec: FakeRecording = {
		prompts: [],
		aborts: 0,
		setModelCalls: [],
		setThinkingLevelCalls: [],
		reloads: 0,
	};
	let capturedBindings: ExtensionBindings | undefined;
	const fake: FakeAgentSession = {
		sessionId: opts.sessionId ?? "test-session",
		model: opts.model,
		thinkingLevel: opts.thinkingLevel ?? "off",
		isStreaming: opts.isStreaming ?? false,
		state: { messages: opts.messages ?? [] },
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async bindExtensions(bindings) {
			capturedBindings = bindings;
			if (opts.bindExtensionsBehavior === "reject") {
				throw new Error("bindExtensions failed");
			}
		},
		async prompt(text, options) {
			rec.prompts.push({ text, options });
		},
		async abort() {
			rec.aborts += 1;
		},
		async setModel(model) {
			rec.setModelCalls.push({ provider: model.provider, id: model.id });
			fake.model = { provider: model.provider, id: model.id };
		},
		setThinkingLevel(level) {
			rec.setThinkingLevelCalls.push(level as ThinkingLevel);
			fake.thinkingLevel = level as ThinkingLevel;
		},
		getAvailableThinkingLevels() {
			return (opts.availableThinkingLevels ?? ["off"]) as ThinkingLevel[];
		},
		supportsThinking() {
			return opts.supportsThinking ?? false;
		},
		async reload() {
			rec.reloads += 1;
		},
		agent: {
			async waitForIdle() {},
		} as unknown as AgentSession["agent"],
		dispatch(event) {
			for (const l of listeners) l(event);
		},
		bindings: () => capturedBindings,
	};
	return {
		session: fake as unknown as AgentSession,
		rec,
		dispatch: fake.dispatch,
		bindings: fake.bindings,
	};
}

function makeFakeDeps(): {
	credentials: AgentCredentialsService;
	modelRegistry: { find: (provider: string, id: string) => unknown };
	logger: { log: () => void; error: () => void };
	models: Map<string, { provider: string; id: string }>;
	defaultThinking: Map<string, ThinkingLevel>;
} {
	const models = new Map<string, { provider: string; id: string }>();
	const defaultThinking = new Map<string, ThinkingLevel>();
	const credentials = {
		modelRow: (model: { provider: string; id: string }): AgentModelRow =>
			({ provider: model.provider, id: model.id }) as AgentModelRow,
		defaultThinkingForModel: (model: { provider: string; id: string }) =>
			defaultThinking.get(`${model.provider}/${model.id}`),
	} as unknown as AgentCredentialsService;
	const modelRegistry = {
		find: (provider: string, id: string) => models.get(`${provider}/${id}`),
	};
	const logger = { log: () => {}, error: () => {} };
	return { credentials, modelRegistry, logger, models, defaultThinking };
}

/**
 * Subscribe to the SSE broker for a sessionId and return both the captured
 * events and a cleanup. Tests should call cleanup at the end so subscriptions
 * don't leak across tests (the broker is process-wide).
 */
function captureSseEvents(sessionId: string): {
	events: unknown[];
	stop: () => void;
} {
	const events: unknown[] = [];
	const unsubscribe = subscribe(sessionId, (event) => {
		events.push(event);
	});
	return { events, stop: unsubscribe };
}

describe("ProjectSession — event subscription", () => {
	test("forwards AgentSession events to SSE broker keyed by sessionId", async () => {
		const sessionId = "ev-fwd-1";
		const { session, dispatch } = makeFakeSession({ sessionId });
		const deps = makeFakeDeps();
		const capture = captureSseEvents(sessionId);
		try {
			const ps = new ProjectSession(session, deps);
			await ps.extensionsReady;
			dispatch({ type: "message_start", id: "m1" });
			dispatch({ type: "message_end", id: "m1" });
			assert.deepEqual(capture.events, [
				{ type: "message_start", id: "m1" },
				{ type: "message_end", id: "m1" },
			]);
		} finally {
			capture.stop();
		}
	});

	test("publishes extension_error when bindExtensions rejects", async () => {
		const sessionId = "ev-bind-fail";
		const { session } = makeFakeSession({ sessionId, bindExtensionsBehavior: "reject" });
		const deps = makeFakeDeps();
		const capture = captureSseEvents(sessionId);
		try {
			const ps = new ProjectSession(session, deps);
			await ps.extensionsReady;
			const err = capture.events.find(
				(e): e is { type: "extension_error"; extensionPath: string } =>
					typeof e === "object" &&
					e !== null &&
					(e as { type?: unknown }).type === "extension_error",
			);
			assert.ok(err, "expected an extension_error event");
			assert.equal(err.extensionPath, "<bindExtensions>");
		} finally {
			capture.stop();
		}
	});
});

describe("ProjectSession — sendPrompt", () => {
	test("awaits extensionsReady before delegating to session.prompt", async () => {
		const sessionId = "send-1";
		const { session, rec } = makeFakeSession({ sessionId });
		const deps = makeFakeDeps();
		const ps = new ProjectSession(session, deps);
		await ps.sendPrompt("hello");
		assert.equal(rec.prompts.length, 1);
		assert.equal(rec.prompts[0].text, "hello");
		assert.equal(rec.prompts[0].options, undefined);
	});

	test("uses streamingBehavior: 'steer' when session is already streaming", async () => {
		const sessionId = "send-streaming";
		const { session, rec } = makeFakeSession({ sessionId, isStreaming: true });
		const deps = makeFakeDeps();
		const ps = new ProjectSession(session, deps);
		await ps.sendPrompt("interrupt");
		assert.equal(rec.prompts.length, 1);
		assert.deepEqual(rec.prompts[0].options, { streamingBehavior: "steer" });
	});
});

describe("ProjectSession — abort", () => {
	test("no-op when not streaming", async () => {
		const { session, rec } = makeFakeSession({ sessionId: "abort-idle", isStreaming: false });
		const deps = makeFakeDeps();
		const ps = new ProjectSession(session, deps);
		await ps.abort();
		assert.equal(rec.aborts, 0);
	});

	test("calls session.abort when streaming", async () => {
		const { session, rec } = makeFakeSession({ sessionId: "abort-running", isStreaming: true });
		const deps = makeFakeDeps();
		const ps = new ProjectSession(session, deps);
		await ps.abort();
		assert.equal(rec.aborts, 1);
	});
});

describe("ProjectSession — model settings", () => {
	test("setModel rejects while streaming", async () => {
		const { session } = makeFakeSession({ sessionId: "model-streaming", isStreaming: true });
		const deps = makeFakeDeps();
		deps.models.set("anthropic/claude", { provider: "anthropic", id: "claude" });
		const ps = new ProjectSession(session, deps);
		await assert.rejects(() => ps.setModel("anthropic", "claude"), /while the agent is running/);
	});

	test("setModel rejects unknown model", async () => {
		const { session } = makeFakeSession({ sessionId: "model-unknown" });
		const deps = makeFakeDeps();
		const ps = new ProjectSession(session, deps);
		await assert.rejects(() => ps.setModel("bogus", "missing"), /not found/);
	});

	test("setModel applies thinking-level default when current level isn't supported by the new model", async () => {
		const { session, rec } = makeFakeSession({
			sessionId: "model-thinking-default",
			thinkingLevel: "high",
			availableThinkingLevels: ["off", "low", "medium"],
		});
		const deps = makeFakeDeps();
		const newModel = { provider: "anthropic", id: "haiku" };
		deps.models.set("anthropic/haiku", newModel);
		deps.defaultThinking.set("anthropic/haiku", "medium");
		const ps = new ProjectSession(session, deps);
		await ps.setModel("anthropic", "haiku");
		assert.equal(rec.setModelCalls.length, 1);
		assert.deepEqual(rec.setModelCalls[0], { provider: "anthropic", id: "haiku" });
		assert.deepEqual(rec.setThinkingLevelCalls, ["medium"]);
	});

	test("setThinkingLevel rejects while streaming", () => {
		const { session } = makeFakeSession({ sessionId: "thinking-streaming", isStreaming: true });
		const deps = makeFakeDeps();
		const ps = new ProjectSession(session, deps);
		assert.throws(() => ps.setThinkingLevel("high"), /while the agent is running/);
	});

	test("updateModelSettings applies model and thinking changes atomically", async () => {
		const { session, rec } = makeFakeSession({
			sessionId: "update-atomic",
			availableThinkingLevels: ["off", "low", "medium", "high"],
		});
		const deps = makeFakeDeps();
		deps.models.set("anthropic/sonnet", { provider: "anthropic", id: "sonnet" });
		const ps = new ProjectSession(session, deps);
		await ps.updateModelSettings({ provider: "anthropic", modelId: "sonnet", thinkingLevel: "high" });
		assert.equal(rec.setModelCalls.length, 1);
		assert.deepEqual(rec.setThinkingLevelCalls, ["high"]);
	});
});

describe("ProjectSession — extension UI dialog flow", () => {
	test("select returns the value when client responds, removes pending entry", async () => {
		const sessionId = "dialog-select";
		const { session, bindings } = makeFakeSession({ sessionId });
		const deps = makeFakeDeps();
		const ps = new ProjectSession(session, deps);
		await ps.extensionsReady;

		const ui = bindings()?.uiContext;
		assert.ok(ui, "uiContext was bound");
		const promise = ui!.select("Pick", ["A", "B"]);
		const pending = ps.pendingExtensionUiRequests();
		assert.equal(pending.length, 1);
		assert.equal(pending[0].method, "select");
		const requestId = pending[0].id;
		const accepted = ps.resolveExtensionUiRequest(requestId, { value: "A" });
		assert.equal(accepted, true);
		const result = await promise;
		assert.equal(result, "A");
		assert.equal(ps.pendingExtensionUiRequests().length, 0);
	});

	test("confirm returns false when client cancels", async () => {
		const sessionId = "dialog-cancel";
		const { session, bindings } = makeFakeSession({ sessionId });
		const deps = makeFakeDeps();
		const ps = new ProjectSession(session, deps);
		await ps.extensionsReady;

		const ui = bindings()?.uiContext;
		const promise = ui!.confirm("Are you sure?", "yes/no");
		const requestId = ps.pendingExtensionUiRequests()[0].id;
		ps.resolveExtensionUiRequest(requestId, { cancelled: true });
		const result = await promise;
		assert.equal(result, false);
	});

	test("input returns fallback when timeout fires", async () => {
		const sessionId = "dialog-timeout";
		const { session, bindings } = makeFakeSession({ sessionId });
		const deps = makeFakeDeps();
		const ps = new ProjectSession(session, deps);
		await ps.extensionsReady;

		const ui = bindings()?.uiContext;
		const result = await ui!.input("Name?", undefined, { timeout: 5 });
		assert.equal(result, undefined);
		assert.equal(ps.pendingExtensionUiRequests().length, 0);
	});

	test("input returns fallback when AbortSignal aborts", async () => {
		const sessionId = "dialog-abort";
		const { session, bindings } = makeFakeSession({ sessionId });
		const deps = makeFakeDeps();
		const ps = new ProjectSession(session, deps);
		await ps.extensionsReady;

		const controller = new AbortController();
		const ui = bindings()?.uiContext;
		const promise = ui!.input("Name?", undefined, { signal: controller.signal });
		controller.abort();
		const result = await promise;
		assert.equal(result, undefined);
		assert.equal(ps.pendingExtensionUiRequests().length, 0);
	});

	test("resolveExtensionUiRequest returns false for unknown request id", async () => {
		const { session } = makeFakeSession({ sessionId: "unknown-req" });
		const deps = makeFakeDeps();
		const ps = new ProjectSession(session, deps);
		await ps.extensionsReady;
		assert.equal(ps.resolveExtensionUiRequest("nonexistent", { value: "x" }), false);
	});

	test("two ProjectSessions don't cross-pollinate pending UI requests", async () => {
		// Regression: with separate pendingExtensionUi maps per session,
		// resolving session A's request must not affect session B's.
		const sessionA = "iso-A";
		const sessionB = "iso-B";
		const fakeA = makeFakeSession({ sessionId: sessionA });
		const fakeB = makeFakeSession({ sessionId: sessionB });
		const deps = makeFakeDeps();
		const psA = new ProjectSession(fakeA.session, deps);
		const psB = new ProjectSession(fakeB.session, deps);
		await psA.extensionsReady;
		await psB.extensionsReady;

		const promiseA = fakeA.bindings()!.uiContext!.confirm("A?", "ok");
		const promiseB = fakeB.bindings()!.uiContext!.confirm("B?", "ok");

		const reqA = psA.pendingExtensionUiRequests()[0].id;
		const reqB = psB.pendingExtensionUiRequests()[0].id;

		// Cross-resolve attempts should fail (session A doesn't know req B's id)
		assert.equal(psA.resolveExtensionUiRequest(reqB, { confirmed: true }), false);
		assert.equal(psB.resolveExtensionUiRequest(reqA, { confirmed: true }), false);

		// Both sessions still have their pending requests
		assert.equal(psA.pendingExtensionUiRequests().length, 1);
		assert.equal(psB.pendingExtensionUiRequests().length, 1);

		// Resolve correctly
		assert.equal(psA.resolveExtensionUiRequest(reqA, { confirmed: true }), true);
		assert.equal(psB.resolveExtensionUiRequest(reqB, { confirmed: false }), true);
		assert.equal(await promiseA, true);
		assert.equal(await promiseB, false);
	});
});

describe("ProjectSession — dispose", () => {
	test("cancels pending dialogs and unsubscribes", async () => {
		const sessionId = "dispose-1";
		const { session, bindings } = makeFakeSession({ sessionId });
		const deps = makeFakeDeps();
		const ps = new ProjectSession(session, deps);
		await ps.extensionsReady;

		const ui = bindings()?.uiContext;
		const promise = ui!.confirm("?", "?");
		assert.equal(ps.pendingExtensionUiRequests().length, 1);

		await ps.dispose();
		assert.equal(ps.pendingExtensionUiRequests().length, 0);
		const result = await promise;
		assert.equal(result, false, "confirm fallback on cancellation is false");
	});

	test("dispose is idempotent", async () => {
		const { session } = makeFakeSession({ sessionId: "dispose-idempotent" });
		const deps = makeFakeDeps();
		const ps = new ProjectSession(session, deps);
		await ps.extensionsReady;
		await ps.dispose();
		await ps.dispose();
		// no error thrown
	});
});
