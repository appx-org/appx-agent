/**
 * SessionStore manages live agent sessions for a single `AgentClient`.
 *
 * Responsibilities:
 *  - Own one shared `EventSource` per (projectId, sessionId) so multiple React
 *    components can subscribe to the same stream without duplicate connections.
 *  - Apply SSE events and REST snapshots through the pure `sessionReducer`.
 *  - Provide a `useSyncExternalStore`-compatible subscribe/getSnapshot API.
 *  - Run a low-frequency poll as a recovery channel when SSE drops or to pick up
 *    extension-UI requests created before the stream connected.
 *
 * Unlike a module-global singleton, a store is bound to one client instance so
 * different providers/origins stay isolated — important for reuse across apps.
 */
import { AgentClient, type EventSourceLike } from "./client";
import { sessionReducer, type SessionAction } from "./reducer";
import {
  type AgentEvent,
  type AgentModel,
  type ExtensionUiResponse,
  type SessionState,
  type ThinkingLevel,
  initialSessionState,
} from "./types";

type Entry = {
  state: SessionState;
  es: EventSourceLike;
  poll?: ReturnType<typeof setInterval>;
  pollBusy?: boolean;
  /** Guards against concurrent/duplicate model-settings fetches per session. */
  modelSettingsLoading?: boolean;
  lastPromptAt?: number;
};

const POLL_INTERVAL_MS = 1_500;
const PROMPT_SETTLE_MS = 3_000;

/**
 * Generate a client-side correlation id for a prompt. Uses the Web Crypto
 * `randomUUID` (available in browsers and Node ≥ 18) so ids are unguessable and
 * collision-free; falls back to a time+random token only where Web Crypto is
 * unavailable.
 */
