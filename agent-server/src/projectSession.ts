/**
 * ProjectSession — owns one AgentSession plus all per-session concerns:
 * SSE event publishing, extension binding, ExtensionUIContext implementation,
 * extension UI request/response routing, and the per-session operations
 * (prompt, abort, model/thinking changes, message reads).
 *
 * Lifecycle: instantiated by ProjectRuntime (currently AgentRuntime, pre-rename)
 * when a session is first bound — created via createNewSession or lazily reopened
 * via getSession. The constructor immediately subscribes to AgentSession events
 * (forwarding to the SSE broker keyed by sessionId) and kicks off bindExtensions.
 * Callers can `await extensionsReady` before issuing the first prompt to ensure
 * extension `session_start` handlers have run.
 *
 * Why split from AgentRuntime: every ExtensionUIContext method, every
 * pendingExtensionUi entry, and every session-mutating call (prompt, abort,
 * setModel, ...) is intrinsically session-scoped. Threading sessionId through
 * AgentRuntime methods (createExtensionUiContext(sessionId), pendingExtensionUiRequests(id),
 * resolveExtensionUiRequest(id, requestId, response)) was a sign that those
 * concerns belong on a per-session class. See
 * docs/architecture/project-runtime-and-session-split.md for the full rationale.
 *
 * What it does NOT do: project-level concerns. It doesn't read project paths,
 * doesn't manage the session collection, doesn't construct AgentSessions —
 * those stay on ProjectRuntime, which constructs ProjectSession instances and
 * passes in the AgentSession plus the small dependency bundle this class needs.
 */

