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
import {
	AttachmentInfoSchema,
	ErrorResponseSchema,
	ProjectScopeParamSchema,
	UploadAttachmentRequestSchema,
} from "../contract/schemas.js";
import type { ProjectRuntime } from "../runtime/projectRuntime.js";

export type ProjectRuntimeResolver = (c: Context) => ProjectRuntime | Promise<ProjectRuntime>;

/** Reject payloads that aren't plausibly base64 before handing them to Buffer (which never throws). */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Build the Hono app exposing a project's attachment routes. Versioning /
 * prefixing is the caller's job (server.ts mounts this under
 * /v1/projects/:projectId).
 */
export function createAttachmentsApp(getRuntime: ProjectRuntimeResolver): OpenAPIHono {
	const app = new OpenAPIHono();

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
			},
		}),
		async (c) => {
			const runtime = await getRuntime(c);
			const { filename, contentBase64 } = c.req.valid("json");
			const normalized = contentBase64.replace(/\s/g, "");
			if (!BASE64_RE.test(normalized)) {
				return c.json({ error: "contentBase64 is not valid base64" }, 400);
			}
			const data = Buffer.from(normalized, "base64");
			const info = runtime.saveAttachment(filename, data);
			return c.json(info, 200);
		},
	);

	return app;
}
