/**
 * Client-side handling of the attachment note agent-server appends to a prompt.
 *
 * When a prompt references uploaded attachments, agent-server rewrites the
 * prompt text to include their workspace paths so the agent can read them. That
 * *composed* text is what gets persisted and echoed back as the user's message,
 * so rendering it verbatim would show an internal instruction as words the user
 * typed. We strip the note and surface the files as chips instead.
 *
 * The delimiters mirror `ATTACHMENT_NOTE_OPEN` / `ATTACHMENT_NOTE_CLOSE` in
 * agent-server's `runtime/attachments.ts` — change one and you must change the
 * other (both sides have tests pinning the exact wire format).
 */

/** A file referenced by the attachment note. */
export type AttachmentRef = { path: string; filename: string };

/** The note is always the trailing block of the composed prompt. */
const ATTACHMENT_NOTE_RE = /\n*<attached-files>\n[\s\S]*?\n<\/attached-files>\s*$/;

/**
 * Split the trailing attachment note off a user message's text. Returns the
 * text as the user wrote it plus the files the note listed (empty when the
 * message carries no note).
 */
export function stripAttachmentNote(text: string): { text: string; files: AttachmentRef[] } {
	const match = ATTACHMENT_NOTE_RE.exec(text);
	if (!match) return { text, files: [] };
	const files: AttachmentRef[] = [];
	for (const line of match[0].split("\n")) {
		if (!line.startsWith("- ")) continue;
		const path = line.slice(2).trim();
		if (path) files.push({ path, filename: path.split("/").pop() || path });
	}
	return { text: text.slice(0, match.index).trimEnd(), files };
}
