const channels = new Map();
/**
 * Register a new SSE subscriber on the given channel. Returns an
 * unsubscribe function that removes the subscriber and clears its
 * heartbeat. Caller is responsible for closing res when done.
 */
export function subscribe(channel, res) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const sub = { id: crypto.randomUUID(), res };
    if (!channels.has(channel))
        channels.set(channel, new Set());
    channels.get(channel).add(sub);
    // Initial comment to flush headers in proxies
    res.write(`: connected to ${channel}\n\n`);
    const heartbeat = setInterval(() => {
        try {
            res.write(`: ping\n\n`);
        }
        catch {
            // ignore — cleanup handled by close listener
        }
    }, 15_000);
    const cleanup = () => {
        clearInterval(heartbeat);
        channels.get(channel)?.delete(sub);
        if (channels.get(channel)?.size === 0)
            channels.delete(channel);
    };
    res.on("close", cleanup);
    return cleanup;
}
/**
 * Broadcast a typed event to every subscriber on a channel.
 * Silently skips channels with no subscribers (e.g. agent running before
 * the browser has connected).
 */
export function publish(channel, event) {
    const subs = channels.get(channel);
    if (!subs || subs.size === 0)
        return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const sub of subs) {
        try {
            sub.res.write(payload);
        }
        catch {
            // subscriber gone — close listener will clean up
        }
    }
}
/** Diagnostic: how many subscribers on each channel right now. */
export function channelStats() {
    const out = {};
    for (const [k, v] of channels)
        out[k] = v.size;
    return out;
}
