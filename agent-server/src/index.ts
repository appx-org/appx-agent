/**
 * @appx/agent-server — pi-SDK-based agent orchestration.
 *
 * Primary deployment is the standalone HTTP/SSE server in `./server.ts`,
 * launched via `npm start` or the published `agent-server` bin.
 *
 * Library exports below let advanced callers embed the runtime in a
 * larger Node process (for tests, or for hosts that prefer to mount
 * our routes inside their own Hono app).
 */
export { AgentRuntime } from "./runtime.js";
export type {
	AgentAuthProviderRow,
	AgentCustomProviderApi,
	AgentCustomProviderModel,
	AgentCustomProviderRow,
	AgentModelRow,
	AgentOAuthFlowState,
	AgentRuntimeConfig,
	ExtensionUiRequest,
	ExtensionUiResponse,
	SessionModelSettings,
	SessionRow,
	ThinkingLevel,
} from "./runtime.js";
export { AgentRuntimeRegistry } from "./runtimeRegistry.js";
export type {
	AgentRuntimeRegistryConfig,
	ProjectRuntimeContext,
} from "./runtimeRegistry.js";
export { createSessionsApp } from "./routes.js";
export type { AgentRuntimeResolver } from "./routes.js";
export { litellmRuntimeConfig, logLiteLlmStartupConfig, resolveLiteLlmConfig } from "./litellm.js";
export { subscribe, publish, channelStats } from "./sseBroker.js";
export type {
	AgentSession,
	AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
