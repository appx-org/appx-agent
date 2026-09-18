import { describe, expect, it } from "vitest";
import type { AgentSessionInfo } from "../../core/types.js";
import { sessionLabel } from "../useAgentSessions.js";

const session = (firstMessage?: string): AgentSessionInfo =>
	({ id: "s1", createdAt: "t0", firstMessage, messageCount: 2 }) as AgentSessionInfo;

describe("sessionLabel", () => {
	it("uses the first message", () => {
		expect(sessionLabel(session("Build a landing page"))).toBe("Build a landing page");
	});

	it("falls back when there is no first message", () => {
		expect(sessionLabel(session())).toBe("Untitled");
		expect(sessionLabel(session("   "))).toBe("Untitled");
	});

	it("hides the attachment note the server appended to the stored prompt", () => {
		const stored =
			"What is in these files?\n\n<attached-files>\n" +
			"The user attached the following files. They are stored in the project workspace; " +
			"read them with your file tools if the task needs their contents.\n" +
			"- attachments/6f1e/notes.txt\n</attached-files>";
		expect(sessionLabel(session(stored))).toBe("What is in these files?");
	});
});
