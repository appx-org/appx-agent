/**
 * Core domain types.
 *
 * The **contract** types (REST DTOs, messages, content blocks, tool calls) are
 * derived from `agent-server.generated.ts`, which is produced by
 * `npm run gen:api` (openapi-typescript) from agent-server's `openapi.json`.
 * That OpenAPI schema is itself generated from pi's TypeScript types, so the
 * field names here are the canonical contract — no hand-mirroring, no guessing
 * between `id` / `toolCallId` / `tool_use_id`.
 *
 * The **UI-derived** types (`UiMessage`, `SessionState`) are ours — the reducer
 * builds them from wire events for rendering — so they stay hand-written.
 *
 * To refresh after an agent-server change: re-vendor `openapi/agent-server.json`
 * and run `npm run gen:api`.
 */
import type { components } from "./agent-server.generated";

type Schemas = components["schemas"];

// ---------------------------------------------------------------------------
// REST DTOs (generated from the agent-server /v1 contract)
// ---------------------------------------------------------------------------

export type ThinkingLevel = Schemas["ThinkingLevel"];
/** A project as returned by `GET/POST /v1/projects`. */
export type AgentProject = Schemas["ProjectInfo"];
/** A session row as returned by `GET /v1/projects/{id}/sessions`. */
export type AgentSessionInfo = Schemas["SessionRow"];
/** Non-secret model metadata from `GET /v1/sessions/models`. */
export type AgentModel = Schemas["AgentModelRow"];
/** Active model/thinking settings for a session. */
export type AgentSessionModelSettings = Schemas["SessionModelSettingsResponse"];
/** Body accepted by the extension-ui response endpoint. */
export type ExtensionUiResponse = Schemas["ExtensionUiResponseRequest"];

// ---------------------------------------------------------------------------
// Credential / provider-auth DTOs (generated from the /v1/auth + /v1/custom contract)
// ---------------------------------------------------------------------------

/** Non-secret provider auth status from `GET /v1/auth/providers`. */
export type AgentAuthProvider = Schemas["AuthProviderRow"];
/** State of a subscription (OAuth) login flow. */
export type AgentOAuthFlowState = Schemas["OAuthFlowState"];
/** The wire API style a custom provider's model speaks. */
export type AgentCustomProviderApi = NonNullable<Schemas["CustomProviderModel"]["api"]>;
/** A single model definition within a custom provider. */
export type AgentCustomProviderModel = Schemas["CustomProviderModel"];
/** A custom (models.json) provider as returned by `GET /v1/custom/providers`. */
export type AgentCustomProvider = Schemas["CustomProviderRow"];
/** Body accepted by `PUT /v1/custom/providers`. */
export type UpsertCustomProviderRequest = Schemas["UpsertCustomProviderRequest"];

// ---------------------------------------------------------------------------
// Transcript messages + content blocks (generated; canonical pi shapes)
// ---------------------------------------------------------------------------

export type Role = "user" | "assistant" | "system" | "tool" | "toolResult";

export type TextContent = Schemas["TextContent"];
export type ThinkingContent = Schemas["ThinkingContent"];
/** A tool-call content block: `{ type: 'toolCall'; id; name; arguments }`. */
export type ToolCall = Schemas["ToolCall"];
/** A block within an assistant message's `content` array. */
export type ContentBlock = Schemas["AssistantMessage"]["content"][number];
/** A tool-result message: `{ role: 'toolResult'; toolCallId; toolName; content; isError }`. */
export type ToolResultMessage = Schemas["ToolResultMessageany"];

/** A content block as seen by the reducer (canonical blocks or an opaque object). */
export type MessageContent = ContentBlock | Record<string, unknown>;

/**
 * A transcript message: the canonical pi `AgentMessage` union (user / assistant
 * / tool-result / custom message shapes). The reducer narrows it by `role`.
 */
export type AgentMessage = Schemas["AgentMessage"];

/** The in-progress assistant message carried by streaming sub-events. */
export type AssistantMessagePartial = { content?: ContentBlock[] };

