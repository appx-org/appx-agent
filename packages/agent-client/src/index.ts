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
export type { AgentClientConfig, EventSourceLike } from "./core/client.js";
// Core (transport-agnostic) ------------------------------------------------
export { AgentClient, createAgentClient } from "./core/client.js";
export type { SessionAction } from "./core/reducer.js";
export { sessionReducer } from "./core/reducer.js";
export { SessionStore } from "./core/store.js";
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
} from "./core/types.js";
export { initialSessionState } from "./core/types.js";
export type {
	AggregateSessionUsageOptions,
	ContextUsage,
	SessionUsageMetrics,
	UsageCost,
	UsageCostRates,
	UsageTokens,
} from "./core/usage.js";
export { aggregateSessionUsage, emptySessionUsageMetrics } from "./core/usage.js";
export type { AgentChatProps } from "./react/AgentChat.js";
export { AgentChat } from "./react/AgentChat.js";
export type { AgentSettingsProps } from "./react/AgentSettings.js";
export { AgentSettings } from "./react/AgentSettings.js";
export type { ChatPanelProps } from "./react/ChatPanel.js";
export { ChatPanel } from "./react/ChatPanel.js";
export type {
	AgentChatClassNames,
	AgentChatLabels,
	AgentChatProviderProps,
	UsageCostRatesResolver,
} from "./react/context.js";
// React layer --------------------------------------------------------------
export { AgentChatProvider, resolveCostRates, useAgentChatContext } from "./react/context.js";
export type { BlockingExtensionUiRequest, ExtensionRequestPanelProps } from "./react/ExtensionRequestPanel.js";
export { ExtensionRequestPanel, isBlockingRequest } from "./react/ExtensionRequestPanel.js";
export type { MarkdownProps } from "./react/Markdown.js";
export { Markdown } from "./react/Markdown.js";
export type { MessageItemProps } from "./react/MessageItem.js";
export { MessageItem } from "./react/MessageItem.js";
export type { MessageListProps } from "./react/MessageList.js";
export { MessageList } from "./react/MessageList.js";
export type { SessionListProps } from "./react/SessionList.js";
export { SessionList } from "./react/SessionList.js";
export type { ToolCallCardProps } from "./react/ToolCallCard.js";
export { ToolCallCard } from "./react/ToolCallCard.js";
export type { UsageBarLabels, UsageBarProps } from "./react/UsageBar.js";
export { UsageBar } from "./react/UsageBar.js";
export type { UseAgentSessionResult } from "./react/useAgentSession.js";
export { useAgentSession } from "./react/useAgentSession.js";
