/**
 * ProjectRuntime — pi SDK orchestrator scoped to one Appx project.
 *
 * Each app instantiates one runtime pointed at:
 *   - projectDir: the cwd handed to pi (skill discovery roots here, so
 *     `.pi/skills/` and `.agents/skills/` under projectDir are picked up)
 *   - sessionsDir: where pi writes session JSONL files (typically
 *     <appData>/sessions). Sessions are first-class files: list reads from
 *     disk, getById lazily reopens any persisted session, createNew creates
 *     a new file.
 *
 * Owns:
 *   - one AuthStorage + ModelRegistry, optionally shared by sibling runtimes
 *   - Map<sessionId, ProjectSession> of in-memory live sessions
 *
 * Per-session operations (prompt, abort, model changes, extension-UI
 * routing) live on ProjectSession. Routes use the two-step lookup:
 *
 *     const session = await runtime.getSession(id);
 *     if (!session) return 404;
 *     await session.sendPrompt(text);
 *
 * See docs/architecture/project-runtime-and-session-split.md for the
 * full split rationale.
 *
 * No module-level singletons — multiple apps in the same process (e.g. tests)
 * each get their own runtime with isolated state.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
	type AgentSession,
	AuthStorage,
	type CreateAgentSessionOptions,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	getAgentDir,
	ModelRegistry,
	type ModelRegistry as ModelRegistryType,
	SessionManager,
	type SessionInfo,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ProjectSession } from "./projectSession.js";
import { type ThinkingLevel } from "./thinking.js";
import { AgentCredentialsService } from "./credentialsService.js";

type SessionModel = NonNullable<CreateAgentSessionOptions["model"]>;

export type { ExtensionUiRequest, ExtensionUiResponse } from "./extensionUi.js";
export type { SessionModelSettings } from "./projectSession.js";
export type { ThinkingLevel } from "./thinking.js";
export type {
	AgentAuthPrompt,
	AgentAuthProviderRow,
	AgentCustomProviderApi,
	AgentCustomProviderModel,
	AgentCustomProviderRow,
	AgentModelRow,
	AgentOAuthFlowState,
	UpsertCustomProviderRequest,
} from "./credentialsService.js";

/** Configuration for a single ProjectRuntime instance. */
export type ProjectRuntimeConfig = {
	/** Absolute path handed to pi as the session cwd. Skill discovery is rooted here. */
	projectDir: string;
	/** Absolute path where pi writes session JSONL files. Created if missing. */
	sessionsDir: string;
	/** Optional pi agent config dir. Defaults to Pi's standard ~/.pi/agent. */
	agentDir?: string;
	/** Process-global credentials service shared with sibling runtimes. */
	credentials: AgentCredentialsService;
	/** Optional shared Pi auth storage. Used by multi-project hosts. */
	authStorage?: AuthStorage;
	/** Optional shared model registry. Used by multi-project hosts. */
	modelRegistry?: ModelRegistryType;
	/**
	 * Optional Anthropic API key to inject into AuthStorage at runtime. If
	 * unset, the runtime falls back to whatever's in `~/.pi/agent/auth.json`
	 * (typical for local dev).
	 */
	anthropicApiKey?: string;
	/** Hook for app-specific dynamic model/provider registration before session model selection. */
	configureModelRegistry?: (modelRegistry: ModelRegistryType) => void;
	/** Optional explicit default model provider/id to pass into createAgentSession before Pi selects defaults. */
	defaultModelProvider?: string;
	defaultModelId?: string;
	/** Optional global fallback thinking level paired with defaultModelProvider/defaultModelId. */
	defaultThinkingLevel?: ThinkingLevel;
	/** Optional per-model thinking defaults keyed as `${provider}/${modelId}`. */
	modelThinkingDefaults?: Record<string, ThinkingLevel>;
	/**
	 * Extra Pi extension/package sources to load as temporary extensions.
	 * Supports local paths plus Pi package sources such as npm:<pkg> and git:<repo>.
	 */
	extensionPaths?: string[];
	/** Extra Pi skill file/directory paths to load for this runtime. */
	skillPaths?: string[];
	/** Extra Pi prompt template file/directory paths to load for this runtime. */
	promptTemplatePaths?: string[];
	/** Extra Pi theme file/directory paths to load for this runtime. */
	themePaths?: string[];
	/** Inline extension factories, mostly useful for tests and embedded hosts. */
	extensionFactories?: ExtensionFactory[];
	/** Disable project/global extension discovery while still allowing extensionPaths/factories. */
	noExtensions?: boolean;
	/** Disable project/global skill discovery while still allowing extension-provided resources. */
	noSkills?: boolean;
	/** Disable project/global prompt template discovery. */
	noPromptTemplates?: boolean;
	/** Disable project/global theme discovery. */
	noThemes?: boolean;
	/**
	 * Optional explicit path to the agent's system-prompt markdown file
	 * (typically `AGENTS.md` per the App Anatomy spec). When set, pi's
	 * built-in AGENTS.md / CLAUDE.md auto-discovery is disabled and only
	 * this file's contents are used as the system prompt. Relative paths
	 * are resolved against `projectDir`.
	 *
	 * Why this matters: by default pi walks every ancestor of `cwd`
	 * looking for AGENTS.md / CLAUDE.md and concatenates them, which
	 * means an app's running agent inherits whatever developer notes
	 * happen to be lying around the repo. Pin the path explicitly so the
	 * agent's prompt is exactly what the app intends.
	 */
	agentsFile?: string;
	/** Optional logger; defaults to console. */
	logger?: Pick<Console, "log" | "error">;
};