function newCorrelationId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class SessionStore {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Map<string, Set<() => void>>();
  /**
   * Cached fetch of the (session-independent) model catalogue. Shared across
   * every session so the list is fetched at most once per store; cleared on
   * failure so a later call can retry.
   */
  private modelsPromise: Promise<AgentModel[]> | null = null;

  constructor(private readonly client: AgentClient) {}

  private static key(projectId: string, sessionId: string): string {
    return `${projectId}:${sessionId}`;
  }

  private emit(entryKey: string): void {
    const set = this.listeners.get(entryKey);
    if (!set) return;
    for (const listener of set) listener();
  }

  // Send event from SSE to reducer to update latest message and return new SessionState
  private dispatch(entryKey: string, action: SessionAction): void {
    const entry = this.entries.get(entryKey);
    if (!entry) return;
    const next = sessionReducer(entry.state, action);
    if (next === entry.state) return;
    entry.state = next;
    // share event to subscribers (different browsers)
    this.emit(entryKey);
  }

  /** SSE is primary; this poll only recovers missed events / pending UI requests. */
  private async refreshExtensionRequests(
    projectId: string,
    sessionId: string,
    entryKey: string,
  ): Promise<void> {
    const entry = this.entries.get(entryKey);
    if (!entry || entry.pollBusy) return;
    if (entry.state.status === "idle" && entry.state.extensionRequests.length === 0) return;

    entry.pollBusy = true;
    try {
      const pending = await this.client.listExtensionUiRequests(projectId, sessionId);
      const requests = pending.requests;
      if (requests.length > 0 || entry.state.extensionRequests.length > 0) {
        this.dispatch(entryKey, { type: "load_extension_requests", requests });
      }

      const current = this.entries.get(entryKey);
      if (!current || current.state.status === "idle") return;
      if (current.lastPromptAt && Date.now() - current.lastPromptAt < PROMPT_SETTLE_MS) return;

      const settings = await this.client.getSessionSettings(projectId, sessionId);
      if (!settings.isStreaming) {
        const history = await this.client.getSessionMessages(projectId, sessionId);
        this.dispatch(entryKey, {
          type: "load_history",
          messages: history.messages,
        });
      }
    } catch {
      // Swallow: SSE remains the primary channel; polling is best-effort recovery.
    } finally {
      const latest = this.entries.get(entryKey);
      if (latest) latest.pollBusy = false;
    }
  }

  /** Opens (or reuses) the stream + state entry for a session. */
  attach(projectId: string, sessionId: string): SessionState {
    const entryKey = SessionStore.key(projectId, sessionId);
    const existing = this.entries.get(entryKey);
    if (existing) return existing.state;

    // es = EventSource - connection that sends SSE events for this session
    const es = this.client.openEvents(projectId, sessionId);
    const initial: SessionState = { ...initialSessionState, sessionId };
    const entry: Entry = { state: initial, es };
    this.entries.set(entryKey, entry);
    entry.poll = setInterval(() => {
      void this.refreshExtensionRequests(projectId, sessionId, entryKey);
    }, POLL_INTERVAL_MS);
    this.emit(entryKey);

    es.onopen = () => this.dispatch(entryKey, { type: "set_connected", connected: true });
    es.onerror = () => this.dispatch(entryKey, { type: "set_connected", connected: false });
    // handling message from EventSource
    es.onmessage = (e: MessageEvent) => {
      if (!e.data || !String(e.data).trim().startsWith("{")) return;
      try {
        const parsed = JSON.parse(e.data) as AgentEvent;
        this.dispatch(entryKey, { type: "agent_event", event: parsed });
      } catch (err) {
        console.error("[agent-client] bad SSE event:", err, e.data);
      }
    };

    void this.client
      .getSessionMessages(projectId, sessionId)
      .then((r) => {
        const cur = this.entries.get(entryKey);
        if (!cur) return;
        if (cur.state.status !== "idle" || cur.state.messages.length > 0) return;
        this.dispatch(entryKey, { type: "load_history", messages: r.messages });
      })
      .catch((err) =>
        this.dispatch(entryKey, {
          type: "set_error",
          error: err instanceof Error ? err.message : String(err),
        }),
      );

    void this.client
      .listExtensionUiRequests(projectId, sessionId)
      .then((r) => {
        this.dispatch(entryKey, {
          type: "load_extension_requests",
          requests: r.requests,
        });
      })
      .catch((err) =>
        this.dispatch(entryKey, {
          type: "set_error",
          error: err instanceof Error ? err.message : String(err),
        }),
      );

    return initial;
  }

  subscribe(projectId: string, sessionId: string, listener: () => void): () => void {
    const entryKey = SessionStore.key(projectId, sessionId);
    let set = this.listeners.get(entryKey);
    if (!set) {
      set = new Set();
      this.listeners.set(entryKey, set);
    }
    // notify react through useSyncExternalStore when store changes (e.g. due to new message)
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set?.size === 0) {
        this.listeners.delete(entryKey);
        this.detach(projectId, sessionId);
      }
    };
  }

  getSnapshot(projectId: string, sessionId: string): SessionState {
    return this.entries.get(SessionStore.key(projectId, sessionId))?.state ?? initialSessionState;
  }

  async sendPrompt(projectId: string, sessionId: string, text: string): Promise<void> {
    const entryKey = SessionStore.key(projectId, sessionId);
    this.attach(projectId, sessionId);
    const entry = this.entries.get(entryKey);
    if (entry) entry.lastPromptAt = Date.now();
    // Correlate the optimistic bubble with the server's echoed message by id
    // (see reducer `message_start`), not by comparing prompt text.
    const promptId = newCorrelationId();
    this.dispatch(entryKey, { type: "user_prompt_submitted", text, promptId });
    try {
      await this.client.sendPrompt(projectId, sessionId, text);
      void this.refreshExtensionRequests(projectId, sessionId, entryKey);
    } catch (err) {
      this.dispatch(entryKey, {
        type: "set_error",
        error: err instanceof Error ? err.message : String(err),
      });
      this.dispatch(entryKey, {
        type: "agent_event",
        event: { type: "agent_end", messages: [], willRetry: false },
      });
      throw err;
    }
  }

  /**
   * Abort the in-flight run. Aborting an active run makes the agent emit an
   * `agent_end` event over the SSE stream (pi finalises the run as `aborted`),
   * so when the stream is live we let that event settle the final state instead
   * of refetching the whole transcript. If the stream is known-disconnected we
   * fall back to a history reload; either way the recovery poll backstops a
   * missed `agent_end`.
   */
  async abort(projectId: string, sessionId: string): Promise<void> {
    const entryKey = SessionStore.key(projectId, sessionId);
    try {
      await this.client.abortSession(projectId, sessionId);
    } catch (err) {
      this.dispatch(entryKey, {
        type: "set_error",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const entry = this.entries.get(entryKey);
    if (entry?.state.connected) {
      // Stream is live: the agent_end event pi emits when the run is torn down
      // settles the final state, and the periodic recovery poll picks up any
      // extension-UI changes — so there's nothing more to fetch here.
      return;
    }

    // Stream is down: reconcile final state via history (the heavy path),
    // falling back to a synthetic agent_end if even that fails.
    try {
      const history = await this.client.getSessionMessages(projectId, sessionId);
      this.dispatch(entryKey, { type: "load_history", messages: history.messages });
    } catch {
      this.dispatch(entryKey, {
        type: "agent_event",
        event: { type: "agent_end", messages: [], willRetry: false },
      });
    }
    void this.refreshExtensionRequests(projectId, sessionId, entryKey);
  }

  /**
   * Permanently delete a session. The REST call removes it server-side; we
   * then tear down any live stream/state for it locally so subscribers don't
   * keep polling a session that no longer exists. Detach runs even if the
   * request throws so a failed delete doesn't leave a half-broken stream.
   */
  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    try {
      await this.client.deleteSession(projectId, sessionId);
    } finally {
      this.detach(projectId, sessionId);
    }
  }

  async respondExtensionRequest(
    projectId: string,
    sessionId: string,
    requestId: string,
    response: ExtensionUiResponse,
  ): Promise<void> {
    await this.client.respondExtensionUiRequest(projectId, sessionId, requestId, response);
    this.dispatch(SessionStore.key(projectId, sessionId), {
      type: "extension_ui_response",
      requestId,
    });
  }

  /** Fetch the model catalogue once and cache it across sessions. */
  private async loadModels(): Promise<AgentModel[]> {
    if (!this.modelsPromise) {
      this.modelsPromise = this.client
        .listModels()
        .then((result) => result.models)
        .catch((err) => {
          // Allow a later call to retry after a transient failure.
          this.modelsPromise = null;
          throw err;
        });
    }
    return this.modelsPromise;
  }

  /**
   * Load the session's model catalogue + active settings into shared state.
   * Idempotent: once settings are present we skip the round-trip (settings only
   * change via `updateModelSettings`, whose response refreshes them), so this
   * replaces the previous re-fetch-on-every-idle behaviour. Pass `force` to
   * re-fetch (e.g. on an explicit user refresh).
   */
  async loadModelSettings(
    projectId: string,
    sessionId: string,
    options?: { force?: boolean },
  ): Promise<void> {
    const entryKey = SessionStore.key(projectId, sessionId);
    this.attach(projectId, sessionId);
    const entry = this.entries.get(entryKey);
    if (!entry || entry.modelSettingsLoading) return;
    if (!options?.force && entry.state.modelSettings) return;

    entry.modelSettingsLoading = true;
    try {
      const [models, settings] = await Promise.all([
        this.loadModels(),
        this.client.getSessionSettings(projectId, sessionId),
      ]);
      this.dispatch(entryKey, { type: "set_models", models });
      this.dispatch(entryKey, { type: "set_model_settings", settings });
    } catch (err) {
      this.dispatch(entryKey, {
        type: "set_model_settings_error",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      const latest = this.entries.get(entryKey);
      if (latest) latest.modelSettingsLoading = false;
    }
  }

  /** Update the session's model/thinking settings and reflect the result in state. */
  async updateModelSettings(
    projectId: string,
    sessionId: string,
    body: { provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel },
  ): Promise<void> {
    const entryKey = SessionStore.key(projectId, sessionId);
    this.attach(projectId, sessionId);
    this.dispatch(entryKey, { type: "set_model_settings_busy", busy: true });
    try {
      const settings = await this.client.updateSessionSettings(projectId, sessionId, body);
      this.dispatch(entryKey, { type: "set_model_settings", settings });
    } catch (err) {
      this.dispatch(entryKey, {
        type: "set_model_settings_error",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.dispatch(entryKey, { type: "set_model_settings_busy", busy: false });
    }
  }

  detach(projectId: string, sessionId: string): void {
    const entryKey = SessionStore.key(projectId, sessionId);
    const entry = this.entries.get(entryKey);
    if (!entry) return;
    entry.es.close();
    if (entry.poll) clearInterval(entry.poll);
    this.entries.delete(entryKey);
    this.listeners.delete(entryKey);
  }
}
