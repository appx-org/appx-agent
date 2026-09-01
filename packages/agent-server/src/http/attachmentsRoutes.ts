/**
 * HTTP routes for project attachments — files the user uploads alongside chat
 * prompts. The client treats them as opaque bytes; agent-server stores them in
 * the project workspace (`attachments/<id>/<filename>`) so the agent can read
 * them with its file tools when a prompt references them.
 *
 * Surface (mounted by the server under /v1/projects/:projectId):
 *   POST /attachments   upload one attachment (JSON base64 body)
 *
 * Content travels as base64 inside JSON rather than multipart so the whole
 * contract pipeline (zod-openapi → openapi.json → generated types →
 * openapi-fetch) stays uniformly typed. See UploadAttachmentRequestSchema for
 * the size cap.
 */
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
	AttachmentInfoSchema,
	ErrorResponseSchema,
	MAX_ATTACHMENT_BASE64_CHARS,
	ProjectScopeParamSchema,
	UploadAttachmentRequestSchema,
} from "../contract/schemas.js";
import { AttachmentQuotaError } from "../runtime/attachments.js";
import type { ProjectRuntime } from "../runtime/projectRuntime.js";

export type ProjectRuntimeResolver = (c: Context) => ProjectRuntime | Promise<ProjectRuntime>;

/**
 * Strict standard base64: groups of 4, with only the final group padded. The
 * length check matters — `Buffer.from(s, "base64")` never throws and silently
 * drops a trailing partial group, so a truncated payload would otherwise be
 * stored as a corrupt file with a `size` that doesn't match what was uploaded.
 */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Hard cap on the request body. Without it the ~25 MB `contentBase64` cap is
 * enforced only *after* Hono has read and JSON-parsed the whole body, so a
 * single huge upload could exhaust the memory of the process serving every
 * project. The slack covers the JSON envelope and the filename.
 */
const MAX_BODY_BYTES = MAX_ATTACHMENT_BASE64_CHARS + 8 * 1024;

export type AttachmentsAppOptions = {
	/** Override the request body limit. Only tests need this. */
	maxBodyBytes?: number;
};

/**
 * Build the Hono app exposing a project's attachment routes. Versioning /
 * prefixing is the caller's job (server.ts mounts this under
 * /v1/projects/:projectId).
 */
export function createAttachmentsApp(
	getRuntime: ProjectRuntimeResolver,
	{ maxBodyBytes = MAX_BODY_BYTES }: AttachmentsAppOptions = {},
): OpenAPIHono {
	const app = new OpenAPIHono({
		// Shape validation failures as the documented ErrorResponse instead of
		// leaking a raw zod issue tree the client can't render.
		defaultHook: (result, c) => {
			if (result.success) return;
			const detail = result.error.issues
				.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
				.join("; ");
			return c.json({ error: `invalid attachment upload — ${detail}` }, 400);
		},
	});

	app.use(
		"/attachments",
		bodyLimit({
			maxSize: maxBodyBytes,
			onError: (c) => c.json({ error: `attachment body exceeds ${maxBodyBytes} bytes` }, 413),
		}),
	);

	// ── POST /attachments ────────────────────────────────────────────
	app.openapi(
		createRoute({
			method: "post",
			path: "/attachments",
			operationId: "uploadAttachment",
			tags: ["attachments"],
			summary: "Upload an attachment into the project workspace.",
			description:
				"Stores the file under `attachments/<id>/<filename>` in the project " +
				"directory. Reference the returned id in `POST /sessions/{id}/prompt` " +
				"(`attachments`) so the agent knows where to find it.",
			request: {
				params: ProjectScopeParamSchema,
				body: {
					required: true,
					content: { "application/json": { schema: UploadAttachmentRequestSchema } },
				},
			},
			responses: {
				200: {
					description: "Stored attachment metadata.",
					content: { "application/json": { schema: AttachmentInfoSchema } },
				},
				400: {
					description: "Invalid base64 content.",
					content: { "application/json": { schema: ErrorResponseSchema } },
				},
				413: {
					description: "Body too large, or the project's attachment quota is exhausted.",
					content: { "application/json": { schema: ErrorResponseSchema } },
				},
			},
		}),
		async (c) => {
			const runtime = await getRuntime(c);
			const { filename, contentBase64 } = c.req.valid("json");
			const normalized = contentBase64.replace(/\s/g, "");
			if (!BASE64_RE.test(normalized)) {
				return c.json({ error: "contentBase64 is not valid standard base64" }, 400);
			}
			const data = Buffer.from(normalized, "base64");
			try {
				return c.json(runtime.saveAttachment(filename, data), 200);
			} catch (err) {
				if (err instanceof AttachmentQuotaError) return c.json({ error: err.message }, 413);
				throw err;
			}
		},
	);

	return app;
}
