/**
 * The agent-server SSE *wire event* type.
 *
 * This composes pi's `AgentSessionEvent` (the events pi emits, already a clean,
 * canonical, well-typed union) with the two events agent-server itself injects
 * onto the same stream: `extension_ui_request` and `extension_error`.
 *
 * `WireEvent` is the single source of truth for the SSE contract. We do NOT
 * hand-author a parallel schema: `scripts/genEventSchema.ts` runs typia over
 * this type to emit the OpenAPI 3.1 schema (`eventSchema.generated.json`), which
 * is merged into `openapi.json` so every consumer codegens from it. pi stays the
 * source of truth for its own shapes; agent-server owns and versions the
 * published contract.
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ExtensionUiRequest } from "../shared/extensionUi.js";

/** Emitted when a pi extension handler throws; surfaced to the UI for visibility. */
export interface ExtensionErrorEvent {
	type: "extension_error";
	extensionPath: string;
	/** The pi lifecycle event during which the error occurred (e.g. "session_start"). */
	event?: string;
	error: string;
	stack?: string;
}

/** Every JSON event agent-server forwards on `GET …/sessions/{id}/events`. */
export type WireEvent = AgentSessionEvent | ExtensionUiRequest | ExtensionErrorEvent;
