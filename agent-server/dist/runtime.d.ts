import { type AgentSession } from "@earendil-works/pi-coding-agent";
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
export declare class AgentRuntime {
    private readonly projectDir;
    private readonly sessionsDir;
    private readonly authStorage;
    private readonly modelRegistry;
    private readonly logger;
    private readonly live;
    /** Resolved absolute path to the agent's system-prompt file, if pinned. */
    private readonly agentsFile;
    /** Cached system-prompt content, read once at construction. */
    private readonly systemPrompt;
    constructor(config: AgentRuntimeConfig);
    /**
     * Build a fresh DefaultResourceLoader configured with our pinned
     * system-prompt file, if any. Pi's SDK constructs a default loader
     * (with full ancestor AGENTS.md/CLAUDE.md discovery) when none is
     * passed, so we always pass our own to keep behaviour deterministic.
     * A new loader per session is fine — pi creates one anyway.
     */
    private makeResourceLoader;
    /**
     * Wire an AgentSession's event stream into the SSE broker. Called once
     * per session right after it's created or reopened. The unsubscribe
     * handle is kept so we can detach if we ever evict.
     */
    private bind;
    /**
     * Create a brand-new session. Pi writes a new JSONL file under
     * sessionsDir on first message_end. Returns minimal metadata.
     */
    createNewSession(): Promise<{
        id: string;
        createdAt: string;
    }>;
    /**
     * Get a live AgentSession by id, lazily reopening from disk if not in
     * memory. Returns null if no session file exists with that id.
     */
    ensureSession(id: string): Promise<AgentSession | null>;
    /**
     * List all sessions, merging two sources of truth:
     *   1. Persisted sessions on disk (SessionManager.list)
     *   2. Live in-memory sessions not yet flushed to disk (newly created,
     *      no prompts yet — pi writes the file lazily on first message)
     *
     * Disk metadata wins when both exist. Sorted newest-first.
     */
    listSessions(): Promise<SessionRow[]>;
    /**
     * Return persisted message history for a session, lazy-loading the
     * AgentSession if it isn't live yet. Used by the frontend on session
     * open to populate the chat before the SSE stream starts.
     */
    getSessionMessages(id: string): Promise<unknown[] | null>;
    /**
     * Send a user prompt to a session. Events flow over SSE to any
     * subscribers. Returns once the prompt has been queued; the agent runs
     * asynchronously.
     */
    sendPrompt(id: string, text: string): Promise<void>;
    /**
     * Abort the current operation on a session (the agent's in-flight LLM
     * call and any running tool). Resolves once pi has torn the run down;
     * the session itself stays usable — subsequent prompts work normally.
     * No-op if the session isn't streaming. Throws if the session id is
     * unknown.
     */
    abortSession(id: string): Promise<void>;
}
