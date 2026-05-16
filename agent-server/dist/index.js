/**
 * @appx/agent-server — pi-SDK-based agent orchestration, shared across Appx apps.
 *
 * Public surface:
 *   - AgentRuntime: stateful per-app orchestrator (sessions, auth, model registry)
 *   - createSessionsRouter: Express Router exposing REST + SSE over a runtime
 *   - SSE broker primitives (subscribe/publish/channelStats) for apps that want
 *     to publish their own non-session channels over the same plumbing
 *
 * Re-exports pi types that callers commonly need so apps don't have to depend
 * on @earendil-works/pi-coding-agent directly for typings.
 */
export { AgentRuntime } from "./runtime.js";
export { createSessionsRouter } from "./router.js";
export { subscribe, publish, channelStats } from "./sse.js";
