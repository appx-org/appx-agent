/**
 * Friendly aliases over the generated contract types.
 *
 * Everything here is **derived** from `schema.generated.ts`, which is produced
 * by `npm run gen:types` (openapi-typescript) from this package's
 * `openapi.json`. That OpenAPI document is itself generated from agent-server's
 * zod schemas and pi's TypeScript types, so the field names here are the
 * canonical contract — no hand-mirroring, no guessing between `id` /
 * `toolCallId` / `tool_use_id`.
 *
 * These aliases are the ergonomic names consumers (agent-client, appx-like
 * control planes, …) import instead of indexing into
 * `components["schemas"][...]` themselves.
 */
import type { components } from "./schema.generated";

type Schemas = components["schemas"];

// ---------------------------------------------------------------------------
// REST DTOs (generated from the agent-server /v1 contract)
// ---------------------------------------------------------------------------

export type ThinkingLevel = Schemas["ThinkingLevel"];
/** A project as returned by `GET/POST /v1/projects`. */
export type AgentProject = Schemas["ProjectInfo"];
/** A session row as returned by `GET /v1/projects/{id}/sessions`. */
export type AgentSessionInfo = Schemas["SessionRow"];
/** Non-secret model metadata from `GET /v1/sessions/models`. */
export type AgentModel = Schemas["AgentModelRow"];
/** Active model/thinking settings for a session. */
export type AgentSessionModelSettings = Schemas["SessionModelSettingsResponse"];
/** Body accepted by the extension-ui response endpoint. */
export type ExtensionUiResponse = Schemas["ExtensionUiResponseRequest"];

// ---------------------------------------------------------------------------
// Credential / provider-auth DTOs (generated from the /v1/auth + /v1/custom contract)
// ---------------------------------------------------------------------------

/** Non-secret provider auth status from `GET /v1/auth/providers`. */
export type AgentAuthProvider = Schemas["AuthProviderRow"];
/** State of a subscription (OAuth) login flow. */
export type AgentOAuthFlowState = Schemas["OAuthFlowState"];
/** The wire API style a custom provider's model speaks. */
export type AgentCustomProviderApi = NonNullable<Schemas["CustomProviderModel"]["api"]>;
/** A single model definition within a custom provider. */
export type AgentCustomProviderModel = Schemas["CustomProviderModel"];
/** A custom (models.json) provider as returned by `GET /v1/custom/providers`. */
export type AgentCustomProvider = Schemas["CustomProviderRow"];
/** Body accepted by `PUT /v1/custom/providers`. */
export type UpsertCustomProviderRequest = Schemas["UpsertCustomProviderRequest"];

// ---------------------------------------------------------------------------
// Transcript messages + content blocks (generated; canonical pi shapes)
// ---------------------------------------------------------------------------

export type Role = "user" | "assistant" | "system" | "tool" | "toolResult";

export type TextContent = Schemas["TextContent"];
export type ThinkingContent = Schemas["ThinkingContent"];
/** A tool-call content block: `{ type: 'toolCall'; id; name; arguments }`. */
export type ToolCall = Schemas["ToolCall"];
/** A block within an assistant message's `content` array. */
export type ContentBlock = Schemas["AssistantMessage"]["content"][number];
/** A tool-result message: `{ role: 'toolResult'; toolCallId; toolName; content; isError }`. */
export type ToolResultMessage = Schemas["ToolResultMessageany"];

/**
 * A transcript message: the canonical pi `AgentMessage` union (user / assistant
 * / tool-result / custom message shapes). Consumers narrow it by `role`.
 */
export type AgentMessage = Schemas["AgentMessage"];

// ---------------------------------------------------------------------------
// SSE event union — fully derived from the generated contract.
//
// `WireEvent` is the published union of every event agent-server forwards (pi's
// `AgentSessionEvent` + the injected `extension_ui_request` / `extension_error`
// events). There is no hand-written mirror of pi's event shapes.
// ---------------------------------------------------------------------------

/** The full, contract-published wire event union (pi events + injected events). */
export type WireEvent = Schemas["WireEvent"];

/** The streaming sub-event carried by `message_update.assistantMessageEvent`. */
export type AssistantMessageEvent = Schemas["AssistantMessageEvent"];

/** An extension-UI request event (pi RPC extension UI), extracted from the union. */
export type ExtensionUiRequest = Extract<WireEvent, { type: "extension_ui_request" }>;
