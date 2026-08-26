/**
 * Attachment storage for a project workspace.
 *
 * Attachments are opaque files the user uploads alongside a chat prompt. The
 * client never interprets them — it ships raw bytes; agent-server persists
 * them **inside the project directory** so the agent (whose cwd is the project
 * dir) can read them with its ordinary file tools whenever it decides it needs
 * to.
 *
 * On-disk layout (relative to projectDir):
 *
 *     attachments/<uuid>/<sanitized-original-filename>
 *
 * One directory per attachment keeps the original filename (useful context for
 * the agent: extension, human-readable name) without any collision handling,
 * and makes the attachment id ↔ path mapping trivial — no metadata sidecar
 * files, the filesystem is the registry.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/** Directory under projectDir holding all attachments. */
export const ATTACHMENTS_DIR = "attachments";

/** Attachment ids are always randomUUID()s; anything else is rejected. */
const ATTACHMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AttachmentInfo = {
	id: string;
	filename: string;
	/** Path relative to the project workspace root (what the agent sees). */
	path: string;
	size: number;
	createdAt: string;
};

/** Thrown when a prompt references an attachment id that was never uploaded. */
export class UnknownAttachmentError extends Error {
	constructor(id: string) {
		super(`unknown attachment id: ${id}`);
		this.name = "UnknownAttachmentError";
	}
}

/**
 * Reduce an untrusted client filename to a safe single path segment: strip
 * directories, control characters, and path separators. Falls back to "file"
 * if nothing survives.
 */
export function sanitizeFilename(filename: string): string {
	const base = basename(filename.replace(/\\/g, "/")).trim();
	const safe = base.replace(/[\u0000-\u001f/\\:]/g, "").replace(/^\.+$/, "");
	return safe.length > 0 ? safe : "file";
}

/** Persist an attachment under `<projectDir>/attachments/<id>/<filename>`. */
export function saveAttachment(projectDir: string, filename: string, data: Buffer): AttachmentInfo {
	const id = randomUUID();
	const safeName = sanitizeFilename(filename);
	const dir = join(projectDir, ATTACHMENTS_DIR, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, safeName), data);
	return {
		id,
		filename: safeName,
		path: `${ATTACHMENTS_DIR}/${id}/${safeName}`,
		size: data.length,
		createdAt: new Date().toISOString(),
	};
}

/**
 * Resolve an attachment id to its project-relative path. Throws
 * `UnknownAttachmentError` for malformed ids or ids with no stored file, so
 * routes can map that to a 400 while genuine I/O errors still surface as 500s.
 */
export function resolveAttachmentPath(projectDir: string, id: string): string {
	if (!ATTACHMENT_ID_RE.test(id)) throw new UnknownAttachmentError(id);
	const dir = join(projectDir, ATTACHMENTS_DIR, id);
	if (!existsSync(dir)) throw new UnknownAttachmentError(id);
	const [file] = readdirSync(dir);
	if (!file) throw new UnknownAttachmentError(id);
	return `${ATTACHMENTS_DIR}/${id}/${file}`;
}

/**
 * Append the attachment note to a user prompt. The note tells the agent where
 * the files live (relative to its cwd) and that reading them is optional —
 * the agent decides whether the task needs their contents.
 */
export function composePromptWithAttachments(text: string, relativePaths: string[]): string {
	if (relativePaths.length === 0) return text;
	const list = relativePaths.map((p) => `- ${p}`).join("\n");
	return `${text}\n\n[The user attached the following files. They are stored in the project workspace; read them with your file tools if the task needs their contents:\n${list}]`;
}
