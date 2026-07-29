/**
 * ProjectRuntime — pi SDK orchestrator scoped to one Appx project.
 *
 * Each app instantiates one runtime pointed at:
 *   - projectDir: the cwd handed to pi (skill discovery roots here, so
 *     `.pi/skills/` and `.agents/skills/` under projectDir are picked up)
 *   - sessionsDir: where pi writes session JSONL files. Defaults to
 *     `<projectDir>/.pi/sessions/` per Pi's project convention; callers
 *     may override for tests or non-conventional layouts. Sessions are
 *     first-class files: list reads from disk, getById lazily reopens
 *     any persisted session, createNew creates a new file.
 *
 * Owns:
 *   - one AgentSessionServices bundle (cwd-bound: ResourceLoader,
 *     SettingsManager, AuthStorage, ModelRegistry, diagnostics) shared
 *     across every session in this project — the bundle's
 *     ResourceLoader.reload() runs exactly once at project startup
 *     instead of once per session.
 *   - Map<sessionId, ProjectSession> of in-memory live sessions.
 *
 * Per-session operations (prompt, abort, model changes, extension-UI
 * routing) live on ProjectSession. Routes use the two-step lookup:
 *
 *     const session = await runtime.getSession(id);
 *     if (!session) return 404;
 *     await session.sendPrompt(text);
 *
 * Construction is async via `ProjectRuntime.create(config)` because
 * `createAgentSessionServices()` walks the filesystem to load
 * extensions/skills/themes once per project. See
 * docs/architecture/use-agent-session-services.md for the rationale.
 *
 * No module-level singletons — multiple apps in the same process (e.g. tests)
 * each get their own runtime with isolated state.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
	type AgentSession,
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	AuthStorage,
	type CreateAgentSessionOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
	type ExtensionFactory,
	getAgentDir,
	type ModelRegistry as ModelRegistryType,
	type SessionInfo,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentCredentialsService } from "../credentials/credentialsService.js";
import type { ThinkingLevel } from "../shared/thinking.js";
import { buildDeploymentPromptSection, type Deployment } from "./deployment.js";
import { ProjectSession } from "./projectSession.js";

type SessionModel = NonNullable<CreateAgentSessionOptions["model"]>;

export type {
	AgentAuthPrompt,
	AgentAuthProviderRow,
	AgentCustomProviderApi,
	AgentCustomProviderModel,
	AgentCustomProviderRow,
	AgentModelRow,
	AgentOAuthFlowState,
	UpsertCustomProviderRequest,
} from "../credentials/credentialsService.js";
export type {
	ExtensionUiRequest,
	ExtensionUiResponse,
} from "../shared/extensionUi.js";
export type { ThinkingLevel } from "../shared/thinking.js";
export type { SessionModelSettings } from "./projectSession.js";

/** Configuration for a single ProjectRuntime instance. */
export type ProjectRuntimeConfig = {
	/** Absolute path handed to pi as the session cwd. Skill discovery is rooted here. */
	projectDir: string;
	/**
	 * Absolute path where pi writes session JSONL files. Optional —
	 * defaults to `<projectDir>/.pi/sessions/` per Pi's project
	 * convention. Created if missing.
	 */
	sessionsDir?: string;
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
	 * Optional **explicit override** for the agent's system-prompt
	 * markdown file. When set, pi's built-in AGENTS.md / CLAUDE.md
	 * ancestor walk is disabled and only this file's contents are used
	 * as the system prompt. Relative paths are resolved against
	 * `projectDir`. **A missing file at an explicitly configured path is
	 * a fatal startup error** — misconfiguration is loud.
	 *
	 * When unset, the runtime falls back to the project convention:
	 * `<projectDir>/.pi/AGENTS.md` is loaded if present and silently
	 * skipped if absent. Both default and per-project runtimes share
	 * this rule, which is why we no longer need a separate
	 * "defaultAgentsFile: false" kill switch at the registry level.
	 *
	 * Why pinning matters: by default pi walks every ancestor of `cwd`
	 * looking for AGENTS.md / CLAUDE.md and concatenates them, which
	 * means an app's running agent inherits whatever developer notes
	 * happen to be lying around the repo. Either form (explicit or
	 * convention default) suppresses that walk.
	 */
	agentsFile?: string;
	/** Optional logger; defaults to console. */
	logger?: Pick<Console, "log" | "error">;
	/**
	 * Optional control-plane deployment metadata. When present, a generated
	 * "Deployment" section is appended to the resolved system prompt (after
	 * `.pi/AGENTS.md`, never replacing it) so the agent knows the DEV/PROD
	 * ports + URLs without reading a file.
	 */
	deployment?: Deployment;
	/**
	 * Container runtime the deploy skill + prompt reference (default `"podman"`).
	 * Env config, never hardcoded, so Stage 1 host dev (docker) and the nested
	 * outer container (podman) share one skill.
	 */
	appContainerRuntime?: string;
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

type ProjectRuntimeFields = {
	projectDir: string;
	sessionsDir: string;
	credentials: AgentCredentialsService;
	defaultModelProvider: string | undefined;
	defaultModelId: string | undefined;
	defaultThinkingLevel: ThinkingLevel | undefined;
	logger: Pick<Console, "log" | "error">;
};

export class ProjectRuntime {
	/** Process-global credentials service shared across all sibling runtimes. */
	readonly credentials: AgentCredentialsService;
	/**
	 * Pi's cwd-bound services bundle. Source of truth for AuthStorage,
	 * ModelRegistry, SettingsManager, ResourceLoader, agentDir, cwd, and
	 * non-fatal startup diagnostics. Shared across every session created
	 * by this runtime.
	 */
	readonly services: AgentSessionServices;

	private readonly projectDir: string;
	private readonly sessionsDir: string;
	private readonly defaultModelProvider: string | undefined;
	private readonly defaultModelId: string | undefined;
	private readonly defaultThinkingLevel: ThinkingLevel | undefined;
	private readonly logger: Pick<Console, "log" | "error">;
	private readonly sessions = new Map<string, ProjectSession>();

	/**
	 * Async factory. Builds the AgentSessionServices bundle (which runs
	 * `resourceLoader.reload()` once and registers extension-provided
	 * custom model providers into the shared modelRegistry) and
	 * constructs the runtime around it.
	 *
	 * Industry best practice: async work in a static factory rather than
	 * a constructor, since constructors can't be awaited and partially
	 * constructed objects are a footgun.
	 */
	static async create(config: ProjectRuntimeConfig): Promise<ProjectRuntime> {
		const projectDir = resolve(config.projectDir);
		const sessionsDir = resolveSessionsDir(config, projectDir);
		const agentDir = config.agentDir ? resolve(config.agentDir) : getAgentDir();
		const logger = config.logger ?? console;

		mkdirSync(sessionsDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		ensureProjectGitignore(projectDir, logger);

		// Read pinned system prompt up-front so we can both feed it into
		// the resource loader and suppress Pi's ancestor AGENTS.md walk.
		const { systemPrompt: agentsPrompt, agentsFilePath } = resolveSystemPrompt(config, projectDir, logger);

		// Append the generated Deployment section after .pi/AGENTS.md (never
		// replacing it) when the project carries control-plane metadata.
		const deploymentSection = buildDeploymentPromptSection(config.deployment, config.appContainerRuntime ?? "podman");
		const systemPrompt = composeSystemPrompt(agentsPrompt, deploymentSection);

		// Caller may share an AuthStorage across projects; otherwise build a
		// project-local one against the resolved agentDir so our auth.json
		// path matches every other runtime touching this agentDir.
		const authStorage = config.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));

		if (config.anthropicApiKey) {
			authStorage.setRuntimeApiKey("anthropic", config.anthropicApiKey);
			logger.log("[agent] runtime ANTHROPIC_API_KEY injected");
		} else if (!config.authStorage) {
			// Only log the fallback when we actually own the AuthStorage
			// — when callers share one, they're responsible for its source.
			logger.log(
				`[agent] no ANTHROPIC_API_KEY provided; relying on AuthStorage defaults (${join(agentDir, "auth.json")})`,
			);
		}

		// Build the services bundle. Pi creates ResourceLoader +
		// SettingsManager here, runs reload() exactly once, and registers
		// extension-provided custom providers into the (shared)
		// modelRegistry.
		const services = await createAgentSessionServices({
			cwd: projectDir,
			agentDir,
			authStorage,
			modelRegistry: config.modelRegistry,
			resourceLoaderOptions: {
				additionalExtensionPaths: config.extensionPaths,
				additionalSkillPaths: config.skillPaths,
				additionalPromptTemplatePaths: config.promptTemplatePaths,
				additionalThemePaths: config.themePaths,
				extensionFactories: config.extensionFactories,
				noExtensions: config.noExtensions,
				noSkills: config.noSkills,
				noPromptTemplates: config.noPromptTemplates,
				noThemes: config.noThemes,
				// When systemPrompt is pinned, suppress Pi's ancestor
				// AGENTS.md/CLAUDE.md walk so the agent's prompt is exactly
				// what the app intends and nothing else.
				noContextFiles: systemPrompt !== undefined,
				systemPrompt,
			},
		});

		if (agentsFilePath && systemPrompt !== undefined) {
			logger.log(`[agent] system prompt loaded from ${agentsFilePath} (${systemPrompt.length} chars)`);
		}

		// Apply caller's modelRegistry hook only if registry isn't shared.
		// Shared registries are configured once at the registry level so
		// we don't re-run the hook per project.
		if (!config.modelRegistry) {
			config.configureModelRegistry?.(services.modelRegistry);
		}

		// Surface non-fatal diagnostics from services creation. Errors are
		// logged but not thrown — matches the existing default-model auth
		// check below, which logs without aborting startup.
		for (const diagnostic of services.diagnostics) {
			const log = diagnostic.type === "error" ? logger.error : logger.log;
			log.call(logger, `[agent] ${diagnostic.type}: ${diagnostic.message}`);
		}

		// Validate the configured default model resolves & has auth.
		if (config.defaultModelProvider && config.defaultModelId) {
			const model = services.modelRegistry.find(config.defaultModelProvider, config.defaultModelId);
			if (!model) {
				logger.error(`[agent] default model not found: ${config.defaultModelProvider}/${config.defaultModelId}`);
			} else if (!services.modelRegistry.hasConfiguredAuth(model)) {
				logger.error(`[agent] auth is not configured for default model ${model.provider}/${model.id}`);
			} else {
				logger.log(`[agent] default model: ${model.provider}/${model.id}`);
			}
		}

		return new ProjectRuntime(
			{
				projectDir,
				sessionsDir,
				credentials: config.credentials,
				defaultModelProvider: config.defaultModelProvider,
				defaultModelId: config.defaultModelId,
				defaultThinkingLevel: config.defaultThinkingLevel,
				logger,
			},
			services,
		);
	}

	private constructor(fields: ProjectRuntimeFields, services: AgentSessionServices) {
		this.projectDir = fields.projectDir;
		this.sessionsDir = fields.sessionsDir;
		this.credentials = fields.credentials;
		this.defaultModelProvider = fields.defaultModelProvider;
		this.defaultModelId = fields.defaultModelId;
		this.defaultThinkingLevel = fields.defaultThinkingLevel;
		this.logger = fields.logger;
		this.services = services;
	}

	private sessionModelDefaults(): Pick<CreateAgentSessionOptions, "model" | "thinkingLevel"> {
		const defaults: Pick<CreateAgentSessionOptions, "model" | "thinkingLevel"> = {};
		if (this.defaultModelProvider && this.defaultModelId) {
			const model = this.services.modelRegistry.find(this.defaultModelProvider, this.defaultModelId) as
				| SessionModel
				| undefined;
			if (model) {
				defaults.model = model;
				const thinkingLevel = this.credentials.defaultThinkingForModel(model as SessionModel);
				if (thinkingLevel) defaults.thinkingLevel = thinkingLevel;
			}
		}
		if (!defaults.thinkingLevel && this.defaultThinkingLevel) {
			defaults.thinkingLevel = this.defaultThinkingLevel;
		}
		return defaults;
	}

	/** Wrap a freshly created/reopened AgentSession in a ProjectSession and remember it. */
	private adopt(session: AgentSession): ProjectSession {
		const ps = new ProjectSession(session, {
			credentials: this.credentials,
			modelRegistry: this.services.modelRegistry,
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
		const { session } = await createAgentSessionFromServices({
			services: this.services,
			sessionManager: SessionManager.create(this.projectDir, this.sessionsDir),
			...this.sessionModelDefaults(),
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

		const { session } = await createAgentSessionFromServices({
			services: this.services,
			sessionManager: SessionManager.open(info.path),
			...this.sessionModelDefaults(),
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

	/**
	 * Permanently delete a session: abort any in-flight run, tear down the
	 * in-memory ProjectSession (SSE listeners, pending extension UI), and
	 * remove its persisted JSONL file from disk.
	 *
	 * Returns true if a session existed (in memory or on disk) and was
	 * removed, false if no session with that id was found — letting the
	 * route map a miss to 404 while keeping the operation idempotent.
	 *
	 * Deletion is irreversible: session transcripts are volatile per-developer
	 * state (never committed to git), so there's no soft-delete tier here. The
	 * file removal uses `force: true` so a session that was created in memory
	 * but never flushed to disk doesn't surface a spurious ENOENT.
	 */
	async deleteSession(id: string): Promise<boolean> {
		const inMemory = this.sessions.get(id);
		if (inMemory) {
			// Stop any running agent turn before discarding the session so we
			// don't leave an orphaned LLM/tool run writing to a deleted file.
			await inMemory.abort();
			await inMemory.dispose();
			this.sessions.delete(id);
		}

		const list: SessionInfo[] = await SessionManager.list(this.projectDir, this.sessionsDir);
		const info = list.find((s) => s.id === id);
		if (info) {
			await rm(info.path, { force: true });
			return true;
		}

		// No file on disk — it existed only if we had it live in memory.
		return inMemory !== undefined;
	}

	// ── Resource refresh + diagnostics ───────────────────────────────

	/**
	 * Reload project resources (skills, extensions, prompts, themes,
	 * AGENTS.md context) from disk. Existing live sessions keep their
	 * already-bound extensions; only sessions created after this call
	 * see the new resources.
	 *
	 * Behaviour change vs. pre-services design: previously every
	 * createNewSession()/getSession() walked the filesystem afresh, so
	 * skill files added mid-session were picked up automatically. Now
	 * resources are snapshotted at project startup; call `reload()`
	 * explicitly to refresh them.
	 */
	async reload(): Promise<void> {
		await this.services.resourceLoader.reload();
	}

	/**
	 * Non-fatal issues collected during services creation (extension load
	 * errors, unknown extension flags, custom provider registration
	 * failures). Live reference to the services bundle's array — not a
	 * copy. Surface these to operators / API consumers as appropriate.
	 */
	diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this.services.diagnostics;
	}

	// ── Two-step session lookup is the only public API ──────────────
	//
	// All session-mutating operations live on ProjectSession. Routes do
	// `const ps = await runtime.getSession(id)` then call methods on the
	// returned ProjectSession directly (e.g. `await ps.sendPrompt(text)`).
	//
	// ProjectRuntime exposes only the project-level operations:
	// createNewSession, getSession, listSessions, reload, diagnostics.
}

/** Pi's project-tier directory under a project root. */
const PROJECT_PI_DIR = ".pi";
/**
 * Convention path for the per-project system prompt.
 *
 * (Used as the auto-`.gitignore` line below to guarantee session
 * transcripts never end up committed alongside AGENTS.md / skills /
 * extensions, which *do* belong in version control.)
 */
const CONVENTION_AGENTS_FILE = "AGENTS.md";
/** Convention path for per-project session JSONL storage. */
const CONVENTION_SESSIONS_DIR = "sessions";

/**
 * Idempotently write `<projectDir>/.pi/.gitignore` with a single
 * `sessions/` line on first runtime construction.
 *
 * Industry-standard pattern (Next.js writes `.next/.gitignore`, cargo
 * writes `target/.gitignore`, Hugging Face writes one inside
 * `~/.cache/huggingface/`): a tool that creates a directory inside
 * someone's project workspace is responsible for not leaking its own
 * volatile output into git.
 *
 * Why only `sessions/`:
 *   - `AGENTS.md`, `skills/`, `extensions/` are project resources that
 *     SHOULD be committed.
 *   - `settings.json` is debatable — left to the operator.
 *   - `sessions/` is conversation transcripts. Volume is unbounded,
 *     contents may include pasted code/API output, and they're
 *     volatile per-developer state. Never commit.
 *
 * Strict idempotency: only writes when `.gitignore` is missing. If the
 * operator has a custom `.gitignore` already we don't touch it —
 * surprise mutation of files in someone's workspace is worse than a
 * one-time setup step they can take themselves.
 *
 * Failures are logged and swallowed. A read-only filesystem or
 * permission error here must not block runtime creation — the runtime
 * is still functional without a `.gitignore`, the operator just needs
 * to add one manually.
 */
function ensureProjectGitignore(projectDir: string, logger: Pick<Console, "log" | "error">): void {
	const piDir = resolve(projectDir, PROJECT_PI_DIR);
	const gitignorePath = resolve(piDir, ".gitignore");
	if (existsSync(gitignorePath)) return;
	try {
		mkdirSync(piDir, { recursive: true });
		writeFileSync(
			gitignorePath,
			"# Auto-generated by @appx/agent-server. Safe to commit.\n" +
				"# Session transcripts are volatile per-developer state — never commit.\n" +
				`${CONVENTION_SESSIONS_DIR}/\n`,
			{ mode: 0o644 },
		);
		logger.log(`[agent] wrote ${gitignorePath} (sessions/ excluded from git)`);
	} catch (err) {
		logger.error(
			`[agent] failed to write ${gitignorePath}: ${String(err)} (continuing; consider adding 'sessions/' to .pi/.gitignore manually)`,
		);
	}
}

/**
 * Resolve where session JSONL files live for this runtime.
 *
 * Industry best practice followed here: convention over configuration.
 * Operators set `projectDir` and the layout is derived; the explicit
 * override exists only for tests and non-conventional deployments
 * (e.g. mounting sessions on a different volume via the config field).
 */
function resolveSessionsDir(config: ProjectRuntimeConfig, projectDir: string): string {
	if (config.sessionsDir) {
		return isAbsolute(config.sessionsDir) ? config.sessionsDir : resolve(projectDir, config.sessionsDir);
	}
	return resolve(projectDir, PROJECT_PI_DIR, CONVENTION_SESSIONS_DIR);
}

/**
 * Resolve the agent's system prompt with two-mode semantics:
 *
 *   1. Explicit override (`config.agentsFile` set): missing file is a
 *      **fatal** startup error. Preserves "misconfiguration is loud"
 *      for callers that explicitly point at a path.
 *   2. Convention default (`config.agentsFile` unset): falls back to
 *      `<projectDir>/.pi/AGENTS.md`. Loaded if present, silently
 *      skipped if absent — the runtime starts with no pinned prompt
 *      and Pi's normal context-file discovery proceeds. This replaces
 *      the old `defaultAgentsFile: false` kill switch by making
 *      "file not present" the natural no-prompt signal for both
 *      default and per-project runtimes.
 */
function resolveSystemPrompt(
	config: ProjectRuntimeConfig,
	projectDir: string,
	logger: Pick<Console, "log" | "error">,
): { systemPrompt: string | undefined; agentsFilePath: string | undefined } {
	if (config.agentsFile) {
		const path = isAbsolute(config.agentsFile) ? config.agentsFile : resolve(projectDir, config.agentsFile);
		try {
			const systemPrompt = readFileSync(path, "utf8");
			return { systemPrompt, agentsFilePath: path };
		} catch (err) {
			logger.error(`[agent] failed to read agentsFile ${path}: ${String(err)}`);
			throw err;
		}
	}

	const conventionPath = resolve(projectDir, PROJECT_PI_DIR, CONVENTION_AGENTS_FILE);
	if (!existsSync(conventionPath)) {
		return { systemPrompt: undefined, agentsFilePath: undefined };
	}
	const systemPrompt = readFileSync(conventionPath, "utf8");
	return { systemPrompt, agentsFilePath: conventionPath };
}

/**
 * Combine the resolved AGENTS.md prompt with the generated Deployment section.
 * The deployment section is appended after the project prompt, never replacing
 * it; either may be absent. Returns undefined when neither exists so the caller
 * preserves Pi's default context-file discovery.
 */
function composeSystemPrompt(
	agentsPrompt: string | undefined,
	deploymentSection: string | undefined,
): string | undefined {
	if (deploymentSection === undefined) return agentsPrompt;
	if (agentsPrompt === undefined) return deploymentSection;
	return `${agentsPrompt}\n\n${deploymentSection}`;
}
