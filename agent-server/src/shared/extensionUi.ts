/**
 * Extension UI request/response types for SSE transport.
 *
 * These are sourced directly from Pi's public API (`RpcExtensionUIRequest` /
 * `RpcExtensionUIResponse`) rather than hand-duplicated, so they can never
 * drift from upstream. Pi added these exports in v0.79.0.
 *
 * @see https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts
 */

import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";

/** Distributes `Omit` across each member of a union (plain `Omit` collapses unions). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Emitted when a pi extension needs user input. Mirrors Pi's wire shape exactly. */
export type ExtensionUiRequest = RpcExtensionUIRequest;

/**
 * Response to an extension UI request, derived from Pi's `RpcExtensionUIResponse`.
 *
 * We drop the `type` and `id` fields because the resolver already knows which
 * request this answers (via the URL `requestId` path parameter), so the HTTP
 * request body only needs to carry the payload.
 */
export type ExtensionUiResponse = DistributiveOmit<RpcExtensionUIResponse, "type" | "id">;
