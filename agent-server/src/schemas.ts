/**
 * Zod schemas for the agent-server REST API.
 *
 * These are the source of truth for:
 *   - request/response validation at runtime (via @hono/zod-openapi)
 *   - the OpenAPI 3.1 document published at /openapi.json
 *   - generated TypeScript types for consumers (eventx-backend uses
 *     `openapi-typescript` against the published openapi.json)
 *
 * The pi-shaped AgentSessionEvent on the SSE stream is intentionally not
 * fully modeled here. Pi owns that contract; locking it down in two places
 * would drift. The SSE endpoint is documented in OpenAPI but typed loosely
 * (string content under `text/event-stream`); consumers parse `data:` JSON
 * payloads using their own knowledge of pi's event shape.
 */
import { z } from "@hono/zod-openapi";

/** A row in the sessions list. Stable shape across all consuming apps. */
export const SessionRowSchema = z
	.object({
		id: z.string().openapi({ example: "01J9Z..." }),
		createdAt: z.string().openapi({
			example: "2026-05-17T10:00:00.000Z",
			description: "ISO-8601 UTC timestamp",
		}),
		firstMessage: z.string().openapi({
			description: "First user message; empty for never-prompted sessions.",
		}),
		messageCount: z.number().int().nonnegative(),
	})
	.openapi("SessionRow");

export const ListSessionsResponseSchema = z
	.object({
		sessions: z.array(SessionRowSchema),
	})
	.openapi("ListSessionsResponse");

export const ThinkingLevelSchema = z
	.enum(["off", "minimal", "low", "medium", "high", "xhigh"])
	.openapi("ThinkingLevel");

export const AgentModelRowSchema = z
	.object({
		provider: z.string(),
		id: z.string(),
		name: z.string(),
		api: z.string(),
		reasoning: z.boolean(),
		available: z.boolean(),
		input: z.array(z.enum(["text", "image"])),
		contextWindow: z.number().int().nonnegative(),
		maxTokens: z.number().int().nonnegative(),
		defaultThinkingLevel: ThinkingLevelSchema.optional(),
	})
	.openapi("AgentModelRow");

export const ListModelsResponseSchema = z
	.object({
		models: z.array(AgentModelRowSchema),
	})
	.openapi("ListModelsResponse");

export const SessionModelSettingsResponseSchema = z
	.object({
		model: AgentModelRowSchema.nullable(),
		thinkingLevel: ThinkingLevelSchema,
		availableThinkingLevels: z.array(ThinkingLevelSchema),
		supportsThinking: z.boolean(),
		isStreaming: z.boolean(),
	})
	.openapi("SessionModelSettingsResponse");

export const PatchSessionSettingsRequestSchema = z
	.object({
		provider: z.string().min(1).optional(),
		modelId: z.string().min(1).optional(),
		thinkingLevel: ThinkingLevelSchema.optional(),
	})
	.openapi("PatchSessionSettingsRequest");

export const CreateSessionResponseSchema = z
	.object({
		id: z.string(),
		createdAt: z.string(),
	})
	.openapi("CreateSessionResponse");

/**
 * Pi message shape is rich (roles toolCall / toolResult, content parts,
 * tool ids, etc.). We forward whatever pi has persisted; the consumer
 * frontend interprets it. Documented as opaque objects to keep this
 * server's contract decoupled from pi's internal evolution.
 */
export const SessionMessagesResponseSchema = z
	.object({
		id: z.string(),
		messages: z.array(z.unknown()).openapi({
			description: "Pi-shaped message objects (role + content array). Opaque here.",
		}),
	})
	.openapi("SessionMessagesResponse");

export const PromptRequestSchema = z
	.object({
		text: z.string().min(1).openapi({ example: "find me events this weekend" }),
	})
	.openapi("PromptRequest");

export const OkResponseSchema = z
	.object({
		ok: z.literal(true),
	})
	.openapi("OkResponse");

export const ExtensionUiRequestIdParamSchema = z.object({
	requestId: z.string().min(1).openapi({ param: { name: "requestId", in: "path" } }),
});

export const ExtensionUiResponseRequestSchema = z
	.union([
		z.object({ value: z.string() }),
		z.object({ confirmed: z.boolean() }),
		z.object({ cancelled: z.literal(true) }),
	])
	.openapi("ExtensionUiResponseRequest");

export const PendingExtensionUiRequestsResponseSchema = z
	.object({
		requests: z.array(z.unknown()).openapi({
			description: "Pending extension UI request events. Shape follows Pi RPC extension_ui_request events.",
		}),
	})
	.openapi("PendingExtensionUiRequestsResponse");

export const ErrorResponseSchema = z
	.object({
		error: z.string(),
	})
	.openapi("ErrorResponse");

export const HealthResponseSchema = z
	.object({
		ok: z.literal(true),
		service: z.literal("agent-server"),
		time: z.string(),
		channels: z.record(z.number()).openapi({
			description: "Map of SSE channel name → current subscriber count.",
		}),
	})
	.openapi("HealthResponse");

export const SessionIdParamSchema = z.object({
	id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }),
});
