/**
 * Zod schemas for the agent-server REST API.
 *
 * These are the source of truth for:
 *   - request/response validation at runtime (via @hono/zod-openapi)
 *   - the OpenAPI 3.1 document published at /openapi.json
 *   - generated TypeScript types for consumers (eventx-backend uses
 *     `openapi-typescript` against the published openapi.json)
 *
 * The SSE `AgentSessionEvent` wire contract is NOT authored here. It is
 * generated from pi's TypeScript types via typia (`scripts/genEventSchema.ts`
 * → `eventSchema.generated.json`) and merged into the OpenAPI document by
 * `openapiEventSchema.ts`, so consumers codegen the event/message types from
 * the same `openapi.json` as the REST surface. pi stays the source of truth for
 * its shapes; agent-server owns and versions the published contract.
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

export const AuthProviderRowSchema = z
	.object({
		provider: z.string(),
		name: z.string(),
		configured: z.boolean(),
		credentialType: z.enum(["api_key", "oauth"]).optional(),
		source: z
			.enum(["stored", "runtime", "environment", "fallback", "models_json_key", "models_json_command"])
			.optional(),
		label: z.string().optional(),
		supportsApiKey: z.boolean(),
		supportsSubscription: z.boolean(),
		modelCount: z.number().int().nonnegative(),
		availableModelCount: z.number().int().nonnegative(),
	})
	.openapi("AuthProviderRow");

export const ListAuthProvidersResponseSchema = z
	.object({
		providers: z.array(AuthProviderRowSchema),
	})
	.openapi("ListAuthProvidersResponse");

export const SetProviderApiKeyRequestSchema = z
	.object({
		key: z.string().min(1),
	})
	.openapi("SetProviderApiKeyRequest");

export const OAuthFlowStateSchema = z
	.object({
		id: z.string(),
		provider: z.string(),
		providerName: z.string(),
		status: z.enum(["starting", "prompt", "auth", "waiting", "complete", "error", "cancelled"]),
		authUrl: z.string().optional(),
		instructions: z.string().optional(),
		prompt: z
			.object({
				message: z.string(),
				placeholder: z.string().optional(),
				allowEmpty: z.boolean().optional(),
			})
			.optional(),
		progress: z.array(z.string()),
		error: z.string().optional(),
		expiresAt: z.string(),
	})
	.openapi("OAuthFlowState");

export const ContinueOAuthFlowRequestSchema = z
	.object({
		value: z.string(),
	})
	.openapi("ContinueOAuthFlowRequest");

export const OAuthFlowIdParamSchema = z.object({
	flowId: z.string().min(1).openapi({ param: { name: "flowId", in: "path" } }),
});

export const CustomProviderModelSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().optional(),
		api: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]).optional(),
		reasoning: z.boolean().optional(),
		thinkingLevelMap: z.record(z.union([z.string(), z.null()])).optional(),
		input: z.array(z.enum(["text", "image"])).optional(),
		contextWindow: z.number().int().positive().optional(),
		maxTokens: z.number().int().positive().optional(),
		compat: z.record(z.unknown()).optional(),
	})
	.openapi("CustomProviderModel");

export const CustomProviderRowSchema = z
	.object({
		provider: z.string(),
		name: z.string().optional(),
		baseUrl: z.string().optional(),
		api: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]).optional(),
		apiKeyConfigured: z.boolean(),
		modelCount: z.number().int().nonnegative(),
		models: z.array(CustomProviderModelSchema),
	})
	.openapi("CustomProviderRow");

export const ListCustomProvidersResponseSchema = z
	.object({
		providers: z.array(CustomProviderRowSchema),
	})
	.openapi("ListCustomProvidersResponse");

export const UpsertCustomProviderRequestSchema = z
	.object({
		provider: z.string().min(1).regex(/^[a-zA-Z0-9_.:-]+$/),
		name: z.string().optional(),
		baseUrl: z.string().url(),
		api: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]),
		apiKey: z.string().optional(),
		models: z.array(CustomProviderModelSchema).min(1),
	})
	.openapi("UpsertCustomProviderRequest");

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
 * Pi message shapes are rich (roles toolCall / toolResult, content parts, tool
 * ids, etc.) and owned by pi, not this server. At **runtime** we forward
 * whatever pi has persisted without re-validating it (`z.array(z.unknown())`),
 * so a new pi message field never makes this endpoint 500.
 *
 * In the **published contract**, though, the array items are rewritten to
 * `$ref` the canonical `AgentMessage` component (see `openapiEventSchema.ts`),
 * so SDK consumers get the real message union instead of `unknown[]` — the
 * client has to parse these, so the type is the whole point.
 */
export const SessionMessagesResponseSchema = z
	.object({
		id: z.string(),
		messages: z.array(z.unknown()).openapi({
			description:
				"Pi-shaped message objects. Forwarded as-is at runtime; published as AgentMessage[] in the contract.",
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
		// Runtime-permissive (forwarded pi RPC events); published as ExtensionUiRequest[]
		// in the contract via $ref rewrite in openapiEventSchema.ts.
		requests: z.array(z.unknown()).openapi({
			description:
				"Pending extension UI request events. Forwarded as-is at runtime; published as ExtensionUiRequest[] in the contract.",
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

/** Path param for project lifecycle routes (`/v1/projects/{id}`). */
export const ProjectIdParamSchema = z.object({
	id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }),
});

/** Body for `POST /v1/projects`. Name-only — the id/dir are derived server-side. */
export const CreateProjectRequestSchema = z
	.object({
		name: z.string().min(1).openapi({
			example: "My Cool App",
			description:
				"Human-facing project name. Slugified into the immutable id and directory name.",
		}),
	})
	.openapi("CreateProjectRequest");

/** Public view of a project returned by the lifecycle routes. */
export const ProjectInfoSchema = z
	.object({
		id: z.string().openapi({
			example: "my-cool-app",
			description: "Immutable slug; registry key, route param, and directory name.",
		}),
		name: z.string().openapi({ example: "My Cool App" }),
		projectDir: z.string().openapi({
			example: "/workspace/my-cool-app",
			description: "Absolute working directory under WORKSPACE_DIR.",
		}),
		createdAt: z.string().openapi({
			example: "2026-06-03T10:00:00.000Z",
			description: "ISO-8601 UTC timestamp",
		}),
	})
	.openapi("ProjectInfo");

export const ListProjectsResponseSchema = z
	.object({
		projects: z.array(ProjectInfoSchema),
	})
	.openapi("ListProjectsResponse");

export const ProviderParamSchema = z.object({
	provider: z
		.string()
		.min(1)
		.regex(/^[a-zA-Z0-9_.:-]+$/)
		.openapi({ param: { name: "provider", in: "path" } }),
});
