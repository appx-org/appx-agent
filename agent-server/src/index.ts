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
export { ProjectRuntime } from "./runtime/projectRuntime.js";
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
} from "./runtime/projectRuntime.js";
export { ProjectSession } from "./runtime/projectSession.js";
export type { SessionModelSettings } from "./runtime/projectSession.js";
export type { ExtensionUiRequest, ExtensionUiResponse } from "./shared/extensionUi.js";
export { ProjectRegistry } from "./runtime/projectRegistry.js";
export type {
	ProjectRegistryConfig,
	ProjectRuntimeContext,
} from "./runtime/projectRegistry.js";
export { AgentCredentialsService } from "./credentials/credentialsService.js";
export type {
	AgentCredentialsServiceConfig,
} from "./credentials/credentialsService.js";
export { createSessionsApp, createCredentialsApp } from "./http/routes.js";
export type {
	ProjectRuntimeResolver,
	CreateSessionsAppOptions,
	AgentCredentialsResolver,
	CreateCredentialsAppOptions,
} from "./http/routes.js";
export { litellmRuntimeConfig, logLiteLlmStartupConfig, resolveLiteLlmConfig } from "./providers/litellm.js";
export { THINKING_LEVELS, clampThinkingLevelForModel, supportedThinkingLevelsForModel } from "./shared/thinking.js";
export { subscribe, publish, channelStats } from "./http/sseBroker.js";
export type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionRuntimeDiagnostic,
	AgentSessionServices,
} from "@earendil-works/pi-coding-agent";