// ---------------------------------------------------------------------------
// SSE event union — fully derived from the generated contract.
//
// `WireEvent` is the published union of every event agent-server forwards (pi's
// `AgentSessionEvent` + the injected `extension_ui_request` / `extension_error`
// events). The reducer interprets these directly — there is no hand-written
// mirror of pi's event shapes.
// ---------------------------------------------------------------------------

/** The full, contract-published wire event union (pi events + injected events). */
export type WireEvent = Schemas["WireEvent"];

/** Every SSE event the reducer interprets (alias of the published `WireEvent`). */
export type AgentEvent = WireEvent;

/** The streaming sub-event carried by `message_update.assistantMessageEvent`. */
export type AssistantMessageEvent = Schemas["AssistantMessageEvent"];

/** An extension-UI request event (pi RPC extension UI), extracted from the union. */
export type ExtensionUiRequest = Extract<WireEvent, { type: "extension_ui_request" }>;

// ---------------------------------------------------------------------------
// Derived UI state
// ---------------------------------------------------------------------------

export type UiMessagePart =
  | { type: "text"; text: string; contentIndex?: number }
  | {
      type: "tool";
      id: string;
      name: string;
      contentIndex?: number;
      args?: unknown;
      result?: unknown;
      isError?: boolean;
      status: "pending" | "running" | "done" | "error";
    };

export type UiMessage = {
  /**
   * Stable identity for React keying + `React.memo` bail-out. Assigned by the
   * reducer when a message is created and preserved across every subsequent
   * update, so memoized message/part components only re-render when their own
   * data changes (critical during high-frequency streaming).
   */
  id: string;
  role: Role;
  parts: UiMessagePart[];
  streaming: boolean;
  timestamp: string | number;
  /**
   * Client-generated correlation id set on an optimistic user bubble until the
   * server echoes it back via `message_start`. The reducer reconciles the echo
   * against the oldest still-pending id (FIFO) instead of comparing message
   * text, so two identical prompts in a row can't mis-dedupe. Cleared once the
   * server echo has been reconciled.
   */
  promptId?: string;
};

export type SessionStatus = "idle" | "starting" | "streaming";

export type SessionState = {
  sessionId: string | null;
  messages: UiMessage[];
  /**
   * The raw wire transcript (canonical `AgentMessage[]`), kept alongside the
   * derived `messages` because usage aggregation needs fields the UI shape
   * drops — `usage`, `stopReason`, and `compactionSummary` markers. Seeded from
   * REST history and kept current from `message_end` / `compaction_end` events;
   * folded by `aggregateSessionUsage` into per-session cost/cache/context.
   */
  rawMessages: AgentMessage[];
  /** Monotonic counter backing stable ids for live (streamed) messages. */
  messageSeq: number;
  /**
   * Correlation ids of optimistic user bubbles still awaiting their server
   * echo, in submission order (FIFO). The reducer shifts the oldest id when a
   * user `message_start` arrives to reconcile the matching bubble.
   */
  pendingPromptIds: string[];
  extensionRequests: ExtensionUiRequest[];
  extensionStatus: Record<string, string>;
  extensionNotice: {
    id: string;
    message: string;
    type?: "info" | "warning" | "error";
  } | null;
  status: SessionStatus;
  error: string | null;
  connected: boolean;
  /**
   * Single source of truth for the session's model/thinking controls. Owned by
   * the store (loaded once on demand, refreshed only when the user changes a
   * setting) instead of being duplicated in component-local React state.
   */
  models: AgentModel[];
  modelSettings: AgentSessionModelSettings | null;
  /** True while a model/thinking-level update request is in flight. */
  modelSettingsBusy: boolean;
  /** Last model-settings load/update failure, surfaced to the controls. */
  modelSettingsError: string | null;
};

export const initialSessionState: SessionState = {
  sessionId: null,
  messages: [],
  rawMessages: [],
  messageSeq: 0,
  pendingPromptIds: [],
  extensionRequests: [],
  extensionStatus: {},
  extensionNotice: null,
  status: "idle",
  error: null,
  connected: false,
  models: [],
  modelSettings: null,
  modelSettingsBusy: false,
  modelSettingsError: null,
};