/**
 * Listing view returned by GET /api/sessions. Stable across apps — the
 * eventx-frontend chat reducer (and any future app's UI) consume this shape.
 */
export type SessionRow = {
	id: string;
	createdAt: string;
	firstMessage: string;
	messageCount: number;
};

export class ProjectRuntime {
	private readonly projectDir: string;
	private readonly sessionsDir: string;
	private readonly agentDir: string;
	private readonly credentials: AgentCredentialsService;
	private readonly authStorage: AuthStorage;
	private readonly modelRegistry: ModelRegistry;
	private readonly logger: Pick<Console, "log" | "error">;
	private readonly defaultModelProvider: string | undefined;
	private readonly defaultModelId: string | undefined;
	private readonly defaultThinkingLevel: ThinkingLevel | undefined;
	private readonly extensionPaths: string[];
	private readonly skillPaths: string[];
	private readonly promptTemplatePaths: string[];
	private readonly themePaths: string[];
	private readonly extensionFactories: ExtensionFactory[];
	private readonly noExtensions: boolean;
	private readonly noSkills: boolean;
	private readonly noPromptTemplates: boolean;
	private readonly noThemes: boolean;
	private readonly sessions = new Map<string, ProjectSession>();
	/** Resolved absolute path to the agent's system-prompt file, if pinned. */
	private readonly agentsFile: string | undefined;
	/** Cached system-prompt content, read once at construction. */
	private readonly systemPrompt: string | undefined;

