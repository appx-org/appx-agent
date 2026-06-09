/**
 * Extension UI request/response types for SSE transport.
 *
 * These mirror Pi's `RpcExtensionUIRequest` / `RpcExtensionUIResponse` from
 * `@earendil-works/pi-coding-agent/modes/rpc`, but kept locally because Pi
 * doesn't export them from its public API.
 *
 * @see https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts
 */

import type { WidgetPlacement } from "@earendil-works/pi-coding-agent";

export type ExtensionUiRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: WidgetPlacement;
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

/**
 * Simplified from Pi's `RpcExtensionUIResponse` — we omit the `type` and
 * `id` fields because the resolver already knows which request this
 * responds to (via the URL `requestId` path parameter).
 */
export type ExtensionUiResponse = { value: string } | { confirmed: boolean } | { cancelled: true };
