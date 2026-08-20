// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentClient } from "../../core/client.js";
import { AgentChat } from "../AgentChat.js";
import { AgentChatProvider } from "../context.js";

vi.mock("../ChatPanel.js", () => ({
	ChatPanel: ({ headerStart, onTurnComplete }: { headerStart?: ReactNode; onTurnComplete?: () => void }) => (
		<div data-testid="chat-panel">
			{headerStart}
			<button type="button" onClick={onTurnComplete}>
				complete turn
			</button>
		</div>
	),
}));

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function clientWithSessions() {
	const client = new AgentClient({ baseUrl: "http://localhost" });
	const listSessions = vi.spyOn(client, "listSessions").mockResolvedValue({
		sessions: [
			{
				id: "session-1",
				createdAt: "2026-08-20T12:00:00.000Z",
				firstMessage: "Build a landing page",
				messageCount: 4,
			},
		],
	});
	return { client, listSessions };
}

describe("AgentChat session workspace", () => {
	it("folds sessions without losing the selected session label or duplicating loads", async () => {
		const { client, listSessions } = clientWithSessions();
		render(
			<AgentChatProvider client={client}>
				<AgentChat projectId="demo" defaultActiveSessionId="session-1" defaultSessionListOpen={false} />
			</AgentChatProvider>,
		);

		await screen.findByText("Build a landing page");
		expect(document.querySelector(".agent-chat-session-list")).toBeNull();
		expect(listSessions).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByTitle("Show sessions"));
		expect(document.querySelector(".agent-chat-session-list")).toBeTruthy();
		expect(screen.getByTitle("Hide sessions")).toBeTruthy();
	});

	it("reports controlled visibility changes without mutating the controlled value", async () => {
		const { client } = clientWithSessions();
		const onSessionListOpenChange = vi.fn();
		render(
			<AgentChatProvider client={client}>
				<AgentChat
					projectId="demo"
					activeSessionId="session-1"
					sessionListOpen={false}
					onSessionListOpenChange={onSessionListOpenChange}
				/>
			</AgentChatProvider>,
		);

		await screen.findByText("Build a landing page");
		fireEvent.click(screen.getByTitle("Show sessions"));
		expect(onSessionListOpenChange).toHaveBeenCalledWith(true);
		expect(document.querySelector(".agent-chat-session-list")).toBeNull();
	});

	it("keeps controlled null distinct from the uncontrolled default", async () => {
		const { client } = clientWithSessions();
		render(
			<AgentChatProvider client={client}>
				<AgentChat projectId="demo" activeSessionId={null} defaultActiveSessionId="session-1" />
			</AgentChatProvider>,
		);

		await waitFor(() => expect(screen.getByText("Build a landing page")).toBeTruthy());
		expect(screen.queryByTestId("chat-panel")).toBeNull();
		expect(screen.getByText("Select or create a session")).toBeTruthy();
	});

	it("reports selection and turn completion to the host", async () => {
		const { client, listSessions } = clientWithSessions();
		const onActiveSessionChange = vi.fn();
		const onTurnComplete = vi.fn();
		render(
			<AgentChatProvider client={client}>
				<AgentChat projectId="demo" onActiveSessionChange={onActiveSessionChange} onTurnComplete={onTurnComplete} />
			</AgentChatProvider>,
		);

		fireEvent.click(await screen.findByTitle("Build a landing page"));
		expect(onActiveSessionChange).toHaveBeenCalledWith("session-1");
		fireEvent.click(screen.getByText("complete turn"));
		expect(onTurnComplete).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
	});

	it("does not load sessions when the list is disabled", async () => {
		const { client, listSessions } = clientWithSessions();
		render(
			<AgentChatProvider client={client}>
				<AgentChat projectId="demo" hideSessionList activeSessionId={null} />
			</AgentChatProvider>,
		);

		await waitFor(() => expect(screen.getByText("Select or create a session")).toBeTruthy());
		expect(listSessions).not.toHaveBeenCalled();
	});
});