	constructor(config: ProjectRuntimeConfig) {
		this.projectDir = config.projectDir;
		this.sessionsDir = config.sessionsDir;
		this.agentDir = config.agentDir ?? getAgentDir();
		this.logger = config.logger ?? console;
		this.defaultModelProvider = config.defaultModelProvider;
		this.defaultModelId = config.defaultModelId;
		this.defaultThinkingLevel = config.defaultThinkingLevel;
		this.extensionPaths = config.extensionPaths ?? [];
		this.skillPaths = config.skillPaths ?? [];
		this.promptTemplatePaths = config.promptTemplatePaths ?? [];
		this.themePaths = config.themePaths ?? [];
		this.extensionFactories = config.extensionFactories ?? [];
		this.noExtensions = config.noExtensions ?? false;
		this.noSkills = config.noSkills ?? false;
		this.noPromptTemplates = config.noPromptTemplates ?? false;
		this.noThemes = config.noThemes ?? false;
		mkdirSync(this.sessionsDir, { recursive: true });
		mkdirSync(this.agentDir, { recursive: true });

		this.credentials = config.credentials;
		this.authStorage = config.authStorage ?? AuthStorage.create(join(this.agentDir, "auth.json"));

		if (config.agentsFile) {
			const path = isAbsolute(config.agentsFile)
				? config.agentsFile
				: resolve(this.projectDir, config.agentsFile);
			try {
				this.systemPrompt = readFileSync(path, "utf8");
				this.agentsFile = path;
				this.logger.log(
					`[agent] system prompt loaded from ${path} (${this.systemPrompt.length} chars)`,
				);
			} catch (err) {
				this.logger.error(`[agent] failed to read agentsFile ${path}: ${String(err)}`);
				throw err;
			}
		}

		if (config.anthropicApiKey) {
			this.authStorage.setRuntimeApiKey("anthropic", config.anthropicApiKey);
			this.logger.log("[agent] runtime ANTHROPIC_API_KEY injected");
		} else {
			this.logger.log(
				`[agent] no ANTHROPIC_API_KEY provided; relying on AuthStorage defaults (${join(this.agentDir, "auth.json")})`,
			);
		}

		this.modelRegistry = config.modelRegistry ?? ModelRegistry.create(this.authStorage);
		if (!config.modelRegistry) config.configureModelRegistry?.(this.modelRegistry);

		if (this.defaultModelProvider && this.defaultModelId) {
			const model = this.modelRegistry.find(this.defaultModelProvider, this.defaultModelId);
			if (!model) {
				this.logger.error(
					`[agent] default model not found: ${this.defaultModelProvider}/${this.defaultModelId}`,
				);
			} else if (!this.modelRegistry.hasConfiguredAuth(model)) {
				this.logger.error(`[agent] auth is not configured for default model ${model.provider}/${model.id}`);
			} else {
				this.logger.log(`[agent] default model: ${model.provider}/${model.id}`);
			}
		}
	}

	private sessionModelDefaults(): Pick<CreateAgentSessionOptions, "model" | "thinkingLevel"> {
		const defaults: Pick<CreateAgentSessionOptions, "model" | "thinkingLevel"> = {};
		if (this.defaultModelProvider && this.defaultModelId) {
			const model = this.modelRegistry.find(this.defaultModelProvider, this.defaultModelId) as
				| SessionModel
				| undefined;
			if (model) {
				defaults.model = model;
				const thinkingLevel = this.credentials.defaultThinkingForModel(model as SessionModel);
				if (thinkingLevel) defaults.thinkingLevel = thinkingLevel;
			}
		}
		if (!defaults.thinkingLevel && this.defaultThinkingLevel) defaults.thinkingLevel = this.defaultThinkingLevel;
		return defaults;
	}

	/**
	 * Build a fresh DefaultResourceLoader configured with our pinned
	 * system-prompt file, if any. Pi's SDK constructs a default loader
	 * (with full ancestor AGENTS.md/CLAUDE.md discovery) when none is
	 * passed, so we always pass our own to keep behaviour deterministic.
	 * A new loader per session is fine — pi creates one anyway.
	 */
	private async makeResourceLoader(): Promise<DefaultResourceLoader> {
		const settingsManager = SettingsManager.create(this.projectDir, this.agentDir);
		const loader = new DefaultResourceLoader({
			cwd: this.projectDir,
			agentDir: this.agentDir,
			settingsManager,
			additionalExtensionPaths: this.extensionPaths,
			additionalSkillPaths: this.skillPaths,
			additionalPromptTemplatePaths: this.promptTemplatePaths,
			additionalThemePaths: this.themePaths,
			extensionFactories: this.extensionFactories,
			noExtensions: this.noExtensions,
			noSkills: this.noSkills,
			noPromptTemplates: this.noPromptTemplates,
			noThemes: this.noThemes,
			// When we have an explicit agentsFile, suppress all ancestor-walk
			// AGENTS.md/CLAUDE.md discovery and feed our content via
			// systemPrompt instead.
			noContextFiles: this.systemPrompt !== undefined,
			systemPrompt: this.systemPrompt,
		});
		await loader.reload();
		return loader;
	}

