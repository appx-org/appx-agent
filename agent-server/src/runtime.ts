/**
 * AgentRuntime — pi SDK orchestrator scoped to one Appx project.
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
 *   - Map<sessionId, LiveSession> of in-memory live sessions
 *   - subscription bridge: every AgentSessionEvent → publish(sessionId, event)
 *
 * No module-level singletons — multiple apps in the same process (e.g. tests)
 * each get their own runtime with isolated state.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  AuthStorage,
  type CreateAgentSessionOptions,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionCommandContextActions,
  type ExtensionFactory,
  type ExtensionUIDialogOptions,
  type ExtensionUIContext,
  type ExtensionWidgetOptions,
  getAgentDir,
  ModelRegistry,
  type ModelRegistry as ModelRegistryType,
  SessionManager,
  type SessionInfo,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { publish } from "./sseBroker.js";

type SessionModel = NonNullable<CreateAgentSessionOptions["model"]>;
export type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const CUSTOM_PROVIDER_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;

export type AgentCustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number];

/** Configuration for a single AgentRuntime instance. */
export type AgentRuntimeConfig = {
  /** Absolute path handed to pi as the session cwd. Skill discovery is rooted here. */
  projectDir: string;
  /** Absolute path where pi writes session JSONL files. Created if missing. */
  sessionsDir: string;
  /** Optional pi agent config dir. Defaults to Pi's standard ~/.pi/agent. */
  agentDir?: string;
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

export type AgentModelRow = {
  provider: string;
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  available: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  defaultThinkingLevel?: ThinkingLevel;
};

export type AgentAuthProviderRow = {
  provider: string;
  name: string;
  configured: boolean;
  credentialType?: "api_key" | "oauth";
  source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
  label?: string;
  supportsApiKey: boolean;
  supportsSubscription: boolean;
  modelCount: number;
  availableModelCount: number;
};

export type AgentAuthPrompt = {
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
};

export type AgentOAuthFlowState = {
  id: string;
  provider: string;
  providerName: string;
  status: "starting" | "prompt" | "auth" | "waiting" | "complete" | "error" | "cancelled";
  authUrl?: string;
  instructions?: string;
  prompt?: AgentAuthPrompt;
  progress: string[];
  error?: string;
  expiresAt: string;
};

export type AgentCustomProviderModel = {
  id: string;
  name?: string;
  api?: AgentCustomProviderApi;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
};

export type AgentCustomProviderRow = {
  provider: string;
  name?: string;
  baseUrl?: string;
  api?: AgentCustomProviderApi;
  apiKeyConfigured: boolean;
  modelCount: number;
  models: AgentCustomProviderModel[];
};

export type UpsertCustomProviderRequest = {
  provider: string;
  name?: string;
  baseUrl: string;
  api: AgentCustomProviderApi;
  apiKey?: string;
  models: AgentCustomProviderModel[];
};

export type SessionModelSettings = {
  model: AgentModelRow | null;
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: ThinkingLevel[];
  supportsThinking: boolean;
  isStreaming: boolean;
};

export type ExtensionUiRequest =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText: string | undefined;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines: string[] | undefined;
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

export type ExtensionUiResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

type LiveSession = {
  session: AgentSession;
  unsubscribe: () => void;
  /** When this session was first bound (created or reopened). Fallback createdAt for sessions not yet flushed to disk. */
  boundAt: string;
  extensionsReady: Promise<void>;
};

type PendingExtensionUiRequest = {
  sessionId: string;
  request: ExtensionUiRequest;
  resolve: (response: ExtensionUiResponse) => void;
  timer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
};

type PendingOAuthFlow = AgentOAuthFlowState & {
  version: number;
  abortController: AbortController;
  promptResolve?: (value: string) => void;
  promptReject?: (error: Error) => void;
  manualResolve?: (value: string) => void;
  manualReject?: (error: Error) => void;
  waiters: Array<(state: AgentOAuthFlowState) => void>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

export class AgentRuntime {
  private readonly projectDir: string;
  private readonly sessionsDir: string;
  private readonly agentDir: string;
  private readonly modelsJsonPath: string;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly logger: Pick<Console, "log" | "error">;
  private readonly defaultModelProvider: string | undefined;
  private readonly defaultModelId: string | undefined;
  private readonly defaultThinkingLevel: ThinkingLevel | undefined;
  private readonly modelThinkingDefaults: Record<string, ThinkingLevel>;
  private readonly extensionPaths: string[];
  private readonly skillPaths: string[];
  private readonly promptTemplatePaths: string[];
  private readonly themePaths: string[];
  private readonly extensionFactories: ExtensionFactory[];
  private readonly noExtensions: boolean;
  private readonly noSkills: boolean;
  private readonly noPromptTemplates: boolean;
  private readonly noThemes: boolean;
  private readonly live = new Map<string, LiveSession>(); // todo: rename to liveSessions
  private readonly pendingExtensionUi = new Map<string, PendingExtensionUiRequest>();
  private readonly pendingOAuthFlows = new Map<string, PendingOAuthFlow>();
  /** Resolved absolute path to the agent's system-prompt file, if pinned. */
  private readonly agentsFile: string | undefined;
  /** Cached system-prompt content, read once at construction. */
  private readonly systemPrompt: string | undefined;

  constructor(config: AgentRuntimeConfig) {
    this.projectDir = config.projectDir;
    this.sessionsDir = config.sessionsDir;
    this.agentDir = config.agentDir ?? getAgentDir();
    this.logger = config.logger ?? console;
    this.defaultModelProvider = config.defaultModelProvider;
    this.defaultModelId = config.defaultModelId;
    this.defaultThinkingLevel = config.defaultThinkingLevel;
    this.modelThinkingDefaults = config.modelThinkingDefaults ?? {};
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
    this.modelsJsonPath = join(this.agentDir, "models.json");

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
        this.logger.error(
          `[agent] failed to read agentsFile ${path}: ${String(err)}`,
        );
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

    this.modelRegistry = config.modelRegistry ?? ModelRegistry.create(this.authStorage, this.modelsJsonPath);
    if (!config.modelRegistry) config.configureModelRegistry?.(this.modelRegistry);

    if (this.defaultModelProvider && this.defaultModelId) {
      const model = this.modelRegistry.find(this.defaultModelProvider, this.defaultModelId);
      if (!model) {
        this.logger.error(`[agent] default model not found: ${this.defaultModelProvider}/${this.defaultModelId}`);
      } else if (!this.modelRegistry.hasConfiguredAuth(model)) {
        this.logger.error(`[agent] auth is not configured for default model ${model.provider}/${model.id}`);
      } else {
        this.logger.log(`[agent] default model: ${model.provider}/${model.id}`);
      }
    }
  }

  private modelKey(model: Pick<SessionModel, "provider" | "id">): string {
    return `${model.provider}/${model.id}`;
  }

  private supportedThinkingLevelsForModel(model: SessionModel): ThinkingLevel[] {
    if (!model.reasoning) return ["off"];
    return THINKING_LEVELS.filter((level) => {
      const mapped = model.thinkingLevelMap?.[level];
      if (mapped === null) return false;
      if (level === "xhigh") return mapped !== undefined;
      return true;
    });
  }

  private clampThinkingLevelForModel(model: SessionModel, level: ThinkingLevel): ThinkingLevel {
    const available = this.supportedThinkingLevelsForModel(model);
    if (available.includes(level)) return level;
    const requestedIndex = THINKING_LEVELS.indexOf(level);
    for (let i = requestedIndex; i < THINKING_LEVELS.length; i += 1) {
      const candidate = THINKING_LEVELS[i]!;
      if (available.includes(candidate)) return candidate;
    }
    for (let i = requestedIndex - 1; i >= 0; i -= 1) {
      const candidate = THINKING_LEVELS[i]!;
      if (available.includes(candidate)) return candidate;
    }
    return available[0] ?? "off";
  }

  private defaultThinkingForModel(model: SessionModel): ThinkingLevel | undefined {
    const configured = this.modelThinkingDefaults[this.modelKey(model)] ?? this.defaultThinkingLevel;
    return configured ? this.clampThinkingLevelForModel(model, configured) : undefined;
  }

  /** Public-safe, non-secret model metadata for API/UI consumers. */
  private modelRow(model: SessionModel): AgentModelRow {
    return {
      provider: model.provider,
      id: model.id,
      name: model.name,
      api: model.api,
      reasoning: model.reasoning,
      available: this.modelRegistry.hasConfiguredAuth(model),
      input: [...model.input],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      defaultThinkingLevel: this.defaultThinkingForModel(model),
    };
  }

  private sessionModelSettings(session: AgentSession): SessionModelSettings {
    return {
      model: session.model ? this.modelRow(session.model as SessionModel) : null,
      thinkingLevel: session.thinkingLevel as ThinkingLevel,
      availableThinkingLevels: session.getAvailableThinkingLevels() as ThinkingLevel[],
      supportsThinking: session.supportsThinking(),
      isStreaming: session.isStreaming,
    };
  }

  private sessionModelDefaults(): Pick<CreateAgentSessionOptions, "model" | "thinkingLevel"> {
    const defaults: Pick<CreateAgentSessionOptions, "model" | "thinkingLevel"> = {};
    if (this.defaultModelProvider && this.defaultModelId) {
      const model = this.modelRegistry.find(this.defaultModelProvider, this.defaultModelId) as SessionModel | undefined;
      if (model) {
        defaults.model = model;
        const thinkingLevel = this.defaultThinkingForModel(model);
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
    const settingsManager = SettingsManager.create(
      this.projectDir,
      this.agentDir,
    );
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

  private publishExtensionUiRequest(sessionId: string, request: ExtensionUiRequest): void {
    publish(sessionId, request);
  }

  private createDialogPromise<T>(
    sessionId: string,
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
        sessionId,
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
      this.publishExtensionUiRequest(sessionId, event);
    });
  }

  private createExtensionUiContext(sessionId: string): ExtensionUIContext {
    return {
      select: (title, options, opts) =>
        this.createDialogPromise(
          sessionId,
          opts,
          undefined,
          { method: "select", title, options, timeout: opts?.timeout },
          (response) => ("cancelled" in response ? undefined : "value" in response ? response.value : undefined),
        ),
      confirm: (title, message, opts) =>
        this.createDialogPromise(
          sessionId,
          opts,
          false,
          { method: "confirm", title, message, timeout: opts?.timeout },
          (response) => ("cancelled" in response ? false : "confirmed" in response ? response.confirmed : false),
        ),
      input: (title, placeholder, opts) =>
        this.createDialogPromise(
          sessionId,
          opts,
          undefined,
          { method: "input", title, placeholder, timeout: opts?.timeout },
          (response) => ("cancelled" in response ? undefined : "value" in response ? response.value : undefined),
        ),
      editor: (title, prefill) =>
        this.createDialogPromise(
          sessionId,
          undefined,
          undefined,
          { method: "editor", title, prefill },
          (response) => ("cancelled" in response ? undefined : "value" in response ? response.value : undefined),
        ),
      notify: (message, type) =>
        this.publishExtensionUiRequest(sessionId, {
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          message,
          notifyType: type,
        }),
      onTerminalInput: () => () => {},
      setStatus: (key, text) =>
        this.publishExtensionUiRequest(sessionId, {
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
      setWidget: ((key: string, content: string[] | ((...args: any[]) => unknown) | undefined, options?: ExtensionWidgetOptions) => {
        if (content !== undefined && !Array.isArray(content)) return;
        this.publishExtensionUiRequest(sessionId, {
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
        this.publishExtensionUiRequest(sessionId, {
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setTitle",
          title,
        }),
      custom: async () => undefined as never,
      pasteToEditor: (text) =>
        this.publishExtensionUiRequest(sessionId, {
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        }),
      setEditorText: (text) =>
        this.publishExtensionUiRequest(sessionId, {
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
      setTheme: () => ({ success: false, error: "UI theme switching is not available in agent-server" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  private extensionCommandActions(session: AgentSession): ExtensionCommandContextActions {
    return {
      waitForIdle: () => session.agent.waitForIdle(),
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }),
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {
        await session.reload();
      },
    };
  }

  /**
   * Wire an AgentSession's event stream into the SSE broker. Called once
   * per session right after it's created or reopened. The unsubscribe
   * handle is kept so we can detach if we ever evict.
   */
  private bind(session: AgentSession): void {
    const id = session.sessionId;
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      publish(id, event);
    });
    const extensionsReady = session
      .bindExtensions({
        uiContext: this.createExtensionUiContext(id),
        commandContextActions: this.extensionCommandActions(session),
        onError: (err) => {
          publish(id, {
            type: "extension_error",
            extensionPath: err.extensionPath,
            event: err.event,
            error: err.error,
            stack: err.stack,
          });
          this.logger.error(`[agent] extension error in ${err.extensionPath}: ${err.error}`);
        },
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        publish(id, { type: "extension_error", extensionPath: "<bindExtensions>", event: "session_start", error: message });
        this.logger.error(`[agent] extension binding failed for ${id}: ${message}`);
      });
    this.live.set(id, {
      session,
      unsubscribe,
      boundAt: new Date().toISOString(),
      extensionsReady,
    });
  }

  private async ensureExtensionsReady(id: string): Promise<void> {
    const entry = this.live.get(id);
    if (entry) await entry.extensionsReady;
  }

  pendingExtensionUiRequests(id: string): ExtensionUiRequest[] {
    return Array.from(this.pendingExtensionUi.values())
      .filter((entry) => entry.sessionId === id)
      .map((entry) => entry.request);
  }

  resolveExtensionUiRequest(id: string, requestId: string, response: ExtensionUiResponse): boolean {
    const pending = this.pendingExtensionUi.get(requestId);
    if (!pending || pending.sessionId !== id) return false;
    pending.resolve(response);
    return true;
  }

  /**
   * Create a brand-new session. Pi writes a new JSONL file under
   * sessionsDir on first message_end. Returns minimal metadata.
   */
  async createNewSession(): Promise<{ id: string; createdAt: string }> {
    const { session } = await createAgentSession({
      ...this.sessionModelDefaults(),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager: SessionManager.create(this.projectDir, this.sessionsDir),
      resourceLoader: await this.makeResourceLoader(),
    });
    this.bind(session);
    return {
      id: session.sessionId,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Get a live AgentSession by id, lazily reopening from disk if not in
   * memory. Returns null if no session file exists with that id.
   */
  async ensureSession(id: string): Promise<AgentSession | null> {
    const existing = this.live.get(id);
    if (existing) return existing.session;

    const sessions = await SessionManager.list(
      this.projectDir,
      this.sessionsDir,
    );
    const info = sessions.find((s) => s.id === id);
    if (!info) return null;

    const { session } = await createAgentSession({
      ...this.sessionModelDefaults(),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager: SessionManager.open(info.path),
      resourceLoader: await this.makeResourceLoader(),
    });
    this.bind(session);
    return session;
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
    const list: SessionInfo[] = await SessionManager.list(
      this.projectDir,
      this.sessionsDir,
    );
    const onDisk = new Set(list.map((s) => s.id));

    const rows: SessionRow[] = list.map((info) => ({
      id: info.id,
      createdAt: info.created.toISOString(),
      firstMessage: info.firstMessage ?? "",
      messageCount: info.messageCount,
    }));

    for (const [id, entry] of this.live) {
      if (onDisk.has(id)) continue;
      const messages = entry.session.state.messages as Array<{
        role: string;
        content: Array<{ type: string; text?: string }>;
      }>;
      const firstUser = messages.find((m) => m.role === "user");
      const firstText =
        firstUser?.content.find((c) => c.type === "text")?.text ?? "";
      rows.push({
        id,
        createdAt: entry.boundAt,
        firstMessage: firstText,
        messageCount: messages.length,
      });
    }

    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Return persisted message history for a session, lazy-loading the
   * AgentSession if it isn't live yet. Used by the frontend on session
   * open to populate the chat before the SSE stream starts.
   */
  async getSessionMessages(id: string): Promise<unknown[] | null> {
    const session = await this.ensureSession(id);
    if (!session) return null;
    return session.state.messages;
  }

  /** Return all models known to this runtime, including unavailable ones for diagnostics. */
  listModels(): AgentModelRow[] {
    return this.modelRegistry
      .getAll()
      .map((model) => this.modelRow(model as SessionModel))
      .sort(
        (a, b) =>
          Number(b.available) - Number(a.available) ||
          a.provider.localeCompare(b.provider) ||
          a.name.localeCompare(b.name),
      );
  }

  /** Return non-secret auth status grouped by provider. */
  listAuthProviders(): AgentAuthProviderRow[] {
    const byProvider = new Map<string, { modelCount: number; availableModelCount: number }>();
    for (const model of this.listModels()) {
      const current = byProvider.get(model.provider) ?? { modelCount: 0, availableModelCount: 0 };
      current.modelCount += 1;
      if (model.available) current.availableModelCount += 1;
      byProvider.set(model.provider, current);
    }
    const oauthProviderIds = new Set(this.authStorage.getOAuthProviders().map((provider) => provider.id));
    for (const provider of oauthProviderIds) {
      if (!byProvider.has(provider)) {
        byProvider.set(provider, { modelCount: 0, availableModelCount: 0 });
      }
    }

    return [...byProvider.entries()]
      .map(([provider, counts]) => {
        const status = this.modelRegistry.getProviderAuthStatus(provider);
        const credential = this.authStorage.get(provider);
        return {
          provider,
          name: this.modelRegistry.getProviderDisplayName(provider),
          configured: status.configured || status.source !== undefined,
          credentialType: credential?.type,
          source: status.source,
          label: status.label,
          supportsApiKey: counts.modelCount > 0,
          supportsSubscription: oauthProviderIds.has(provider),
          ...counts,
        };
      })
      .sort(
        (a, b) =>
          Number(b.configured) - Number(a.configured) ||
          b.availableModelCount - a.availableModelCount ||
          a.provider.localeCompare(b.provider),
      );
  }

  setProviderApiKey(provider: string, key: string): void {
    this.assertProviderId(provider);
    const trimmed = key.trim();
    if (!trimmed) throw new Error("key is required");
    this.authStorage.set(provider, { type: "api_key", key: trimmed });
    this.modelRegistry.refresh();
  }

  removeProviderCredential(provider: string): void {
    this.assertProviderId(provider);
    this.authStorage.remove(provider);
    this.modelRegistry.refresh();
  }

  private assertProviderId(provider: string): void {
    if (!/^[a-zA-Z0-9_.:-]+$/.test(provider)) {
      throw new Error("invalid provider id");
    }
  }

  private customProviderApi(value: unknown): AgentCustomProviderApi | undefined {
    return CUSTOM_PROVIDER_APIS.includes(value as AgentCustomProviderApi)
      ? (value as AgentCustomProviderApi)
      : undefined;
  }

  private oauthFlowState(flow: PendingOAuthFlow): AgentOAuthFlowState {
    return {
      id: flow.id,
      provider: flow.provider,
      providerName: flow.providerName,
      status: flow.status,
      authUrl: flow.authUrl,
      instructions: flow.instructions,
      prompt: flow.prompt,
      progress: [...flow.progress],
      error: flow.error,
      expiresAt: flow.expiresAt,
    };
  }

  private updateOAuthFlow(flow: PendingOAuthFlow, patch: Partial<AgentOAuthFlowState>): void {
    Object.assign(flow, patch);
    flow.version += 1;
    const state = this.oauthFlowState(flow);
    const waiters = flow.waiters.splice(0);
    for (const waiter of waiters) waiter(state);
  }

  private scheduleOAuthFlowCleanup(flow: PendingOAuthFlow, delayMs = 10 * 60 * 1000): void {
    if (flow.cleanupTimer) clearTimeout(flow.cleanupTimer);
    flow.cleanupTimer = setTimeout(() => {
      this.pendingOAuthFlows.delete(flow.id);
    }, delayMs);
    flow.cleanupTimer.unref?.();
  }

  private activeOAuthFlowForProvider(provider: string): PendingOAuthFlow | undefined {
    const now = Date.now();
    for (const flow of this.pendingOAuthFlows.values()) {
      if (flow.provider !== provider) continue;
      if (["complete", "error", "cancelled"].includes(flow.status)) continue;
      if (Date.parse(flow.expiresAt) <= now) continue;
      return flow;
    }
    return undefined;
  }

  private oauthLoginErrorMessage(providerName: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("EADDRINUSE")) {
      return `${providerName} login callback is already running on its local port. Finish or cancel the existing login, then try again.`;
    }
    return message;
  }

  private waitForOAuthFlowUpdate(
    flow: PendingOAuthFlow,
    version: number,
    timeoutMs = 15_000,
  ): Promise<AgentOAuthFlowState> {
    if (flow.version !== version) return Promise.resolve(this.oauthFlowState(flow));
    if (["complete", "error", "cancelled"].includes(flow.status)) {
      return Promise.resolve(this.oauthFlowState(flow));
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(this.oauthFlowState(flow));
      }, timeoutMs);
      flow.waiters.push((state) => {
        clearTimeout(timer);
        resolve(state);
      });
    });
  }

  async startProviderSubscriptionLogin(provider: string): Promise<AgentOAuthFlowState> {
    this.assertProviderId(provider);
    const oauthProvider = this.authStorage.getOAuthProviders().find((entry) => entry.id === provider);
    if (!oauthProvider) throw new Error(`provider ${provider} does not support subscription auth`);

    const activeFlow = this.activeOAuthFlowForProvider(provider);
    if (activeFlow) return this.oauthFlowState(activeFlow);

    const flow: PendingOAuthFlow = {
      id: randomUUID(),
      provider,
      providerName: oauthProvider.name,
      status: "starting",
      progress: [],
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      version: 0,
      abortController: new AbortController(),
      waiters: [],
    };
    this.pendingOAuthFlows.set(flow.id, flow);
    this.scheduleOAuthFlowCleanup(flow);

    const loginPromise = this.authStorage.login(provider, {
      onAuth: (info) => {
        this.updateOAuthFlow(flow, {
          status: "auth",
          authUrl: info.url,
          instructions: info.instructions,
          prompt: undefined,
        });
      },
      onPrompt: (prompt) =>
        new Promise<string>((resolve, reject) => {
          flow.promptResolve = resolve;
          flow.promptReject = reject;
          this.updateOAuthFlow(flow, {
            status: "prompt",
            prompt: {
              message: prompt.message,
              placeholder: prompt.placeholder,
              allowEmpty: prompt.allowEmpty,
            },
          });
        }),
      onProgress: (message) => {
        this.updateOAuthFlow(flow, { progress: [...flow.progress, message] });
      },
      onManualCodeInput: () =>
        new Promise<string>((resolve, reject) => {
          flow.manualResolve = resolve;
          flow.manualReject = reject;
        }),
      signal: flow.abortController.signal,
    });

    void loginPromise
      .then(() => {
        this.modelRegistry.refresh();
        this.updateOAuthFlow(flow, {
          status: "complete",
          prompt: undefined,
          authUrl: undefined,
          instructions: undefined,
          progress: [...flow.progress, "Credentials saved."],
        });
        this.scheduleOAuthFlowCleanup(flow, 60_000);
      })
      .catch((error: unknown) => {
        this.updateOAuthFlow(flow, {
          status: flow.status === "cancelled" ? "cancelled" : "error",
          error: this.oauthLoginErrorMessage(flow.providerName, error),
        });
        this.scheduleOAuthFlowCleanup(flow, 60_000);
      });

    return this.waitForOAuthFlowUpdate(flow, 0);
  }

  async continueProviderSubscriptionLogin(id: string, value: string): Promise<AgentOAuthFlowState> {
    const flow = this.pendingOAuthFlows.get(id);
    if (!flow) throw new Error("subscription auth flow not found");
    const trimmed = value.trim();

    if (flow.promptResolve) {
      if (!trimmed && !flow.prompt?.allowEmpty) throw new Error("value is required");
      const resolve = flow.promptResolve;
      flow.promptResolve = undefined;
      flow.promptReject = undefined;
      this.updateOAuthFlow(flow, { status: "waiting", prompt: undefined });
      const waitVersion = flow.version;
      resolve(value);
      return this.waitForOAuthFlowUpdate(flow, waitVersion);
    }

    if (flow.manualResolve) {
      if (!trimmed) throw new Error("redirect URL or authorization code is required");
      const resolve = flow.manualResolve;
      flow.manualResolve = undefined;
      flow.manualReject = undefined;
      this.updateOAuthFlow(flow, { status: "waiting", prompt: undefined });
      const waitVersion = flow.version;
      resolve(trimmed);
      return this.waitForOAuthFlowUpdate(flow, waitVersion);
    }

    return this.oauthFlowState(flow);
  }

  getProviderSubscriptionLogin(id: string): AgentOAuthFlowState | undefined {
    const flow = this.pendingOAuthFlows.get(id);
    return flow ? this.oauthFlowState(flow) : undefined;
  }

  cancelProviderSubscriptionLogin(id: string): AgentOAuthFlowState | undefined {
    const flow = this.pendingOAuthFlows.get(id);
    if (!flow) return undefined;
    flow.abortController.abort();
    flow.promptReject?.(new Error("Login cancelled"));
    flow.manualReject?.(new Error("Login cancelled"));
    this.updateOAuthFlow(flow, { status: "cancelled", error: "Login cancelled" });
    this.scheduleOAuthFlowCleanup(flow, 60_000);
    return this.oauthFlowState(flow);
  }

  private readModelsJson(): { providers: Record<string, Record<string, unknown>> } {
    if (!existsSync(this.modelsJsonPath)) return { providers: {} };
    const parsed = JSON.parse(readFileSync(this.modelsJsonPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("models.json must be a JSON object");
    }
    const record = parsed as Record<string, unknown>;
    const providers = record.providers;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
      return { ...record, providers: {} } as { providers: Record<string, Record<string, unknown>> };
    }
    return { ...record, providers } as { providers: Record<string, Record<string, unknown>> };
  }

  private writeModelsJson(config: { providers: Record<string, Record<string, unknown>> }): void {
    writeFileSync(this.modelsJsonPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    chmodSync(this.modelsJsonPath, 0o600);
  }

  listCustomProviders(): AgentCustomProviderRow[] {
    const config = this.readModelsJson();
    return Object.entries(config.providers)
      .filter(([, providerConfig]) => Array.isArray(providerConfig.models))
      .map(([provider, providerConfig]) => {
        const models = (providerConfig.models as unknown[])
          .filter(
            (model): model is Record<string, unknown> =>
              Boolean(model) && typeof model === "object" && typeof (model as { id?: unknown }).id === "string",
          )
          .map((model) => ({
            ...model,
            id: String(model.id),
            name: typeof model.name === "string" ? model.name : undefined,
            api: this.customProviderApi(model.api),
            reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
            input: Array.isArray(model.input)
              ? model.input.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image")
              : undefined,
            contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined,
            maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : undefined,
            thinkingLevelMap:
              model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" && !Array.isArray(model.thinkingLevelMap)
                ? (model.thinkingLevelMap as Partial<Record<ThinkingLevel, string | null>>)
                : undefined,
            compat:
              model.compat && typeof model.compat === "object" && !Array.isArray(model.compat)
                ? (model.compat as Record<string, unknown>)
                : undefined,
          }));
        return {
          provider,
          name: typeof providerConfig.name === "string" ? providerConfig.name : undefined,
          baseUrl: typeof providerConfig.baseUrl === "string" ? providerConfig.baseUrl : undefined,
          api: this.customProviderApi(providerConfig.api),
          apiKeyConfigured: typeof providerConfig.apiKey === "string" && providerConfig.apiKey.trim().length > 0,
          modelCount: models.length,
          models,
        };
      })
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }

  upsertCustomProvider(input: UpsertCustomProviderRequest): AgentCustomProviderRow {
    this.assertProviderId(input.provider);
    const baseUrl = input.baseUrl.trim();
    if (!baseUrl) throw new Error("baseUrl is required");
    const parsedUrl = new URL(baseUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("baseUrl must use http or https");
    }
    const models = input.models.map((model) => ({ ...model, id: model.id.trim() }));
    if (models.some((model) => !model.id)) throw new Error("model id is required");
    if (!models.length) throw new Error("at least one model is required");

    const config = this.readModelsJson();
    const existing = config.providers[input.provider] ?? {};
    const apiKey = input.apiKey?.trim() || (typeof existing.apiKey === "string" ? existing.apiKey : "");
    if (!apiKey) throw new Error("apiKey is required for custom providers");

    config.providers[input.provider] = {
      name: input.name?.trim() || input.provider,
      baseUrl,
      api: input.api,
      apiKey,
      models: models.map((model) => ({
        ...model,
        name: model.name?.trim() || model.id,
        api: model.api,
        input: model.input ?? ["text"],
        contextWindow: model.contextWindow ?? 128000,
        maxTokens: model.maxTokens ?? 16384,
        reasoning: model.reasoning ?? false,
      })),
    };

    this.writeModelsJson(config);
    this.modelRegistry.refresh();
    return this.listCustomProviders().find((provider) => provider.provider === input.provider)!;
  }

  removeCustomProvider(provider: string): void {
    this.assertProviderId(provider);
    const config = this.readModelsJson();
    delete config.providers[provider];
    this.writeModelsJson(config);
    this.modelRegistry.refresh();
  }

  async getSessionModelSettings(id: string): Promise<SessionModelSettings | null> {
    const session = await this.ensureSession(id);
    if (!session) return null;
    return this.sessionModelSettings(session);
  }

  private async setSessionModelInternal(session: AgentSession, model: SessionModel): Promise<void> {
    const currentThinkingLevel = session.thinkingLevel as ThinkingLevel;
    const nextAvailableLevels = this.supportedThinkingLevelsForModel(model);
    const defaultThinkingLevel = this.defaultThinkingForModel(model);
    const shouldUseModelDefault = Boolean(defaultThinkingLevel && !nextAvailableLevels.includes(currentThinkingLevel));
    await session.setModel(model);
    if (shouldUseModelDefault && session.thinkingLevel !== defaultThinkingLevel) {
      session.setThinkingLevel(defaultThinkingLevel!);
    }
  }

  async setSessionModel(id: string, provider: string, modelId: string): Promise<SessionModelSettings> {
    const session = await this.ensureSession(id);
    if (!session) throw new Error(`session ${id} not found`);
    if (session.isStreaming) throw new Error("Cannot change model while the agent is running");
    const model = this.modelRegistry.find(provider, modelId) as SessionModel | undefined;
    if (!model) throw new Error(`model ${provider}/${modelId} not found`);
    await this.setSessionModelInternal(session, model);
    return this.sessionModelSettings(session);
  }

  async setSessionThinkingLevel(id: string, level: ThinkingLevel): Promise<SessionModelSettings> {
    const session = await this.ensureSession(id);
    if (!session) throw new Error(`session ${id} not found`);
    if (session.isStreaming) throw new Error("Cannot change thinking level while the agent is running");
    session.setThinkingLevel(level);
    return this.sessionModelSettings(session);
  }

  async updateSessionModelSettings(
    id: string,
    settings: { provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel },
  ): Promise<SessionModelSettings> {
    const session = await this.ensureSession(id);
    if (!session) throw new Error(`session ${id} not found`);
    if (session.isStreaming) throw new Error("Cannot change model settings while the agent is running");
    if (settings.provider && settings.modelId) {
      const model = this.modelRegistry.find(settings.provider, settings.modelId) as SessionModel | undefined;
      if (!model) throw new Error(`model ${settings.provider}/${settings.modelId} not found`);
      await this.setSessionModelInternal(session, model);
    }
    if (settings.thinkingLevel) session.setThinkingLevel(settings.thinkingLevel);
    return this.sessionModelSettings(session);
  }

  /**
   * Send a user prompt to a session. Events flow over SSE to any
   * subscribers. Returns once the prompt has been queued; the agent runs
   * asynchronously.
   */
  async sendPrompt(id: string, text: string): Promise<void> {
    const session = await this.ensureSession(id);
    if (!session) throw new Error(`session ${id} not found`);
    await this.ensureExtensionsReady(id);
    if (session.isStreaming) {
      // While the agent is streaming, prompt() requires a streamingBehavior.
      // "steer" queues the message for delivery as soon as the current
      // assistant turn's tool calls finish — i.e. it actually interrupts
      // the agent's plan rather than waiting for it to fully stop
      // ("followUp"). Equivalent to session.steer(text).
      await session.prompt(text, { streamingBehavior: "steer" });
      return;
    }
    await session.prompt(text);
  }

  /**
   * Abort the current operation on a session (the agent's in-flight LLM
   * call and any running tool). Resolves once pi has torn the run down;
   * the session itself stays usable — subsequent prompts work normally.
   * No-op if the session isn't streaming. Throws if the session id is
   * unknown.
   */
  async abortSession(id: string): Promise<void> {
    const session = await this.ensureSession(id);
    if (!session) throw new Error(`session ${id} not found`);
    if (!session.isStreaming) return;
    await session.abort();
  }
}
