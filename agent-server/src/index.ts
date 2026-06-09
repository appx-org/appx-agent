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

export type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionRuntimeDiagnostic,
	AgentSessionServices,
} from "@earendil-works/pi-coding-agent";
export type { ServerConfig } from "./config.js";
export type { AgentCredentialsServiceConfig } from "./credentials/credentialsService.js";
export { AgentCredentialsService } from "./credentials/credentialsService.js";
export type {
	AgentCredentialsResolver,
	CreateCredentialsAppOptions,
} from "./http/credentialsRoutes.js";
export { createCredentialsApp } from "./http/credentialsRoutes.js";
export { createProjectsApp } from "./http/projectsRoutes.js";
export type {
	CreateSessionsAppOptions,
	ProjectRuntimeResolver,
} from "./http/sessionsRoutes.js";
export { createSessionsApp } from "./http/sessionsRoutes.js";
export { channelStats, publish, subscribe } from "./http/sseBroker.js";
export { litellmRuntimeConfig, logLiteLlmStartupConfig, resolveLiteLlmConfig } from "./providers/litellm.js";
export type {
	ProjectInfo,
	ProjectRegistryConfig,
} from "./runtime/projectRegistry.js";
export { InvalidProjectNameError, ProjectRegistry } from "./runtime/projectRegistry.js";
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
export { ProjectRuntime } from "./runtime/projectRuntime.js";
export type { SessionModelSettings } from "./runtime/projectSession.js";
export { ProjectSession } from "./runtime/projectSession.js";
export type { ProjectRecord } from "./runtime/projectStore.js";
export { ProjectStore } from "./runtime/projectStore.js";
export type { ExtensionUiRequest, ExtensionUiResponse } from "./shared/extensionUi.js";
export { clampThinkingLevelForModel, supportedThinkingLevelsForModel, THINKING_LEVELS } from "./shared/thinking.js";
