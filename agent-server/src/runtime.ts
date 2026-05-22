/**
 * AgentRuntime — pi SDK orchestrator scoped to one Appx app.
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
 *   - one AuthStorage + ModelRegistry per runtime
 *   - Map<sessionId, LiveSession> of in-memory live sessions
 *   - subscription bridge: every AgentSessionEvent → publish(sessionId, event)
 *
 * No module-level singletons — multiple apps in the same process (e.g. tests)
 * each get their own runtime with isolated state.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
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

/** Configuration for a single AgentRuntime instance. */
export type AgentRuntimeConfig = {
  /** Absolute path handed to pi as the session cwd. Skill discovery is rooted here. */
  projectDir: string;
  /** Absolute path where pi writes session JSONL files. Created if missing. */
  sessionsDir: string;
  /** Optional pi agent config dir. Defaults to Pi's standard ~/.pi/agent. */
  agentDir?: string;
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

export class AgentRuntime {
  private readonly projectDir: string;
  private readonly sessionsDir: string;
  private readonly agentDir: string;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly logger: Pick<Console, "log" | "error">;
  private readonly defaultModelProvider: string | undefined;
  private readonly defaultModelId: string | undefined;
  private readonly defaultThinkingLevel: ThinkingLevel | undefined;
  private readonly modelThinkingDefaults: Record<string, ThinkingLevel>;
  private readonly extensionPaths: string[];
  private readonly extensionFactories: ExtensionFactory[];
  private readonly noExtensions: boolean;
  private readonly noSkills: boolean;
  private readonly noPromptTemplates: boolean;
  private readonly noThemes: boolean;
  private readonly live = new Map<string, LiveSession>(); // todo: rename to liveSessions
  private readonly pendingExtensionUi = new Map<string, PendingExtensionUiRequest>();
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
    this.extensionFactories = config.extensionFactories ?? [];
    this.noExtensions = config.noExtensions ?? false;
    this.noSkills = config.noSkills ?? false;
    this.noPromptTemplates = config.noPromptTemplates ?? false;
    this.noThemes = config.noThemes ?? false;
    mkdirSync(this.sessionsDir, { recursive: true });
    mkdirSync(this.agentDir, { recursive: true });

    this.authStorage = AuthStorage.create(join(this.agentDir, "auth.json"));

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

    this.modelRegistry = ModelRegistry.create(this.authStorage, join(this.agentDir, "models.json"));
    config.configureModelRegistry?.(this.modelRegistry);

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
