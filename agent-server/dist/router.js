/**
 * Express Router factory exposing AgentRuntime over REST + SSE.
 *
 * Mount at any path (typically /api/sessions). The wire format on SSE is the
 * pi-shaped AgentSessionEvent; the eventx frontend reducer (and any future
 * app's UI) consume this directly.
 *
 *   GET    /                        list sessions (disk + in-memory unflushed)
 *   POST   /                        create new session, returns { id, createdAt }
 *   GET    /:id                     return persisted message history
 *   GET    /:id/events  (SSE)       subscribe to event stream
 *   POST   /:id/prompt              { text } — send a user prompt; events flow over SSE
 *   POST   /:id/abort               stop the in-flight run (no-op if idle)
 *
 * The host app is responsible for `express.json()` body parsing.
 */
import { Router } from "express";
import { subscribe } from "./sse.js";
export function createSessionsRouter(runtime) {
    const r = Router();
    r.get("/", async (_req, res) => {
        res.json({ sessions: await runtime.listSessions() });
    });
    r.post("/", async (_req, res) => {
        const created = await runtime.createNewSession();
        res.json(created);
    });
    r.get("/:id", async (req, res) => {
        const messages = await runtime.getSessionMessages(req.params.id);
        if (messages === null) {
            res.status(404).json({ error: "session not found" });
            return;
        }
        res.json({ id: req.params.id, messages });
    });
    r.get("/:id/events", async (req, res) => {
        const session = await runtime.ensureSession(req.params.id);
        if (!session) {
            res.status(404).end();
            return;
        }
        subscribe(req.params.id, res);
    });
    r.post("/:id/prompt", async (req, res) => {
        const { text } = req.body ?? {};
        if (typeof text !== "string" || !text.trim()) {
            res.status(400).json({ error: "body.text is required" });
            return;
        }
        try {
            // Fire and forget — events flow over SSE
            runtime.sendPrompt(req.params.id, text).catch((err) => {
                console.error("[agent-server] prompt failed:", err);
            });
            res.json({ ok: true });
        }
        catch (err) {
            res.status(404).json({ error: String(err) });
        }
    });
    r.post("/:id/abort", async (req, res) => {
        try {
            await runtime.abortSession(req.params.id);
            res.json({ ok: true });
        }
        catch (err) {
            res.status(404).json({ error: String(err) });
        }
    });
    return r;
}
