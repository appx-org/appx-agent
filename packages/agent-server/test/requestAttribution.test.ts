import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Hono } from "hono";
import { createSessionsApp } from "../src/http/sessionsRoutes.js";
import type { ProjectRuntime } from "../src/runtime/projectRuntime.js";
import {
	ActorReceiptContext,
	APPX_ACTOR_RECEIPT_HEADER,
	APPX_ACTOR_RECEIPT_METADATA_KEY,
	applyActorReceipt,
} from "../src/runtime/requestAttribution.js";

type Handler = (event: any, context: ExtensionContext) => unknown;

function bindReceiptContext(context: ActorReceiptContext) {
	const handlers = new Map<string, Handler>();
	const api = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	context.extensionFactory(api);
	const extensionContext = (sessionId: string) =>
		({ sessionManager: { getSessionId: () => sessionId } }) as unknown as ExtensionContext;
	return {
		input: (sessionId: string, receipt: string | undefined) =>
			context.run(receipt, () =>
				handlers.get("input")!({ type: "input", text: "prompt" }, extensionContext(sessionId)),
			),
		failedInput: (sessionId: string, receipt: string | undefined) =>
			context.run(receipt, () => {
				handlers.get("input")!({ type: "input", text: "prompt" }, extensionContext(sessionId));
				throw new Error("prompt rejected");
			}),
		deliverUserMessage: (sessionId: string) =>
			handlers.get("message_start")!(
				{ type: "message_start", message: { role: "user", content: "prompt" } },
				extensionContext(sessionId),
			),
		providerPayload: (sessionId: string) =>
			handlers.get("before_provider_request")!(
				{
					type: "before_provider_request",
					payload: { metadata: { [APPX_ACTOR_RECEIPT_METADATA_KEY]: "forged", keep: "yes" } },
				},
				extensionContext(sessionId),
			),
		providerDuringPrompt: (sessionId: string, receipt: string | undefined) =>
			context.run(receipt, () =>
				handlers.get("before_provider_request")!(
					{ type: "before_provider_request", payload: { metadata: { keep: "yes" } } },
					extensionContext(sessionId),
				),
			),
	};
}

describe("AppX actor receipt forwarding", () => {
	test("the prompt route passes the opaque receipt without adding it to the prompt body", async () => {
		const calls: Array<{ text: string; receipt: string | undefined }> = [];
		const runtime = {
			async getSession(id: string) {
				if (id !== "session-1") return null;
				return {
					sendPrompt(text: string, receipt?: string) {
						calls.push({ text, receipt });
						return Promise.resolve();
					},
				};
			},
		} as unknown as ProjectRuntime;
		const app = new Hono();
		app.route("/v1/projects/:projectId", createSessionsApp(runtime));

		const response = await app.request("/v1/projects/project-1/sessions/session-1/prompt", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[APPX_ACTOR_RECEIPT_HEADER]: "v1.opaque.signature",
			},
			body: JSON.stringify({ text: "build an app" }),
		});

		assert.equal(response.status, 200);
		assert.deepEqual(calls, [{ text: "build an app", receipt: "v1.opaque.signature" }]);
	});

	test("activates a receipt only when its user message is delivered", async () => {
		const state = bindReceiptContext(new ActorReceiptContext());
		await state.input("session-1", "v1.trusted.signature");
		assert.deepEqual(await state.providerPayload("session-1"), { metadata: { keep: "yes" } });

		await state.deliverUserMessage("session-1");
		assert.deepEqual(await state.providerPayload("session-1"), {
			metadata: {
				[APPX_ACTOR_RECEIPT_METADATA_KEY]: "v1.trusted.signature",
				keep: "yes",
			},
		});
	});

	test("switches a steering receipt at delivery without changing the active run early", async () => {
		const state = bindReceiptContext(new ActorReceiptContext());
		await state.input("session-1", "v1.first.signature");
		await state.deliverUserMessage("session-1");
		await state.input("session-1", "v1.second.signature");

		assert.equal(
			((await state.providerPayload("session-1")) as any).metadata[APPX_ACTOR_RECEIPT_METADATA_KEY],
			"v1.first.signature",
		);
		await state.deliverUserMessage("session-1");
		assert.equal(
			((await state.providerPayload("session-1")) as any).metadata[APPX_ACTOR_RECEIPT_METADATA_KEY],
			"v1.second.signature",
		);
	});

	test("uses the current prompt receipt for extension-command provider calls", async () => {
		const state = bindReceiptContext(new ActorReceiptContext());
		await state.input("session-1", "v1.active.signature");
		await state.deliverUserMessage("session-1");

		assert.equal(
			((await state.providerDuringPrompt("session-1", "v1.command.signature")) as any).metadata[
				APPX_ACTOR_RECEIPT_METADATA_KEY
			],
			"v1.command.signature",
		);
		assert.equal(
			((await state.providerPayload("session-1")) as any).metadata[APPX_ACTOR_RECEIPT_METADATA_KEY],
			"v1.active.signature",
		);
	});

	test("keeps concurrently delivered sessions isolated", async () => {
		const state = bindReceiptContext(new ActorReceiptContext());
		await Promise.all([
			state.input("session-1", "v1.first.signature"),
			state.input("session-2", "v1.second.signature"),
		]);
		await state.deliverUserMessage("session-2");
		await state.deliverUserMessage("session-1");

		assert.equal(
			((await state.providerPayload("session-1")) as any).metadata[APPX_ACTOR_RECEIPT_METADATA_KEY],
			"v1.first.signature",
		);
		assert.equal(
			((await state.providerPayload("session-2")) as any).metadata[APPX_ACTOR_RECEIPT_METADATA_KEY],
			"v1.second.signature",
		);
	});

	test("removes a queued receipt when Pi rejects the prompt before delivery", async () => {
		const state = bindReceiptContext(new ActorReceiptContext());
		await assert.rejects(state.failedInput("session-1", "v1.stale.signature"), /prompt rejected/);
		await state.input("session-1", "v1.current.signature");
		await state.deliverUserMessage("session-1");

		assert.equal(
			((await state.providerPayload("session-1")) as any).metadata[APPX_ACTOR_RECEIPT_METADATA_KEY],
			"v1.current.signature",
		);
	});

	test("an unreceipted delivered prompt clears prior and forged attribution", async () => {
		const state = bindReceiptContext(new ActorReceiptContext());
		await state.input("session-1", "v1.first.signature");
		await state.deliverUserMessage("session-1");
		await state.input("session-1", undefined);
		await state.deliverUserMessage("session-1");

		assert.deepEqual(await state.providerPayload("session-1"), { metadata: { keep: "yes" } });
		assert.deepEqual(
			applyActorReceipt({ metadata: { [APPX_ACTOR_RECEIPT_METADATA_KEY]: "forged", keep: "yes" } }, undefined),
			{ metadata: { keep: "yes" } },
		);
	});
});
