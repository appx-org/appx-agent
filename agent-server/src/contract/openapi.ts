/**
 * Build-time OpenAPI dump — emits openapi.json next to package.json so
 * downstream consumers (eventx-backend) can run `openapi-typescript`
 * against a stable file rather than having to spin up the live server
 * during their build.
 *
 * Usage: `npm run openapi` (writes ./openapi.json).
 *
 * The document is built by the shared `buildOpenApiDocument` so it can't drift
 * from what the live server publishes at `/openapi.json`; the only difference is
 * that this host-agnostic dump omits the `servers` block.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createCredentialsApp } from "../http/credentialsRoutes.js";
import { createProjectsApp } from "../http/projectsRoutes.js";
import { createSessionsApp } from "../http/sessionsRoutes.js";
import { ProjectRegistry } from "../runtime/projectRegistry.js";
import type { ProjectRuntime } from "../runtime/projectRuntime.js";
import { buildOpenApiDocument } from "./openapiEventSchema.js";

// We need a registry to construct the route apps, but we never actually call
// any methods during doc generation — the routes just reference handler
// functions whose signatures don't depend on state. Build it against a throwaway
// workspace so nothing touches the real filesystem layout.
const workspaceDir = mkdtempSync(resolve(tmpdir(), "agent-server-openapi-"));
const registry = await ProjectRegistry.create({
	workspaceDir,
	logger: { log: () => {}, error: () => {} },
});
const stubResolver = async (): Promise<ProjectRuntime> => {
	throw new Error("openapi stub resolver should never be invoked");
}; // FIXME: What is this?

const root = new OpenAPIHono();
root.route("/v1", createCredentialsApp(registry.credentials));
root.route("/v1", createProjectsApp(registry));
root.route("/v1/projects/:projectId", createSessionsApp(stubResolver));

const doc = buildOpenApiDocument(root);

const outPath = resolve(process.cwd(), "openapi.json");
writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`[openapi] wrote ${outPath}`);
