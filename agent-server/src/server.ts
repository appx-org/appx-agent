#!/usr/bin/env node
/**
 * Standalone agent-server entrypoint.
 *
 * Routing is always project-scoped. Shared Pi auth/model state lives under
 * `WORKSPACE_DIR/.pi-global/`; projects are explicit, persisted resources
 * created via `POST /v1/projects` and addressed at
 * `/v1/projects/:projectId/...`. Bind to 127.0.0.1 by default so app backends
 * reach us over loopback.
 *
 * Configuration is loaded from environment variables; see `./config.ts`
 * for the full schema, defaults, and validation rules. The OpenAPI doc
 * is published at /openapi.json and Swagger UI at /docs.
 *
 * See docs/architecture/project-lifecycle-and-workspace-layout.md.
 */
import { serve } from "@hono/node-server";
import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  ConfigError,
  loadConfig,
  type ServerConfig,
} from "./config.js";
import {
  litellmRuntimeConfig,
  logLiteLlmStartupConfig,
} from "./providers/litellm.js";
import { createSessionsApp } from "./http/sessionsRoutes.js";
import { createCredentialsApp } from "./http/credentialsRoutes.js";
import { createProjectsApp } from "./http/projectsRoutes.js";
import { ProjectRegistry } from "./runtime/projectRegistry.js";
import type { ProjectRuntime } from "./runtime/projectRuntime.js";

let config: ServerConfig;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[agent-server] ${err.message}`);
  } else {
    console.error("[agent-server] failed to load configuration:", err);
  }
  process.exit(2);
}

logLiteLlmStartupConfig();

const projectRegistry = await ProjectRegistry.create({
  workspaceDir: config.workspaceDir,
  anthropicApiKey: config.anthropicApiKey,
  extensionPaths: config.extensionPaths,
  skillPaths: config.skillPaths,
  promptTemplatePaths: config.promptTemplatePaths,
  themePaths: config.themePaths,
  noExtensions: config.noExtensions,
  noSkills: config.noSkills,
  noPromptTemplates: config.noPromptTemplates,
  noThemes: config.noThemes,
  ...litellmRuntimeConfig(),
});

/** Raised when a session request targets a project that was never created. */
class ProjectNotRegisteredError extends Error {
  constructor(projectId: string) {
    super(
      projectId
        ? `project not registered: ${projectId}`
        : "project id required",
    );
    this.name = "ProjectNotRegisteredError";
  }
}

/**
 * Resolve the ProjectRuntime for a session request by its path `projectId`.
 *
 * Pure lookup against the registry — the project must already have been created
 * via `POST /v1/projects`. An unknown id throws `ProjectNotRegisteredError`,
 * which the global error handler maps to 404. This replaces the old
 * header-driven lazy creation: project definition no longer rides on every
 * request.
 */
async function projectRuntimeFromRequest(c: Context): Promise<ProjectRuntime> {
  const projectId = c.req.param("projectId")?.trim();
  if (!projectId) throw new ProjectNotRegisteredError("");
  const runtime = await projectRegistry.getRuntime(projectId);
  if (!runtime) throw new ProjectNotRegisteredError(projectId);
  return runtime;
}

const root = new OpenAPIHono();

/**
 * Bearer-token middleware. Active only when AGENT_SERVER_TOKEN is set in
 * env. The seam exists so production deployments can flip auth on
 * without code changes; in single-user dev, leave it unset.
 */
if (config.token) {
  const expectedToken = config.token;
  root.use("/v1/*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (presented !== expectedToken) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
  console.log(
    "[agent-server] AGENT_SERVER_TOKEN is set — bearer auth enforced on /v1/*",
  );
} else {
  console.log(
    "[agent-server] AGENT_SERVER_TOKEN unset — /v1/* is open (loopback only)",
  );
}

root.onError((err, c) => {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof ProjectNotRegisteredError) {
    return c.json({ error: message }, 404);
  }
  console.error("[agent-server] request failed:", err);
  return c.json({ error: "internal server error" }, 500);
});

// Mount the versioned API under /v1. Shared auth/custom-provider routes plus
// project lifecycle management live at /v1; session runtimes are addressed per
// project under /v1/projects/:projectId.
root.route("/v1", createCredentialsApp(projectRegistry.credentials));
root.route("/v1", createProjectsApp(projectRegistry));
root.route(
  "/v1/projects/:projectId",
  createSessionsApp(projectRuntimeFromRequest),
);

// OpenAPI document + Swagger UI. Doc lives at /openapi.json so consumers
// (eventx-backend) can fetch it for codegen at build time.
root.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Appx Agent Server",
    version: "0.1.0",
    description:
      "Pi-SDK-based agent orchestration. Shared auth/model state with explicit, persisted project-scoped session runtimes.",
  },
  servers: [
    { url: `http://${config.host}:${config.port}`, description: "local" },
  ],
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
    projects: "/v1/projects",
    sessions: "/v1/projects/:projectId/sessions",
  }),
);

serve(
  { fetch: root.fetch, hostname: config.host, port: config.port },
  (info) => {
    console.log(
      `[agent-server] listening on http://${info.address}:${info.port}`,
    );
    // Filesystem layout: everything lives under WORKSPACE_DIR. Org-shared
    // auth.json/models.json plus the durable projects.json registry and
    // session transcripts live in WORKSPACE_DIR/.pi-global/; each project's
    // config tier is WORKSPACE_DIR/<id>/.pi/.
    console.log(`[agent-server] workspaceDir=${config.workspaceDir}`);
    console.log(`[agent-server] globalDir=${config.workspaceDir}/.pi-global`);
    if (config.extensionPaths.length) {
      console.log(
        `[agent-server] PI_EXTENSION_PATHS=${config.extensionPaths.join(",")}`,
      );
    }
    if (config.skillPaths.length) {
      console.log(
        `[agent-server] PI_SKILL_PATHS=${config.skillPaths.join(",")}`,
      );
    }
    if (config.promptTemplatePaths.length) {
      console.log(
        `[agent-server] PI_PROMPT_PATHS=${config.promptTemplatePaths.join(",")}`,
      );
    }
    if (config.themePaths.length) {
      console.log(
        `[agent-server] PI_THEME_PATHS=${config.themePaths.join(",")}`,
      );
    }
  },
);