import { randomUUID } from "node:crypto";
import type {
	AgentSession,
	AgentSessionEvent,
	CreateAgentSessionOptions,
	ExtensionCommandContextActions,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { AgentCredentialsService, AgentModelRow } from "./credentialsService.js";
import type { ExtensionUiRequest, ExtensionUiResponse } from "./extensionUi.js";
import { publish } from "./sseBroker.js";
import {
	type ThinkingLevel,
	supportedThinkingLevelsForModel,
} from "./thinking.js";

type SessionModel = NonNullable<CreateAgentSessionOptions["model"]>;

export type SessionModelSettings = {
	model: AgentModelRow | null;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	supportsThinking: boolean;
	isStreaming: boolean;
};

/** Pending extension-UI request awaiting client response. */
type PendingExtensionUiRequest = {
	request: ExtensionUiRequest;
	resolve: (response: ExtensionUiResponse) => void;
	timer?: ReturnType<typeof setTimeout>;
	abort?: () => void;
};

/**
 * Project-scoped dependencies a ProjectSession needs from its owning
 * ProjectRuntime: how to resolve model rows, how to look up models by
 * provider/id, and where to log non-fatal errors. We pass them in instead of
 * giving ProjectSession a reference to ProjectRuntime so ProjectSession is
 * unit-testable in isolation with a tiny stub deps object.
 */
export type ProjectSessionDeps = {
	credentials: AgentCredentialsService;
	modelRegistry: Pick<ModelRegistry, "find">;
	logger: Pick<Console, "log" | "error">;
};

export class ProjectSession {
	readonly session: AgentSession;
	readonly sessionId: string;
	/** When this session was first bound. Fallback createdAt for sessions not yet flushed to disk. */
	readonly boundAt: string;
	/**
	 * Resolves once Pi's bindExtensions() has finished. sendPrompt() awaits
	 * this so the first prompt sees fully-initialized extensions; SSE
	 * subscribers don't need to wait for it because events stream as soon as
	 * they're emitted, regardless of bind completion.
	 */
	readonly extensionsReady: Promise<void>;

	private readonly deps: ProjectSessionDeps;
	private readonly pendingExtensionUi = new Map<string, PendingExtensionUiRequest>();
	private readonly unsubscribeEvents: () => void;
	private disposed = false;

	constructor(session: AgentSession, deps: ProjectSessionDeps) {
		this.session = session;
		this.sessionId = session.sessionId;
		this.deps = deps;
		this.boundAt = new Date().toISOString();

		// Per-session SSE bridge. The broker routes events by sessionId so
		// concurrent sessions in the same project don't cross-talk.
		this.unsubscribeEvents = session.subscribe((event: AgentSessionEvent) => {
			publish(this.sessionId, event);
		});

		// Bind extensions with a session-scoped UI context. We keep the promise
		// so callers (sendPrompt) can await it before issuing prompts.
		this.extensionsReady = session
			.bindExtensions({
				uiContext: this.createExtensionUiContext(),
				commandContextActions: this.commandActions(),
				onError: (err) => {
					publish(this.sessionId, {
						type: "extension_error",
						extensionPath: err.extensionPath,
						event: err.event,
						error: err.error,
						stack: err.stack,
					});
					this.deps.logger.error(
						`[agent] extension error in ${err.extensionPath}: ${err.error}`,
					);
				},
			})
			.catch((err) => {
				const message = err instanceof Error ? err.message : String(err);
				publish(this.sessionId, {
					type: "extension_error",
					extensionPath: "<bindExtensions>",
					event: "session_start",
					error: message,
				});
				this.deps.logger.error(
					`[agent] extension binding failed for ${this.sessionId}: ${message}`,
				);
			});
	}

	// ── Session reads ────────────────────────────────────────────────

	/** Persisted message history for this session, used to populate the chat UI on reopen. */
	getMessages(): unknown[] {
		return this.session.state.messages;
	}

	getModelSettings(): SessionModelSettings {
		return {
			model: this.session.model
				? this.deps.credentials.modelRow(this.session.model as SessionModel)
				: null,
			thinkingLevel: this.session.thinkingLevel as ThinkingLevel,
			availableThinkingLevels: this.session.getAvailableThinkingLevels() as ThinkingLevel[],
			supportsThinking: this.session.supportsThinking(),
			isStreaming: this.session.isStreaming,
		};
	}

	// ── Session writes ───────────────────────────────────────────────

	async setModel(provider: string, modelId: string): Promise<SessionModelSettings> {
		if (this.session.isStreaming) {
			throw new Error("Cannot change model while the agent is running");
		}
		const model = this.deps.modelRegistry.find(provider, modelId) as
			| SessionModel
			| undefined;
		if (!model) throw new Error(`model ${provider}/${modelId} not found`);
		await this.applyModel(model);
		return this.getModelSettings();
	}

	setThinkingLevel(level: ThinkingLevel): SessionModelSettings {
		if (this.session.isStreaming) {
			throw new Error("Cannot change thinking level while the agent is running");
		}
		this.session.setThinkingLevel(level);
		return this.getModelSettings();
	}

	async updateModelSettings(settings: {
		provider?: string;
		modelId?: string;
		thinkingLevel?: ThinkingLevel;
	}): Promise<SessionModelSettings> {
		if (this.session.isStreaming) {
			throw new Error("Cannot change model settings while the agent is running");
		}
		if (settings.provider && settings.modelId) {
			const model = this.deps.modelRegistry.find(settings.provider, settings.modelId) as
				| SessionModel
				| undefined;
			if (!model) {
				throw new Error(`model ${settings.provider}/${settings.modelId} not found`);
			}
			await this.applyModel(model);
		}
		if (settings.thinkingLevel) this.session.setThinkingLevel(settings.thinkingLevel);
		return this.getModelSettings();
	}

	/**
	 * Send a user prompt. Events flow over SSE to subscribers. Returns once
	 * the prompt has been queued; the agent runs asynchronously.
	 */
	async sendPrompt(text: string): Promise<void> {
		await this.extensionsReady;
		if (this.session.isStreaming) {
			// While the agent is streaming, prompt() requires a streamingBehavior.
			// "steer" queues the message for delivery as soon as the current
			// assistant turn's tool calls finish — i.e. it actually interrupts
			// the agent's plan rather than waiting for it to fully stop
			// ("followUp"). Equivalent to session.steer(text).
			await this.session.prompt(text, { streamingBehavior: "steer" });
			return;
		}
		await this.session.prompt(text);
	}

	/**
	 * Abort the current operation (the agent's in-flight LLM call and any
	 * running tool). Resolves once Pi has torn the run down; the session
	 * stays usable — subsequent prompts work normally. No-op if not streaming.
	 */
	async abort(): Promise<void> {
		if (!this.session.isStreaming) return;
		await this.session.abort();
	}

	// ── Extension UI request routing ─────────────────────────────────

	pendingExtensionUiRequests(): ExtensionUiRequest[] {
		return Array.from(this.pendingExtensionUi.values()).map((entry) => entry.request);
	}

	resolveExtensionUiRequest(
		requestId: string,
		response: ExtensionUiResponse,
	): boolean {
		const pending = this.pendingExtensionUi.get(requestId);
		if (!pending) return false;
		pending.resolve(response);
		return true;
	}

	// ── Lifecycle ────────────────────────────────────────────────────

	/**
	 * Tear down per-session resources: unsubscribe from session events and
	 * cancel any pending extension UI requests (they resolve with cancelled).
	 * Currently unused in production — sessions live for the lifetime of the
	 * runtime — but kept so tests can clean up listeners and so future idle
	 * eviction has a clean hook.
	 */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribeEvents();
		for (const pending of this.pendingExtensionUi.values()) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.abort?.();
			pending.resolve({ cancelled: true });
		}
		this.pendingExtensionUi.clear();
	}

	// ── Private ──────────────────────────────────────────────────────

	/**
	 * Apply a new model to the session, plus a thinking-level adjustment if
	 * the new model doesn't support the current level. We use the credentials
	 * service to find a sensible default for the new model.
	 */
	private async applyModel(model: SessionModel): Promise<void> {
		const currentThinkingLevel = this.session.thinkingLevel as ThinkingLevel;
		const nextAvailableLevels = supportedThinkingLevelsForModel(model);
		const defaultThinkingLevel = this.deps.credentials.defaultThinkingForModel(model);
		const shouldUseModelDefault = Boolean(
			defaultThinkingLevel && !nextAvailableLevels.includes(currentThinkingLevel),
		);
		await this.session.setModel(model);
		if (shouldUseModelDefault && this.session.thinkingLevel !== defaultThinkingLevel) {
			this.session.setThinkingLevel(defaultThinkingLevel!);
		}
	}

	/**
	 * Command-context actions Pi extensions can invoke. Most session-lifecycle
	 * actions (newSession, fork, navigateTree, switchSession) are stubbed to
	 * `cancelled: true` because agent-server doesn't support those flows —
	 * its multi-session model exposes session creation/switching at the HTTP
	 * layer, not via in-session extension calls.
	 */
	private commandActions(): ExtensionCommandContextActions {
		return {
			waitForIdle: () => this.session.agent.waitForIdle(),
			newSession: async () => ({ cancelled: true }),
			fork: async () => ({ cancelled: true }),
			navigateTree: async () => ({ cancelled: true }),
			switchSession: async () => ({ cancelled: true }),
			reload: async () => {
				await this.session.reload();
			},
		};
	}

	/**
	 * Build a session-scoped ExtensionUIContext. The `sessionId` is captured
	 * via `this`, so request-routing happens transparently — every dialog,
	 * notification, and widget update lands in this session's pending map and
	 * publishes to this session's SSE channel.
	 *
	 * Pattern adapted from Pi's RPC mode (rpc-mode.ts), which does the same
	 * for stdin/stdout. The structure is identical aside from the implicit
	 * `this.sessionId` routing replacing RPC's "current session" closure.
	 */
	private createExtensionUiContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) =>
				this.dialog(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
					"cancelled" in r ? undefined : "value" in r ? r.value : undefined,
				),
			confirm: (title, message, opts) =>
				this.dialog(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
					"cancelled" in r ? false : "confirmed" in r ? r.confirmed : false,
				),
			input: (title, placeholder, opts) =>
				this.dialog(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
					"cancelled" in r ? undefined : "value" in r ? r.value : undefined,
				),
			editor: (title, prefill) =>
				this.dialog(undefined, undefined, { method: "editor", title, prefill }, (r) =>
					"cancelled" in r ? undefined : "value" in r ? r.value : undefined,
				),
			notify: (message, type) =>
				this.publishRequest({
					type: "extension_ui_request",
					id: randomUUID(),
					method: "notify",
					message,
					notifyType: type,
				}),
			onTerminalInput: () => () => {},
			setStatus: (key, text) =>
				this.publishRequest({
					type: "extension_ui_request",
					id: randomUUID(),
					method: "setStatus",
					statusKey: key,
					statusText: text,
				}),
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: ((
				key: string,
				content: string[] | ((...args: unknown[]) => unknown) | undefined,
				options?: ExtensionWidgetOptions,
			) => {
				if (content !== undefined && !Array.isArray(content)) return;
				this.publishRequest({
					type: "extension_ui_request",
					id: randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content,
					widgetPlacement: options?.placement,
				});
			}) as ExtensionUIContext["setWidget"],
			setFooter: () => {},
			setHeader: () => {},
			setTitle: (title) =>
				this.publishRequest({
					type: "extension_ui_request",
					id: randomUUID(),
					method: "setTitle",
					title,
				}),
			custom: async () => undefined as never,
			pasteToEditor: (text) =>
				this.publishRequest({
					type: "extension_ui_request",
					id: randomUUID(),
					method: "set_editor_text",
					text,
				}),
			setEditorText: (text) =>
				this.publishRequest({
					type: "extension_ui_request",
					id: randomUUID(),
					method: "set_editor_text",
					text,
				}),
			getEditorText: () => "",
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			get theme() {
				return undefined as never;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({
				success: false,
				error: "UI theme switching is not available in agent-server",
			}),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}

	/**
	 * Promise-based dialog flow with timeout and AbortSignal support.
	 *
	 * Adapted from Pi's RPC mode `createDialogPromise` helper. Differences:
	 *   1. No sessionId argument — `this.sessionId` is captured implicitly.
	 *   2. Publishes via SSE broker instead of stdout JSON lines.
	 *
	 * Caller responsibility:
	 *   - Pass `fallback` matching the dialog's "cancelled" return (e.g. false
	 *     for confirm, undefined for select/input/editor). The fallback is
	 *     also returned on timeout and on abort-signal triggering.
	 *   - `mapResponse` translates the wire ExtensionUiResponse into the
	 *     domain return type expected by the calling extension API.
	 */
	private dialog<T>(
		opts: ExtensionUIDialogOptions | undefined,
		fallback: T,
		request: Record<string, unknown>,
		mapResponse: (response: ExtensionUiResponse) => T,
	): Promise<T> {
		const id = randomUUID();
		const event = { type: "extension_ui_request" as const, id, ...request } as ExtensionUiRequest;

		return new Promise<T>((resolve) => {
			const finish = (response: ExtensionUiResponse) => {
				const pending = this.pendingExtensionUi.get(id);
				if (!pending) return;
				if (pending.timer) clearTimeout(pending.timer);
				pending.abort?.();
				this.pendingExtensionUi.delete(id);
				resolve(mapResponse(response));
			};

			const pending: PendingExtensionUiRequest = {
				request: event,
				resolve: finish,
			};

			if (opts?.timeout && opts.timeout > 0) {
				pending.timer = setTimeout(() => finish({ cancelled: true }), opts.timeout);
			}

			if (opts?.signal) {
				const onAbort = () => finish({ cancelled: true });
				opts.signal.addEventListener("abort", onAbort, { once: true });
				pending.abort = () => opts.signal?.removeEventListener("abort", onAbort);
			}

			this.pendingExtensionUi.set(id, pending);
			this.publishRequest(event);

			// fallback only used by linter; route closures use it via the
			// timeout/signal paths above. Mark as referenced.
			void fallback;
		});
	}

	private publishRequest(request: ExtensionUiRequest): void {
		publish(this.sessionId, request);
	}
}
