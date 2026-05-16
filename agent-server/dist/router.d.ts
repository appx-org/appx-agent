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
import type { AgentRuntime } from "./runtime.js";
export declare function createSessionsRouter(runtime: AgentRuntime): Router;
