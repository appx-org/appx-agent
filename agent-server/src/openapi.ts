/**
 * Build-time OpenAPI dump — emits openapi.json next to package.json so
 * downstream consumers (eventx-backend) can run `openapi-typescript`
 * against a stable file rather than having to spin up the live server
 * during their build.
 *
 * Usage: `npm run openapi` (writes ./openapi.json).
 *
 * This script must mirror server.ts's mounting structure so the doc
 * matches what the live server publishes. Keep them in sync.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ProjectRegistry } from "./runtime/projectRegistry.js";
import { createCredentialsApp, createSessionsApp } from "./http/routes.js";

const mode = process.env.AGENT_SERVER_MODE === "multi" ? "multi" : "single";

// We need a registry to construct the routes apps, but we never actually
// call any methods during doc generation — the routes just reference
// handler functions whose signatures don't depend on state. Use a stub
// projectDir so the registry's constructor passes its sanity checks.
const stubProjectDir = resolve(process.cwd());
const registry = await ProjectRegistry.create({
	projectDir: stubProjectDir,
	sessionsDir: resolve(stubProjectDir, ".tmp-openapi-sessions"),
	defaultAgentsFile: false,
	logger: { log: () => {}, error: () => {} },
});

const root = new OpenAPIHono();
root.route("/v1", createCredentialsApp(registry.credentials));
if (mode === "single") {
	root.route("/v1", createSessionsApp(registry.defaultRuntime));
} else {
	root.route("/v1/projects/:projectId", createSessionsApp(registry.defaultRuntime));
}

const doc = root.getOpenAPI31Document({
	openapi: "3.1.0",
	info: {
		title: "Appx Agent Server",
		version: "0.1.0",
		description:
			mode === "multi"
				? "Pi-SDK-based agent orchestration. Shared auth/model state with project-scoped session runtimes."
				: "Pi-SDK-based agent orchestration for standalone app sessions.",
	},
});

const outPath = resolve(process.cwd(), "openapi.json");
writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`[openapi] wrote ${outPath} (${mode} mode)`);
