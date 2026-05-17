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
import { mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type SessionInfo,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { publish } from "./sseBroker.js";

/** Configuration for a single AgentRuntime instance. */
export type AgentRuntimeConfig = {
  /** Absolute path handed to pi as the session cwd. Skill discovery is rooted here. */
  projectDir: string;
  /** Absolute path where pi writes session JSONL files. Created if missing. */
  sessionsDir: string;
  /**
   * Optional Anthropic API key to inject into AuthStorage at runtime. If
   * unset, the runtime falls back to whatever's in `~/.pi/agent/auth.json`
   * (typical for local dev).
   */
  anthropicApiKey?: string;
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

type LiveSession = {
  session: AgentSession;
  unsubscribe: () => void;
  /** When this session was first bound (created or reopened). Fallback createdAt for sessions not yet flushed to disk. */
  boundAt: string;
};

export class AgentRuntime {
  private readonly projectDir: string;
  private readonly sessionsDir: string;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly logger: Pick<Console, "log" | "error">;
  private readonly live = new Map<string, LiveSession>(); // todo: rename to liveSessions
  /** Resolved absolute path to the agent's system-prompt file, if pinned. */
  private readonly agentsFile: string | undefined;
  /** Cached system-prompt content, read once at construction. */
  private readonly systemPrompt: string | undefined;

  constructor(config: AgentRuntimeConfig) {
    this.projectDir = config.projectDir;
    this.sessionsDir = config.sessionsDir;
    this.logger = config.logger ?? console;
    mkdirSync(this.sessionsDir, { recursive: true });

    this.authStorage = AuthStorage.create();
    this.modelRegistry = ModelRegistry.create(this.authStorage);

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
        "[agent] no ANTHROPIC_API_KEY provided; relying on AuthStorage defaults (~/.pi/agent/auth.json)",
      );
    }
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
      getAgentDir(),
    );
    const loader = new DefaultResourceLoader({
      cwd: this.projectDir,
      agentDir: getAgentDir(),
      settingsManager,
      // When we have an explicit agentsFile, suppress all ancestor-walk
      // AGENTS.md/CLAUDE.md discovery and feed our content via
      // systemPrompt instead.
      noContextFiles: this.systemPrompt !== undefined,
      systemPrompt: this.systemPrompt,
    });
    await loader.reload();
    return loader;
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
    this.live.set(id, {
      session,
      unsubscribe,
      boundAt: new Date().toISOString(),
    });
  }

  /**
   * Create a brand-new session. Pi writes a new JSONL file under
   * sessionsDir on first message_end. Returns minimal metadata.
   */
  async createNewSession(): Promise<{ id: string; createdAt: string }> {
    const { session } = await createAgentSession({
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

  /**
   * Send a user prompt to a session. Events flow over SSE to any
   * subscribers. Returns once the prompt has been queued; the agent runs
   * asynchronously.
   */
  async sendPrompt(id: string, text: string): Promise<void> {
    const session = await this.ensureSession(id);
    if (!session) throw new Error(`session ${id} not found`);
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
