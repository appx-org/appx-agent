/**
 * Pub/sub Broker — runtime-agnostic.
 *
 * Listeners are plain callbacks, so the broker has no knowledge of HTTP,
 * Hono, or Express. The HTTP layer (routes.ts) wires `subscribe` callbacks
 * into Hono's `streamSSE` and pumps queued events to the wire.
 *
 * Channel name = sessionId for chat sessions. Apps may publish onto
 * arbitrary channels in the future (e.g. cron status, Telegram updates),
 * which is why this lives outside `runtime.ts`.
 *
 * Module-level state is fine: the broker is process-global by design and
 * channel names already namespace concerns.
 */

type Listener = (event: unknown) => void;

const channels = new Map<string, Set<Listener>>();

/**
 * Register a listener on the given channel. Returns an unsubscribe
 * function. The listener is invoked synchronously from `publish`; if it
 * throws, the broker swallows the error so one bad subscriber doesn't
 * tear down the rest.
 */
export function subscribe(channel: string, listener: Listener): () => void {
  let listeners = channels.get(channel);
  if (!listeners) {
    listeners = new Set();
    channels.set(channel, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) channels.delete(channel);
  };
}

/**
 * Broadcast an event to every listener on a channel. Silent no-op if
 * nobody's listening (typical when the agent runs ahead of the browser
 * connecting).
 */
export function publish(channel: string, event: unknown): void {
  const listeners = channels.get(channel);
  if (!listeners || listeners.size === 0) return;
  for (const l of listeners) {
    try {
      l(event);
    } catch (err) {
      // Don't tear down the broker — other subscribers on this
      // channel are still viable. But a thrown listener is a real
      // bug surface (e.g. JSON.stringify on a non-serialisable
      // event, or future listener code), so log loudly.
      console.error(`[sse] listener on channel '${channel}' threw:`, err);
    }
  }
}

/** Diagnostic: subscriber count per channel. */
export function channelStats(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of channels) out[k] = v.size;
  return out;
}
