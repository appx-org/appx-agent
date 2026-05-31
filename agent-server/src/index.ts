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
export { ProjectRuntime } from "./projectRuntime.js";
export type {
	AgentAuthProviderRow,
	AgentCustomProviderApi,
	AgentCustomProviderModel,
	AgentCustomProviderRow,
	AgentModelRow,
	AgentOAuthFlowState,
	ProjectRuntimeConfig,
	SessionRow,
	ThinkingLevel,
} from "./projectRuntime.js";
export { ProjectSession } from "./projectSession.js";
export type { SessionModelSettings } from "./projectSession.js";
export type { ExtensionUiRequest, ExtensionUiResponse } from "./extensionUi.js";
export { AgentRuntimeRegistry } from "./runtimeRegistry.js";
export type {
	AgentRuntimeRegistryConfig,
	ProjectRuntimeContext,
} from "./runtimeRegistry.js";
export { AgentCredentialsService } from "./credentialsService.js";
export type {
	AgentCredentialsServiceConfig,
} from "./credentialsService.js";
export { createSessionsApp, createCredentialsApp } from "./routes.js";
export type {
	ProjectRuntimeResolver,
	CreateSessionsAppOptions,
	AgentCredentialsResolver,
	CreateCredentialsAppOptions,
} from "./routes.js";
export { litellmRuntimeConfig, logLiteLlmStartupConfig, resolveLiteLlmConfig } from "./litellm.js";
export { THINKING_LEVELS, clampThinkingLevelForModel, supportedThinkingLevelsForModel } from "./thinking.js";
export { subscribe, publish, channelStats } from "./sseBroker.js";
export type {
	AgentSession,
	AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
