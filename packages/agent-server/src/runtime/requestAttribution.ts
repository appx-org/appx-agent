import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const APPX_ACTOR_RECEIPT_HEADER = "x-appx-actor-receipt";
export const APPX_ACTOR_RECEIPT_METADATA_KEY = "openorange_app_actor_receipt";

type IncomingReceipt = {
	receipt: string | undefined;
	sessionId?: string;
};

/**
 * Carries an opaque gateway receipt from one HTTP prompt to the provider calls
 * caused by that exact user message. Steering prompts are queued separately and
 * become active only when Pi delivers their user message to the running agent.
 */
export class ActorReceiptContext {
	private readonly incoming = new AsyncLocalStorage<IncomingReceipt>();
	private readonly queued = new Map<string, IncomingReceipt[]>();
	private readonly active = new Map<string, string>();

	readonly extensionFactory: ExtensionFactory = (pi) => {
		pi.on("input", (_event, context) => {
			const incoming = this.incoming.getStore();
			if (!incoming) return;
			const sessionId = context.sessionManager.getSessionId();
			const queue = this.queued.get(sessionId) ?? [];
			incoming.sessionId = sessionId;
			queue.push(incoming);
			this.queued.set(sessionId, queue);
		});

		pi.on("message_start", (event, context) => {
			if (event.message.role !== "user") return;
			const sessionId = context.sessionManager.getSessionId();
			const queue = this.queued.get(sessionId);
			const receipt = queue?.shift()?.receipt;
			if (!queue?.length) this.queued.delete(sessionId);
			if (receipt) this.active.set(sessionId, receipt);
			else this.active.delete(sessionId);
		});

		pi.on("before_provider_request", (event, context) => {
			const incoming = this.incoming.getStore();
			const receipt = incoming ? incoming.receipt : this.active.get(context.sessionManager.getSessionId());
			return applyActorReceipt(event.payload, receipt);
		});

		pi.on("session_shutdown", (_event, context) => {
			this.clear(context.sessionManager.getSessionId());
		});
	};

	async run<T>(receipt: string | undefined, callback: () => T | Promise<T>): Promise<T> {
		const incoming: IncomingReceipt = { receipt };
		try {
			return await this.incoming.run(incoming, callback);
		} catch (error) {
			this.removeQueued(incoming);
			throw error;
		}
	}

	clear(sessionId: string): void {
		this.queued.delete(sessionId);
		this.active.delete(sessionId);
	}

	private removeQueued(incoming: IncomingReceipt): void {
		if (!incoming.sessionId) return;
		const queue = this.queued.get(incoming.sessionId);
		if (!queue) return;
		const index = queue.indexOf(incoming);
		if (index !== -1) queue.splice(index, 1);
		if (queue.length === 0) this.queued.delete(incoming.sessionId);
	}
}

/**
 * Replace request-controlled attribution metadata with the receipt accepted by
 * the agent-server HTTP boundary. The internal extension using this helper is
 * loaded after project extensions, so app code cannot forge or replace it.
 */
export function applyActorReceipt(payload: unknown, receipt: string | undefined): unknown {
	if (!isRecord(payload)) return payload;

	const existingMetadata = isRecord(payload.metadata) ? payload.metadata : {};
	const metadata: Record<string, unknown> = { ...existingMetadata };
	delete metadata[APPX_ACTOR_RECEIPT_METADATA_KEY];
	if (receipt) metadata[APPX_ACTOR_RECEIPT_METADATA_KEY] = receipt;

	return { ...payload, metadata };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
