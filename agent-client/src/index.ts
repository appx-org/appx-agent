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

// Core (transport-agnostic) ------------------------------------------------
export { AgentClient, createAgentClient } from './core/client';
export type { AgentClientConfig, EventSourceLike } from './core/client';
export { SessionStore } from './core/store';
export { sessionReducer } from './core/reducer';
export type { SessionAction } from './core/reducer';
export { initialSessionState } from './core/types';
export type {
  ThinkingLevel,
  AgentProject,
  AgentSessionInfo,
  AgentModel,
  AgentSessionModelSettings,
  ExtensionUiResponse,
  AgentAuthProvider,
  AgentOAuthFlowState,
  AgentCustomProvider,
  AgentCustomProviderModel,
  AgentCustomProviderApi,
  UpsertCustomProviderRequest,
  Role,
  AgentMessage,
  MessageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ContentBlock,
  ToolResultMessage,
  WireEvent,
  AgentEvent,
  AssistantMessageEvent,
  ExtensionUiRequest,
  UiMessage,
  UiMessagePart,
  SessionState,
  SessionStatus,
} from './core/types';
export { aggregateSessionUsage, emptySessionUsageMetrics } from './core/usage';
export type {
  SessionUsageMetrics,
  UsageTokens,
  UsageCost,
  UsageCostRates,
  ContextUsage,
  AggregateSessionUsageOptions,
} from './core/usage';
export type { components as AgentServerSchema, paths as AgentServerPaths } from './core/agent-server.generated';

// React layer --------------------------------------------------------------
export { AgentChatProvider, useAgentChatContext } from './react/context';
export type { AgentChatProviderProps, AgentChatClassNames, AgentChatLabels } from './react/context';
export { resolveCostRates } from './react/context';
export type { UsageCostRatesResolver } from './react/context';
export { useAgentSession } from './react/useAgentSession';
export type { UseAgentSessionResult } from './react/useAgentSession';
export { AgentChat } from './react/AgentChat';
export type { AgentChatProps } from './react/AgentChat';
export { ChatPanel } from './react/ChatPanel';
export type { ChatPanelProps } from './react/ChatPanel';
export { UsageBar } from './react/UsageBar';
export type { UsageBarProps, UsageBarLabels } from './react/UsageBar';
export { MessageItem } from './react/MessageItem';
export type { MessageItemProps } from './react/MessageItem';
export { MessageList } from './react/MessageList';
export type { MessageListProps } from './react/MessageList';
export { SessionList } from './react/SessionList';
export type { SessionListProps } from './react/SessionList';
export { ToolCallCard } from './react/ToolCallCard';
export type { ToolCallCardProps } from './react/ToolCallCard';
export { Markdown } from './react/Markdown';
export type { MarkdownProps } from './react/Markdown';
export { ExtensionRequestPanel, isBlockingRequest } from './react/ExtensionRequestPanel';
export type { ExtensionRequestPanelProps, BlockingExtensionUiRequest } from './react/ExtensionRequestPanel';
export { AgentSettings } from './react/AgentSettings';
export type { AgentSettingsProps } from './react/AgentSettings';
