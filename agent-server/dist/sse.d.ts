/**
 * Server-Sent Events broker.
 *
 * Maintains a per-channel subscriber list and broadcasts JSON events to all
 * subscribers. Used to stream agent events (pi-shaped) from the agent runtime
 * to browser clients. Channel name = sessionId for chat sessions, but apps can
 * publish onto arbitrary channels.
 *
 * Each subscriber gets its own Express response object held open. We send
 * a heartbeat every 15s to keep proxies and load balancers from closing
 * the connection.
 *
 * Module-level state is fine here: the broker is process-global by design and
 * channel names already namespace per-app concerns (typically by sessionId).
 */
import type { Response } from "express";
/**
 * Register a new SSE subscriber on the given channel. Returns an
 * unsubscribe function that removes the subscriber and clears its
 * heartbeat. Caller is responsible for closing res when done.
 */
export declare function subscribe(channel: string, res: Response): () => void;
/**
 * Broadcast a typed event to every subscriber on a channel.
 * Silently skips channels with no subscribers (e.g. agent running before
 * the browser has connected).
 */
export declare function publish(channel: string, event: unknown): void;
/** Diagnostic: how many subscribers on each channel right now. */
export declare function channelStats(): Record<string, number>;
