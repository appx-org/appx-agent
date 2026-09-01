// @vitest-environment jsdom

/**
 * Composer behaviour around attachments. The panel keeps pending attachments in
 * local state, so the interesting cases are the ones where that state must not
 * outlive its prompt: a failed send, and a switch to another session.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentClient, type EventSourceLike } from "../../core/client.js";
import { ChatPanel } from "../ChatPanel.js";
import { AgentChatProvider } from "../context.js";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

/** A client whose SSE stream and initial reads are inert, so only sends matter. */
function stubbedClient() {
	const client = new AgentClient({
		baseUrl: "http://localhost",
		eventSourceFactory: () => ({ onopen: null, onerror: null, onmessage: null, close: () => {} }) as EventSourceLike,
	});
	vi.spyOn(client, "getSessionMessages").mockResolvedValue({ id: "s1", messages: [] });
	vi.spyOn(client, "listExtensionUiRequests").mockResolvedValue({ requests: [] });
	return client;
}

function renderPanel(client: AgentClient, sessionId = "s1") {
	return render(
		<AgentChatProvider client={client}>
			<ChatPanel projectId="demo" sessionId={sessionId} showModelControls={false} showUsage={false} />
		</AgentChatProvider>,
	);
}

/** Select `count` files through the hidden file input, then wait for `expected` chips. */
async function attach(count: number, expected = count) {
	const input = document.querySelector('input[type="file"]') as HTMLInputElement;
	const files = Array.from({ length: count }, (_, i) => new File([`body-${i}`], `f${i}.txt`, { type: "text/plain" }));
	fireEvent.change(input, { target: { files } });
	await waitFor(() => expect(document.querySelectorAll(".agent-chat-attachment-chip")).toHaveLength(expected));
}

function composer() {
	return document.querySelector(".agent-chat-input") as HTMLTextAreaElement;
}

describe("ChatPanel attachments", () => {
	it("restores the prompt and its attachments when the send fails", async () => {
		const client = stubbedClient();
		vi.spyOn(client, "uploadAttachment").mockImplementation(async (_p, filename) => ({
			id: `id-${filename}`,
			filename,
			path: `attachments/id/${filename}`,
			size: 6,
			createdAt: "t0",
		}));
		vi.spyOn(client, "sendPrompt").mockRejectedValue(new Error("attachments: too many items"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		renderPanel(client);
		await attach(1);
		fireEvent.change(composer(), { target: { value: "read this" } });
		fireEvent.click(screen.getByText("Send"));

		// The ids of already-uploaded files are the only handle on them, so losing
		// them would orphan the files on disk.
		await waitFor(() => expect(composer().value).toBe("read this"));
		expect(document.querySelectorAll(".agent-chat-attachment-chip")).toHaveLength(1);
		expect(document.querySelector(".agent-chat-error-banner")?.textContent).toBe("attachments: too many items");
	});

	it("caps a selection at the server's per-prompt attachment limit", async () => {
		const client = stubbedClient();
		const upload = vi.spyOn(client, "uploadAttachment").mockImplementation(async (_p, filename) => ({
			id: `id-${filename}`,
			filename,
			path: `attachments/id/${filename}`,
			size: 6,
			createdAt: "t0",
		}));

		renderPanel(client);
		// The 21st file would make the prompt endpoint reject the whole send, so it
		// is never uploaded in the first place.
		await attach(21, 20);
		expect(upload).toHaveBeenCalledTimes(20);
		expect(screen.getByText("At most 20 attachments per message.")).toBeTruthy();
	});

	it("drops pending attachments when the active session changes", async () => {
		const client = stubbedClient();
		vi.spyOn(client, "uploadAttachment").mockImplementation(async (_p, filename) => ({
			id: `id-${filename}`,
			filename,
			path: `attachments/id/${filename}`,
			size: 6,
			createdAt: "t0",
		}));

		const { rerender } = renderPanel(client, "s1");
		await attach(2);

		rerender(
			<AgentChatProvider client={client}>
				<ChatPanel projectId="demo" sessionId="s2" showModelControls={false} showUsage={false} />
			</AgentChatProvider>,
		);

		await waitFor(() => expect(document.querySelectorAll(".agent-chat-attachment-chip")).toHaveLength(0));
	});
});
