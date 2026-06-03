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
export { ProjectRegistry, InvalidProjectNameError } from "./runtime/projectRegistry.js";
export type {
	ProjectRegistryConfig,
	ProjectInfo,
} from "./runtime/projectRegistry.js";
export { ProjectStore } from "./runtime/projectStore.js";
export type { ProjectRecord } from "./runtime/projectStore.js";
export { AgentCredentialsService } from "./credentials/credentialsService.js";
export type {
	AgentCredentialsServiceConfig,
} from "./credentials/credentialsService.js";
export { createSessionsApp } from "./http/sessionsRoutes.js";
export { createCredentialsApp } from "./http/credentialsRoutes.js";
export { createProjectsApp } from "./http/projectsRoutes.js";
export type {
	ProjectRuntimeResolver,
	CreateSessionsAppOptions,
} from "./http/sessionsRoutes.js";
export type {
	AgentCredentialsResolver,
	CreateCredentialsAppOptions,
} from "./http/credentialsRoutes.js";
export { litellmRuntimeConfig, logLiteLlmStartupConfig, resolveLiteLlmConfig } from "./providers/litellm.js";
export type { ServerConfig } from "./config.js";
export { THINKING_LEVELS, clampThinkingLevelForModel, supportedThinkingLevelsForModel } from "./shared/thinking.js";
export { subscribe, publish, channelStats } from "./http/sseBroker.js";
export type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionRuntimeDiagnostic,
	AgentSessionServices,
} from "@earendil-works/pi-coding-agent";
