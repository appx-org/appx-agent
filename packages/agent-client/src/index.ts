/**
 * agent-client — a customizable React UI for the appx agent-server.
 *
 * Quick start:
 * ```tsx
 * import { AgentChatProvider, AgentChat } from 'agent-client';
 * import 'agent-client/styles.css';
 *
 * <AgentChatProvider config={{ baseUrl: '/agent' }}>
 *   <AgentChat projectId="my-game" />
 * </AgentChatProvider>
 * ```
 *
 * For bespoke layouts, compose `SessionList` + `ChatPanel`, or drop down to the
 * `useAgentSession` hook and the framework-agnostic `core` (client/store/reducer).
 */

export type { components as AgentServerSchema, paths as AgentServerPaths } from "@appx-org/agent-protocol";
export type { AgentClientConfig, EventSourceLike } from "./core/client";
// Core (transport-agnostic) ------------------------------------------------
export { AgentClient, createAgentClient } from "./core/client";
export type { SessionAction } from "./core/reducer";
export { sessionReducer } from "./core/reducer";
export { SessionStore } from "./core/store";
export type {
	AgentAuthProvider,
	AgentCustomProvider,
	AgentCustomProviderApi,
	AgentCustomProviderModel,
	AgentEvent,
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
	MessageContent,
	Role,
	SessionState,
	SessionStatus,
	TextContent,
	ThinkingContent,
	ThinkingLevel,
	ToolCall,
	ToolResultMessage,
	UiMessage,
	UiMessagePart,
	UpsertCustomProviderRequest,
	WireEvent,
} from "./core/types";
export { initialSessionState } from "./core/types";
export type {
	AggregateSessionUsageOptions,
	ContextUsage,
	SessionUsageMetrics,
	UsageCost,
	UsageCostRates,
	UsageTokens,
} from "./core/usage";
export { aggregateSessionUsage, emptySessionUsageMetrics } from "./core/usage";
export type { AgentChatProps } from "./react/AgentChat";
export { AgentChat } from "./react/AgentChat";
export type { AgentSettingsProps } from "./react/AgentSettings";
export { AgentSettings } from "./react/AgentSettings";
export type { ChatPanelProps } from "./react/ChatPanel";
export { ChatPanel } from "./react/ChatPanel";
export type {
	AgentChatClassNames,
	AgentChatLabels,
	AgentChatProviderProps,
	UsageCostRatesResolver,
} from "./react/context";
// React layer --------------------------------------------------------------
export { AgentChatProvider, resolveCostRates, useAgentChatContext } from "./react/context";
export type { BlockingExtensionUiRequest, ExtensionRequestPanelProps } from "./react/ExtensionRequestPanel";
export { ExtensionRequestPanel, isBlockingRequest } from "./react/ExtensionRequestPanel";
export type { MarkdownProps } from "./react/Markdown";
export { Markdown } from "./react/Markdown";
export type { MessageItemProps } from "./react/MessageItem";
export { MessageItem } from "./react/MessageItem";
export type { MessageListProps } from "./react/MessageList";
export { MessageList } from "./react/MessageList";
export type { SessionListProps } from "./react/SessionList";
export { SessionList } from "./react/SessionList";
export type { ToolCallCardProps } from "./react/ToolCallCard";
export { ToolCallCard } from "./react/ToolCallCard";
export type { UsageBarLabels, UsageBarProps } from "./react/UsageBar";
export { UsageBar } from "./react/UsageBar";
export type { UseAgentSessionResult } from "./react/useAgentSession";
export { useAgentSession } from "./react/useAgentSession";
