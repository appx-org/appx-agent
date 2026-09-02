/**
 * The attachment note agent-server appends to a prompt must never reach the
 * screen as text the user wrote. These tests pin the exact wire format the
 * server produces — the fixtures below are copied from
 * agent-server/src/runtime/attachments.ts `composePromptWithAttachments`, and
 * that module has a matching test asserting the same delimiters.
 */
import { describe, expect, it } from "vitest";
import { stripAttachmentNote } from "../attachments.js";

/** Byte-for-byte what agent-server's composePromptWithAttachments emits. */
function composed(text: string, paths: string[]): string {
	return (
		`${text}\n\n<attached-files>\n` +
		"The user attached the following files. They are stored in the project workspace; " +
		"read them with your file tools if the task needs their contents.\n" +
		`${paths.map((p) => `- ${p}`).join("\n")}\n</attached-files>`
	);
}

describe("stripAttachmentNote", () => {
	it("leaves a message with no note untouched", () => {
		expect(stripAttachmentNote("just a prompt")).toEqual({ text: "just a prompt", files: [] });
	});

	it("removes the note and returns the listed files", () => {
		const result = stripAttachmentNote(
			composed("summarize these", ["attachments/6f1e/report.pdf", "attachments/a2b3/notes.txt"]),
		);
		expect(result.text).toBe("summarize these");
		expect(result.files).toEqual([
			{ path: "attachments/6f1e/report.pdf", filename: "report.pdf" },
			{ path: "attachments/a2b3/notes.txt", filename: "notes.txt" },
		]);
	});

	it("keeps list items the user typed themselves", () => {
		const result = stripAttachmentNote(composed("- one\n- two", ["attachments/x/a.csv"]));
		expect(result.text).toBe("- one\n- two");
		expect(result.files).toHaveLength(1);
	});

	it("does not strip a lookalike block in the middle of the text", () => {
		const text = "before\n\n<attached-files>\nnope\n- x\n</attached-files>\n\nafter";
		expect(stripAttachmentNote(text)).toEqual({ text, files: [] });
	});
});
