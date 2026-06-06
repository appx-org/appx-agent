/**
 * HTTP routes for project lifecycle management.
 *
 * Surface (mounted by the server under `/v1`):
 *   POST   /projects          create-or-get a project (idempotent on name)
 *   GET    /projects          list registered projects
 *   GET    /projects/{id}     get one project's metadata
 *   DELETE /projects/{id}     remove a project (runtime + metadata + on-disk dirs)
 *
 * These replace the old header-driven, lazily-created project model: a project
 * is now an explicit, persisted resource owned by the ProjectRegistry. Session
 * routes (mounted separately at `/v1/projects/{id}/sessions...`) only resolve an
 * already-registered runtime by id. See
 * docs/architecture/project-lifecycle-and-workspace-layout.md.
 */
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import {
  InvalidProjectNameError,
  type ProjectRegistry,
} from "../runtime/projectRegistry.js";
import {
  CreateProjectRequestSchema,
  ErrorResponseSchema,
  ListProjectsResponseSchema,
  OkResponseSchema,
  ProjectIdParamSchema,
  ProjectInfoSchema,
} from "../contract/schemas.js";

/**
 * Build the Hono app exposing project lifecycle routes. Versioning/prefixing is
 * the caller's job (server.ts mounts this under `/v1`).
 */
export function createProjectsApp(registry: ProjectRegistry): OpenAPIHono {
  const app = new OpenAPIHono();

  // ── POST /projects ───────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/projects",
      operationId: "createProject",
      tags: ["projects"],
      summary:
        "Create a project, or return the existing one (idempotent on name).",
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: CreateProjectRequestSchema } },
        },
      },
      responses: {
        200: {
          description: "The created or already-existing project.",
          content: { "application/json": { schema: ProjectInfoSchema } },
        },
        400: {
          description: "Name does not yield a valid project id.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
      },
    }),
    (c) => {
      const { name } = c.req.valid("json");
      try {
        return c.json(registry.createProject({ name }), 200);
      } catch (err) {
        if (err instanceof InvalidProjectNameError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }
    },
  );

  // ── GET /projects ────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/projects",
      operationId: "listProjects",
      tags: ["projects"],
      summary: "List registered projects, newest first.",
      responses: {
        200: {
          description: "Registered projects.",
          content: { "application/json": { schema: ListProjectsResponseSchema } },
        },
      },
    }),
    (c) => c.json({ projects: registry.listProjects() }, 200),
  );

  // ── GET /projects/{id} ───────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}",
      operationId: "getProject",
      tags: ["projects"],
      summary: "Get a single project's metadata.",
      request: { params: ProjectIdParamSchema },
      responses: {
        200: {
          description: "Project metadata.",
          content: { "application/json": { schema: ProjectInfoSchema } },
        },
        404: {
          description: "Unknown project id.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
      },
    }),
    (c) => {
      const { id } = c.req.valid("param");
      const project = registry.getProject(id);
      if (!project) return c.json({ error: "project not found" }, 404);
      return c.json(project, 200);
    },
  );

  // ── DELETE /projects/{id} ────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "delete",
      path: "/projects/{id}",
      operationId: "deleteProject",
      tags: ["projects"],
      summary:
        "Remove a project: evict runtime, drop metadata, delete working dir + transcripts.",
      request: { params: ProjectIdParamSchema },
      responses: {
        200: {
          description: "Project removed if it existed.",
          content: { "application/json": { schema: OkResponseSchema } },
        },
        404: {
          description: "Unknown project id.",
          content: { "application/json": { schema: ErrorResponseSchema } },
        },
      },
    }),
    (c) => {
      const { id } = c.req.valid("param");
      const removed = registry.removeProject(id);
      if (!removed) return c.json({ error: "project not found" }, 404);
      return c.json({ ok: true } as const, 200);
    },
  );

  return app;
}
