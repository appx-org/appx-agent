/**
 * Core domain types.
 *
 * The **contract** types (REST DTOs, messages, content blocks, tool calls, the
 * SSE `WireEvent` union) come from `@appx-org/agent-protocol` — the published
 * agent-server contract package, generated from agent-server's OpenAPI
 * document. They are re-exported here so the rest of this package (and its
 * public API) keeps importing from one place.
 *
 * The **UI-derived** types (`UiMessage`, `SessionState`) are ours — the reducer
 * builds them from wire events for rendering — so they stay hand-written.
 */
import type {
	AgentMessage,
	AgentModel,
	AgentSessionModelSettings,
	ContentBlock,
	ExtensionUiRequest,
	Role,
	WireEvent,
} from "@appx-org/agent-protocol";

export type {
	AgentAuthProvider,
	AgentCustomProvider,
	AgentCustomProviderApi,
	AgentCustomProviderModel,
	AgentMessage,
	AgentModel,
	AgentOAuthFlowState,
	AgentProject,
	AgentSessionInfo,
	AgentSessionModelSettings,
	AssistantMessageEvent,
	ContentBlock,
	ExtensionUiRequest,
	ExtensionUiResponse,
	Role,
	TextContent,
	ThinkingContent,
	ThinkingLevel,
	ToolCall,
	ToolResultMessage,
	UpsertCustomProviderRequest,
	WireEvent,
} from "@appx-org/agent-protocol";

/** A content block as seen by the reducer (canonical blocks or an opaque object). */
export type MessageContent = ContentBlock | Record<string, unknown>;

/** Every SSE event the reducer interprets (alias of the published `WireEvent`). */
export type AgentEvent = WireEvent;

/** The in-progress assistant message carried by streaming sub-events. */
export type AssistantMessagePartial = { content?: ContentBlock[] };

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
