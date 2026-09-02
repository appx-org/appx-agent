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
 *
 * The directory sits in the project dir, which is also the container build
 * context for the deployed app, so app templates must exclude `attachments/`
 * in their `.dockerignore` (see builder-agent/skills/deploy-app).
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/** Directory under projectDir holding all attachments. */
export const ATTACHMENTS_DIR = "attachments";

/** Attachment ids are always randomUUID()s; anything else is rejected. */
const ATTACHMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Cap on a stored filename's UTF-8 byte length. POSIX filesystems cap a path
 * segment at 255 **bytes**, so a filename validated by character count can
 * still fail with ENAMETOOLONG; we truncate well under the limit instead.
 */
const MAX_FILENAME_BYTES = 200;

/** Total bytes one project's attachments may occupy before uploads are refused. */
export const MAX_PROJECT_ATTACHMENT_BYTES = 200 * 1024 * 1024;

/**
 * Delimiters wrapping the attachment note appended to a prompt. agent-client
 * strips this block from the user's rendered message (see its reducer) so the
 * internal note is never shown as text the user wrote — keep the two in sync.
 */
export const ATTACHMENT_NOTE_OPEN = "<attached-files>";
export const ATTACHMENT_NOTE_CLOSE = "</attached-files>";

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

/** Thrown when storing an attachment would exceed the project's attachment quota. */
export class AttachmentQuotaError extends Error {
	constructor(usedBytes: number, incomingBytes: number) {
		super(
			`attachment quota exceeded: ${usedBytes + incomingBytes} bytes would exceed the ` +
				`${MAX_PROJECT_ATTACHMENT_BYTES} byte per-project limit`,
		);
		this.name = "AttachmentQuotaError";
	}
}

/** Truncate to at most `maxBytes` of UTF-8 without splitting a code point. */
function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value) <= maxBytes) return value;
	let out = "";
	let bytes = 0;
	for (const char of value) {
		const size = Buffer.byteLength(char);
		if (bytes + size > maxBytes) break;
		out += char;
		bytes += size;
	}
	return out;
}

/**
 * Reduce an untrusted client filename to a safe single path segment: strip
 * directories, control characters, and path separators, then bound its UTF-8
 * byte length (keeping the extension). Falls back to "file" if nothing survives.
 */
export function sanitizeFilename(filename: string): string {
	const base = basename(filename.replace(/\\/g, "/")).trim();
	const safe = base.replace(/[\u0000-\u001f/\\:]/g, "").replace(/^\.+$/, "");
	if (safe.length === 0) return "file";
	if (Buffer.byteLength(safe) <= MAX_FILENAME_BYTES) return safe;
	// Keep a plausible extension so the agent still sees the file's type; a
	// pathologically long "extension" is treated as part of the name instead.
	const dot = safe.lastIndexOf(".");
	const ext = dot > 0 && Buffer.byteLength(safe.slice(dot)) <= 32 ? safe.slice(dot) : "";
	const stem = truncateUtf8(safe.slice(0, dot > 0 ? dot : undefined), MAX_FILENAME_BYTES - Buffer.byteLength(ext));
	return stem.length > 0 ? `${stem}${ext}` : truncateUtf8(safe, MAX_FILENAME_BYTES) || "file";
}

/** Bytes currently stored under `<projectDir>/attachments`. */
function usedAttachmentBytes(projectDir: string): number {
	const root = join(projectDir, ATTACHMENTS_DIR);
	if (!existsSync(root)) return 0;
	let total = 0;
	for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
		if (entry.isFile()) total += statSync(join(entry.parentPath, entry.name)).size;
	}
	return total;
}

/**
 * Persist an attachment under `<projectDir>/attachments/<id>/<filename>`.
 * Throws `AttachmentQuotaError` when the project's attachments would outgrow
 * `MAX_PROJECT_ATTACHMENT_BYTES`.
 */
export function saveAttachment(projectDir: string, filename: string, data: Buffer): AttachmentInfo {
	const used = usedAttachmentBytes(projectDir);
	if (used + data.length > MAX_PROJECT_ATTACHMENT_BYTES) {
		throw new AttachmentQuotaError(used, data.length);
	}
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
 * the files live (relative to its cwd) and that reading them is optional — the
 * agent decides whether the task needs their contents. It is wrapped in
 * `ATTACHMENT_NOTE_OPEN`/`_CLOSE` so agent-client can hide it from the user's
 * rendered message instead of showing it as text they typed.
 */
export function composePromptWithAttachments(text: string, relativePaths: string[]): string {
	if (relativePaths.length === 0) return text;
	const list = relativePaths.map((p) => `- ${p}`).join("\n");
	return (
		`${text}\n\n${ATTACHMENT_NOTE_OPEN}\n` +
		"The user attached the following files. They are stored in the project workspace; " +
		"read them with your file tools if the task needs their contents.\n" +
		`${list}\n${ATTACHMENT_NOTE_CLOSE}`
	);
}
