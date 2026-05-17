/**
 * Standalone agent-server entrypoint.
 *
 * Single-tenant model: one process per Appx app. Configuration is read
 * from environment variables, the AgentRuntime is instantiated once, and
 * the Hono app is served via @hono/node-server. Bind to 127.0.0.1 by
 * default — the eventx-backend (and any other intra-app caller) reaches
 * us over loopback.
 *
 * Required env:
 *   PROJECT_DIR            cwd handed to pi (skill discovery rooted here)
 *
 * Optional env:
 *   SESSIONS_DIR           where pi writes session JSONL files
 *                          (default: <PROJECT_DIR>/data/sessions)
 *   AGENTS_FILE            path to system-prompt markdown, relative to
 *                          PROJECT_DIR or absolute (default: .pi/AGENTS.md)
 *   ANTHROPIC_API_KEY      injected into pi's AuthStorage if set
 *   AGENT_SERVER_HOST      bind host (default: 127.0.0.1)
 *   AGENT_SERVER_PORT      bind port (default: 4001)
 *   AGENT_SERVER_TOKEN     if set, /v1/* requires `Authorization: Bearer <token>`
 *
 * The OpenAPI doc is published at /openapi.json and Swagger UI at /docs.
 */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { AgentRuntime } from "./runtime.js";
import { createSessionsApp } from "./routes.js";

function required(name: string): string {
	const v = process.env[name];
	if (!v || !v.trim()) {
		console.error(`[agent-server] missing required env var: ${name}`);
		process.exit(2);
	}
	return v;
}

function optional(name: string, fallback: string): string {
	const v = process.env[name];
	return v && v.trim() ? v : fallback;
}

const projectDir = resolve(required("PROJECT_DIR"));
if (!existsSync(projectDir)) {
	console.error(`[agent-server] PROJECT_DIR does not exist: ${projectDir}`);
	process.exit(2);
}

const sessionsDirRaw = optional("SESSIONS_DIR", resolve(projectDir, "data/sessions"));
const sessionsDir = isAbsolute(sessionsDirRaw)
	? sessionsDirRaw
	: resolve(projectDir, sessionsDirRaw);

const agentsFile = optional("AGENTS_FILE", ".pi/AGENTS.md");

const host = optional("AGENT_SERVER_HOST", "127.0.0.1");
const port = Number(optional("AGENT_SERVER_PORT", "4001"));
const token = process.env.AGENT_SERVER_TOKEN?.trim();

const runtime = new AgentRuntime({
	projectDir,
	sessionsDir,
	agentsFile,
	anthropicApiKey: process.env.ANTHROPIC_API_KEY,
});

const root = new OpenAPIHono();

/**
 * Bearer-token middleware. Active only when AGENT_SERVER_TOKEN is set in
 * env. The seam exists so production deployments can flip auth on
 * without code changes; in single-user dev, leave it unset.
 */
if (token) {
	root.use("/v1/*", async (c, next) => {
		const auth = c.req.header("authorization") ?? "";
		const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
		if (presented !== token) {
			return c.json({ error: "unauthorized" }, 401);
		}
		await next();
	});
	console.log("[agent-server] AGENT_SERVER_TOKEN is set — bearer auth enforced on /v1/*");
} else {
	console.log("[agent-server] AGENT_SERVER_TOKEN unset — /v1/* is open (loopback only)");
}

// Mount the versioned API under /v1.
root.route("/v1", createSessionsApp(runtime));

// OpenAPI document + Swagger UI. Doc lives at /openapi.json so consumers
// (eventx-backend) can fetch it for codegen at build time.
root.doc("/openapi.json", {
	openapi: "3.1.0",
	info: {
		title: "Appx Agent Server",
		version: "0.1.0",
		description:
			"Pi-SDK-based agent orchestration. Single-tenant per process; one instance per Appx app.",
	},
	servers: [{ url: `http://${host}:${port}`, description: "local" }],
});

root.get("/docs", swaggerUI({ url: "/openapi.json" }));

// Tiny root handler so plain GET / doesn't 404 confusingly.
root.get("/", (c) =>
	c.json({
		ok: true,
		service: "agent-server",
		docs: "/docs",
		openapi: "/openapi.json",
		v1: "/v1",
	}),
);

serve({ fetch: root.fetch, hostname: host, port }, (info) => {
	console.log(`[agent-server] listening on http://${info.address}:${info.port}`);
	console.log(`[agent-server] projectDir=${projectDir}`);
	console.log(`[agent-server] sessionsDir=${sessionsDir}`);
	console.log(`[agent-server] agentsFile=${agentsFile}`);
});
