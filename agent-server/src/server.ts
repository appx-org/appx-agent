#!/usr/bin/env node
/**
 * Standalone agent-server entrypoint.
 *
 * The server supports two explicit routing modes:
 *   - single: standalone apps (eventx-style) use /v1/sessions directly.
 *   - multi: Appx uses shared /v1 auth/custom routes plus project sessions
 *     under /v1/projects/:projectId.
 *
 * In both modes shared Pi auth/model state is kept under AGENT_DIR. Multi
 * mode creates project session runtimes lazily from trusted Appx proxy
 * headers. Bind to 127.0.0.1 by default so app backends reach us over
 * loopback.
 *
 * Configuration is loaded from environment variables; see `./config.ts`
 * for the full schema, defaults, and validation rules. The OpenAPI doc
 * is published at /openapi.json and Swagger UI at /docs.
 */
import { serve } from "@hono/node-server";
import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { ConfigError, loadConfig, ServerMode, type ServerConfig } from "./config.js";
import {
  litellmRuntimeConfig,
  logLiteLlmStartupConfig,
} from "./providers/litellm.js";
import { createCredentialsApp, createSessionsApp } from "./http/routes.js";
import { ProjectRegistry } from "./runtime/projectRegistry.js";

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
  projectDir: config.projectDir,
  sessionsDir: config.sessionsDir,
  agentDir: config.agentDir,
  agentsFile: config.agentsFile,
  defaultAgentsFile: config.mode === ServerMode.Multi ? false : undefined,
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

// FIXME: What's this mess with hardcoded path? We should have an endpoint for creating a projectRuntime and registering it in projectRegistry
function projectRuntimeFromRequest(
  c: Context,
): Promise<import("./runtime/projectRuntime.js").ProjectRuntime> {
  const projectId = c.req.param("projectId");
  const projectDir = c.req.header("x-appx-project-dir")?.trim();
  if (!projectId || !projectDir) {
    throw new Error("project context required");
  }
  return projectRegistry.forProject({
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
  if (
    message.includes("project context") ||
    message.includes("project directory")
  ) {
    return c.json({ error: message }, 400);
  }
  console.error("[agent-server] request failed:", err);
  return c.json({ error: "internal server error" }, 500);
});

// Mount the versioned API under /v1. Single mode keeps the standalone surface
// for eventx/spotifyx-style callers; multi mode makes Appx project scoping
// explicit and keeps credentials at one shared URL surface.
root.route("/v1", createCredentialsApp(projectRegistry.credentials));
if (config.mode === ServerMode.Single) {
  root.route("/v1", createSessionsApp(projectRegistry.defaultRuntime));
} else {
  root.route(
    "/v1/projects/:projectId",
    createSessionsApp(projectRuntimeFromRequest),
  );
}

// OpenAPI document + Swagger UI. Doc lives at /openapi.json so consumers
// (eventx-backend) can fetch it for codegen at build time.
root.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Appx Agent Server",
    version: "0.1.0",
    description:
      config.mode === ServerMode.Multi
        ? "Pi-SDK-based agent orchestration. Shared auth/model state with project-scoped session runtimes."
        : "Pi-SDK-based agent orchestration for standalone app sessions.",
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
    mode: config.mode,
    docs: "/docs",
    openapi: "/openapi.json",
    v1: "/v1",
    sessions:
      config.mode === ServerMode.Multi
        ? "/v1/projects/:projectId/sessions"
        : "/v1/sessions",
  }),
);

serve(
  { fetch: root.fetch, hostname: config.host, port: config.port },
  (info) => {
    console.log(
      `[agent-server] listening on http://${info.address}:${info.port}`,
    );
    console.log(`[agent-server] mode=${config.mode}`);
    console.log(`[agent-server] defaultProjectDir=${config.projectDir}`);
    console.log(`[agent-server] defaultSessionsDir=${config.sessionsDir}`);
    if (config.agentDir) {
      console.log(`[agent-server] agentDir=${config.agentDir}`);
    }
    if (config.mode === ServerMode.Single) {
      console.log(`[agent-server] agentsFile=${config.agentsFile}`);
    } else {
      console.log(`[agent-server] projectAgentsFile=${config.agentsFile}`);
    }
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
