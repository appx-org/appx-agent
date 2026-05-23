#!/usr/bin/env node
/**
 * Standalone agent-server entrypoint.
 *
 * Multi-project model: one process per Appx host. Shared Pi auth/model
 * state is kept under AGENT_DIR, while project session runtimes are
 * created lazily from trusted Appx proxy headers. Bind to 127.0.0.1 by
 * default — the eventx-backend (and any other intra-app caller) reaches
 * us over loopback.
 *
 * Required env:
 *   PROJECT_DIR            cwd handed to pi (skill discovery rooted here)
 *
 * Optional env:
 *   SESSIONS_DIR           where pi writes session JSONL files
 *                          (default: <PROJECT_DIR>/data/sessions)
 *   AGENT_DIR              pi agent config dir (default: ~/.pi/agent, or
 *                          PI_CODING_AGENT_DIR if set)
 *   AGENTS_FILE            path to system-prompt markdown, relative to
 *                          PROJECT_DIR or absolute (default: .pi/AGENTS.md)
 *   ANTHROPIC_API_KEY      injected into pi's AuthStorage if set
 *   PI_EXTENSION_PATHS     comma-separated Pi extension/package sources loaded
 *                          as temporary extensions (npm:, git:, or paths)
 *   PI_SKILL_PATHS         comma-separated Pi skill file/directory paths
 *   PI_PROMPT_PATHS        comma-separated Pi prompt template paths
 *   PI_THEME_PATHS         comma-separated Pi theme paths
 *   PI_NO_EXTENSIONS       if truthy, disables project/global extension
 *                          discovery except PI_EXTENSION_PATHS
 *   PI_NO_SKILLS           if truthy, disables project/global skill discovery
 *   LITELLM_*              optional LiteLLM provider/model config
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
import type { Context } from "hono";
import { litellmRuntimeConfig, logLiteLlmStartupConfig } from "./litellm.js";
import { createSessionsApp } from "./routes.js";
import { AgentRuntimeRegistry } from "./runtimeRegistry.js";

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

function optionalList(name: string): string[] {
	const v = process.env[name];
	if (!v?.trim()) return [];
	return v
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function truthy(name: string): boolean {
	const v = process.env[name]?.trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
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

const agentDirRaw = process.env.AGENT_DIR?.trim();
const agentDir = agentDirRaw ? (isAbsolute(agentDirRaw) ? agentDirRaw : resolve(projectDir, agentDirRaw)) : undefined;
const agentsFile = optional("AGENTS_FILE", ".pi/AGENTS.md");

const host = optional("AGENT_SERVER_HOST", "127.0.0.1");
const port = Number(optional("AGENT_SERVER_PORT", "4001"));
const token = process.env.AGENT_SERVER_TOKEN?.trim();

logLiteLlmStartupConfig();

const runtimeRegistry = new AgentRuntimeRegistry({
	projectDir,
	sessionsDir,
	agentDir,
	agentsFile,
	anthropicApiKey: process.env.ANTHROPIC_API_KEY,
	extensionPaths: optionalList("PI_EXTENSION_PATHS"),
	skillPaths: optionalList("PI_SKILL_PATHS"),
	promptTemplatePaths: optionalList("PI_PROMPT_PATHS"),
	themePaths: optionalList("PI_THEME_PATHS"),
	noExtensions: truthy("PI_NO_EXTENSIONS"),
	noSkills: truthy("PI_NO_SKILLS"),
	noPromptTemplates: truthy("PI_NO_PROMPTS"),
	noThemes: truthy("PI_NO_THEMES"),
	...litellmRuntimeConfig(),
});

function projectRuntimeFromRequest(c: Context) {
	const projectId = c.req.param("projectId");
	const projectDir = c.req.header("x-appx-project-dir")?.trim();
	if (!projectId || !projectDir) {
		throw new Error("project context required");
	}
	return runtimeRegistry.forProject({
		id: projectId,
		name: c.req.header("x-appx-project-name")?.trim(),
		projectDir,
	});
}

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

root.onError((err, c) => {
	const message = err instanceof Error ? err.message : String(err);
	if (message.includes("project context") || message.includes("project directory")) {
		return c.json({ error: message }, 400);
	}
	console.error("[agent-server] request failed:", err);
	return c.json({ error: "internal server error" }, 500);
});

// Mount the versioned API under /v1. The legacy unscoped surface remains for
// global auth/custom-provider settings and backwards-compatible local usage.
root.route("/v1", createSessionsApp(runtimeRegistry.defaultRuntime));
root.route("/v1/projects/:projectId", createSessionsApp(projectRuntimeFromRequest));

// OpenAPI document + Swagger UI. Doc lives at /openapi.json so consumers
// (eventx-backend) can fetch it for codegen at build time.
root.doc("/openapi.json", {
	openapi: "3.1.0",
	info: {
		title: "Appx Agent Server",
		version: "0.1.0",
		description:
			"Pi-SDK-based agent orchestration. Shared auth/model state with project-scoped session runtimes.",
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
	console.log(`[agent-server] defaultProjectDir=${projectDir}`);
	console.log(`[agent-server] defaultSessionsDir=${sessionsDir}`);
	if (agentDir) console.log(`[agent-server] agentDir=${agentDir}`);
	console.log(`[agent-server] agentsFile=${agentsFile}`);
	if (process.env.PI_EXTENSION_PATHS?.trim()) console.log(`[agent-server] PI_EXTENSION_PATHS=${process.env.PI_EXTENSION_PATHS}`);
	if (process.env.PI_SKILL_PATHS?.trim()) console.log(`[agent-server] PI_SKILL_PATHS=${process.env.PI_SKILL_PATHS}`);
	if (process.env.PI_PROMPT_PATHS?.trim()) console.log(`[agent-server] PI_PROMPT_PATHS=${process.env.PI_PROMPT_PATHS}`);
	if (process.env.PI_THEME_PATHS?.trim()) console.log(`[agent-server] PI_THEME_PATHS=${process.env.PI_THEME_PATHS}`);
});