	/** Wrap a freshly created/reopened AgentSession in a ProjectSession and remember it. */
	private adopt(session: AgentSession): ProjectSession {
		const ps = new ProjectSession(session, {
			credentials: this.credentials,
			modelRegistry: this.modelRegistry,
			logger: this.logger,
		});
		this.sessions.set(ps.sessionId, ps);
		return ps;
	}

	// ── Session collection ───────────────────────────────────────────

	/**
	 * Create a brand-new session. Pi writes a new JSONL file under
	 * sessionsDir on first message_end. Returns the bound ProjectSession
	 * so callers can immediately act on it (subscribe to events, send a
	 * first prompt, list pending extension UI requests).
	 */
	async createNewSession(): Promise<ProjectSession> {
		const { session } = await createAgentSession({
			...this.sessionModelDefaults(),
			authStorage: this.authStorage,
			modelRegistry: this.modelRegistry,
			sessionManager: SessionManager.create(this.projectDir, this.sessionsDir),
			resourceLoader: await this.makeResourceLoader(),
		});
		return this.adopt(session);
	}

	/**
	 * Get a live ProjectSession by id, lazily reopening from disk if not in
	 * memory. Returns null if no session file exists with that id.
	 */
	async getSession(id: string): Promise<ProjectSession | null> {
		const existing = this.sessions.get(id);
		if (existing) return existing;

		const sessions = await SessionManager.list(this.projectDir, this.sessionsDir);
		const info = sessions.find((s) => s.id === id);
		if (!info) return null;

		const { session } = await createAgentSession({
			...this.sessionModelDefaults(),
			authStorage: this.authStorage,
			modelRegistry: this.modelRegistry,
			sessionManager: SessionManager.open(info.path),
			resourceLoader: await this.makeResourceLoader(),
		});
		return this.adopt(session);
	}

	/**
	 * List all sessions, merging two sources of truth:
	 *   1. Persisted sessions on disk (SessionManager.list)
	 *   2. Live in-memory sessions not yet flushed to disk (newly created,
	 *      no prompts yet — pi writes the file lazily on first message)
	 *
	 * Disk metadata wins when both exist. Sorted newest-first.
	 */
	async listSessions(): Promise<SessionRow[]> {
		const list: SessionInfo[] = await SessionManager.list(this.projectDir, this.sessionsDir);
		const onDisk = new Set(list.map((s) => s.id));

		const rows: SessionRow[] = list.map((info) => ({
			id: info.id,
			createdAt: info.created.toISOString(),
			firstMessage: info.firstMessage ?? "",
			messageCount: info.messageCount,
		}));

		for (const [id, ps] of this.sessions) {
			if (onDisk.has(id)) continue;
			const messages = ps.session.state.messages as Array<{
				role: string;
				content: Array<{ type: string; text?: string }>;
			}>;
			const firstUser = messages.find((m) => m.role === "user");
			const firstText = firstUser?.content.find((c) => c.type === "text")?.text ?? "";
			rows.push({
				id,
				createdAt: ps.boundAt,
				firstMessage: firstText,
				messageCount: messages.length,
			});
		}

		return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	// ── Two-step session lookup is the only public API ──────────────
	//
	// All session-mutating operations live on ProjectSession. Routes do
	// `const ps = await runtime.getSession(id)` then call methods on the
	// returned ProjectSession directly (e.g. `await ps.sendPrompt(text)`).
	//
	// AgentRuntime exposes only the project-level operations: createNewSession,
	// getSession, listSessions.
}
