import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  type ModelRegistry as ModelRegistryType,
} from "@earendil-works/pi-coding-agent";
import { AgentCredentialsService } from "../credentials/credentialsService.js";
import { ProjectRuntime, type ProjectRuntimeConfig } from "./projectRuntime.js";
import { ProjectStore, type ProjectRecord } from "./projectStore.js";
import { isValidProjectSlug, slugify, withCollisionSuffix } from "../utils/slug.js";

/** Directory under WORKSPACE_DIR holding org-global + agent-server state. */
export const GLOBAL_DIR_NAME = ".pi-global";
/** Subdirectory of the global dir holding per-project session transcripts. */
const SESSIONS_DIR_NAME = "sessions";
/** Filename of the durable project metadata registry. */
const PROJECTS_FILE_NAME = "projects.json";

/**
 * Public, serialisable view of a project — the shape returned by the
 * `/v1/projects` endpoints. Combines persisted metadata with the derived
 * (non-persisted) absolute working directory.
 */
export type ProjectInfo = ProjectRecord & {
  /** Absolute working directory: `WORKSPACE_DIR/{id}`. Derived, never stored. */
  projectDir: string;
};

/**
 * ProjectRegistry config. The registry derives the global agent dir and the
 * per-project layout from `workspaceDir`; callers pass only `workspaceDir` plus
 * the shared Pi resource/runtime options (extensions, skills, model defaults).
 *
 * Shared services (authStorage / modelRegistry / credentials) are owned and
 * injected by the registry, so they are omitted here. `sessionsDir` and
 * `projectDir` are owned by the workspace convention and likewise omitted.
 */
export type ProjectRegistryConfig = Omit<
  ProjectRuntimeConfig,
  "authStorage" | "modelRegistry" | "credentials" | "projectDir" | "sessionsDir"
> & {
  /** Absolute root holding every project dir plus `.pi-global/`. Must exist. */
  workspaceDir: string;
};

type RuntimeEntry = {
  projectDir: string;
  runtime: ProjectRuntime;
};

/**
 * Registry of per-project ProjectRuntimes sharing one process-global
 * AuthStorage / ModelRegistry / AgentCredentialsService.
 *
 * Ownership model (see
 * docs/architecture/project-lifecycle-and-workspace-layout.md):
 *   - The registry **owns** project identity and on-disk layout. Projects are
 *     created explicitly via `createProject({ name })`, which assigns an
 *     immutable slug `id`, creates `WORKSPACE_DIR/{id}/`, and persists metadata
 *     to `WORKSPACE_DIR/.pi-global/projects.json` (the source of truth).
 *   - `projects.json` is rehydrated on boot, so projects (and their `.pi/`
 *     config + centralised session transcripts) survive restarts.
 *   - Runtimes are built lazily on first use (`getRuntime`) and cached; the
 *     persisted metadata, not the in-memory map, defines which projects exist.
 *
 * Filesystem convention:
 *   WORKSPACE_DIR/
 *   ├── .pi-global/  auth.json, models.json, projects.json, sessions/{id}/
 *   └── {id}/.pi/    AGENTS.md, skills, extensions, settings (committable)
 *
 * Construction is async because shared services are built up front. Use the
 * static factory:
 *
 *     const registry = await ProjectRegistry.create({ workspaceDir });
 *     const project  = registry.createProject({ name: "My App" });
 *     const runtime  = await registry.getRuntime(project.id);
 */
export class ProjectRegistry {
  private readonly config: ProjectRegistryConfig;
  private readonly workspaceDir: string;
  private readonly agentDir: string;
  private readonly store: ProjectStore;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistryType;
  private readonly runtimes = new Map<string, RuntimeEntry>();
  readonly credentials: AgentCredentialsService;

  /**
   * Async factory. Resolves the workspace layout, loads the durable project
   * registry, and sets up shared auth/model/credentials state. Project runtimes
   * are built lazily via `getRuntime()`.
   */
  static async create(config: ProjectRegistryConfig): Promise<ProjectRegistry> {
    const workspaceDir = resolve(config.workspaceDir);
    const agentDir = join(workspaceDir, GLOBAL_DIR_NAME);
    mkdirSync(agentDir, { recursive: true });

    const resolvedConfig: ProjectRegistryConfig = { ...config, workspaceDir };

    // One AuthStorage / ModelRegistry / projects.json shared by every runtime
    // so credentials, the model catalog, and the project registry all target
    // the same files under .pi-global.
    const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
    const modelRegistry = ModelRegistry.create(
      authStorage,
      join(agentDir, "models.json"),
    );
    resolvedConfig.configureModelRegistry?.(modelRegistry);

    const store = ProjectStore.load(join(agentDir, PROJECTS_FILE_NAME));

    const credentials = new AgentCredentialsService({
      authStorage,
      modelRegistry,
      modelsJsonPath: join(agentDir, "models.json"),
      defaultModelProvider: resolvedConfig.defaultModelProvider,
      defaultModelId: resolvedConfig.defaultModelId,
      defaultThinkingLevel: resolvedConfig.defaultThinkingLevel,
      modelThinkingDefaults: resolvedConfig.modelThinkingDefaults,
      logger: resolvedConfig.logger,
    });

    return new ProjectRegistry(
      resolvedConfig,
      workspaceDir,
      agentDir,
      store,
      authStorage,
      modelRegistry,
      credentials,
    );
  }

  private constructor(
    config: ProjectRegistryConfig,
    workspaceDir: string,
    agentDir: string,
    store: ProjectStore,
    authStorage: AuthStorage,
    modelRegistry: ModelRegistryType,
    credentials: AgentCredentialsService,
  ) {
    this.config = config;
    this.workspaceDir = workspaceDir;
    this.agentDir = agentDir;
    this.store = store;
    this.authStorage = authStorage;
    this.modelRegistry = modelRegistry;
    this.credentials = credentials;
  }

  /** Absolute working directory for a project id. Derived, never persisted. */
  projectDir(id: string): string {
    return join(this.workspaceDir, id);
  }

  /** Per-project session transcript directory under `.pi-global/sessions/{id}`. */
  private sessionsDir(id: string): string {
    return join(this.agentDir, SESSIONS_DIR_NAME, id);
  }

  /** Attach the derived working directory to a persisted record. */
  private toInfo(record: ProjectRecord): ProjectInfo {
    return { ...record, projectDir: this.projectDir(record.id) };
  }

  /**
   * Create a project, or return the existing one (idempotent).
   *
   * Idempotency key is the exact `name`: re-creating the same name (e.g. an
   * upstream caller re-POSTing after a restart) returns the existing project
   * untouched. A *different* name that slugifies to an already-taken id is a
   * genuine collision and gets a short random suffix so both coexist.
   *
   * Side effects on a fresh create: makes `WORKSPACE_DIR/{id}/` and persists the
   * record to `projects.json`. The runtime is built lazily on first `getRuntime`.
   */
  createProject({ name }: { name: string }): ProjectInfo {
    const trimmedName = name.trim();
    if (!trimmedName) throw new InvalidProjectNameError("project name is required");

    const baseSlug = slugify(trimmedName);
    if (!isValidProjectSlug(baseSlug)) {
      throw new InvalidProjectNameError(
        `project name does not yield a valid id: ${JSON.stringify(name)}`,
      );
    }

    const existing = this.store.get(baseSlug);
    if (existing) {
      // Same name → idempotent return. Different name → collision, suffix it.
      if (existing.name === trimmedName) return this.toInfo(existing);
      return this.insertProject(this.freeCollisionSlug(baseSlug), trimmedName);
    }
    return this.insertProject(baseSlug, trimmedName);
  }

  /** Generate a suffixed slug not already taken by another project. */
  private freeCollisionSlug(baseSlug: string): string {
    let candidate = withCollisionSuffix(baseSlug);
    while (this.store.has(candidate) || !isValidProjectSlug(candidate)) {
      candidate = withCollisionSuffix(baseSlug);
    }
    return candidate;
  }

  /** Materialise a new project on disk + in the durable registry. */
  private insertProject(id: string, name: string): ProjectInfo {
    mkdirSync(this.projectDir(id), { recursive: true });
    const record = this.store.add({
      id,
      name,
      createdAt: new Date().toISOString(),
    });
    this.config.logger?.log(
      `[agent-server] created project id=${id} dir=${this.projectDir(id)}`,
    );
    return this.toInfo(record);
  }

  /** Metadata for one registered project, or null if unknown. */
  getProject(id: string): ProjectInfo | null {
    const record = this.store.get(id);
    return record ? this.toInfo(record) : null;
  }

  /** All registered projects, newest first. */
  listProjects(): ProjectInfo[] {
    return this.store.list().map((record) => this.toInfo(record));
  }

  /**
   * Resolve (and lazily build) the ProjectRuntime for a *registered* project.
   * Returns null when the id was never created — session routes turn this into
   * a 404. There is no implicit creation: projects must be made via
   * `createProject` first.
   */
  async getRuntime(id: string): Promise<ProjectRuntime | null> {
    const record = this.store.get(id);
    if (!record) return null;

    const projectDir = this.projectDir(id);
    const existing = this.runtimes.get(id);
    if (existing?.projectDir === projectDir) return existing.runtime;

    const runtime = await ProjectRuntime.create({
      ...this.config,
      projectDir,
      // Centralise transcripts under .pi-global/sessions/{id} so the project's
      // own .pi/ stays config-only (committable) and transcripts survive on the
      // workspace volume independently of the project tree.
      sessionsDir: this.sessionsDir(id),
      agentDir: this.agentDir,
      credentials: this.credentials,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      // Shared modelRegistry was already configured in create(); clear the hook
      // so per-project ProjectRuntime.create doesn't double-apply it.
      configureModelRegistry: undefined,
    });
    this.runtimes.set(id, { projectDir, runtime });
    return runtime;
  }

  /**
   * Remove a project: evict the cached runtime, drop the metadata record, and
   * delete both on-disk locations — the working dir `WORKSPACE_DIR/{id}/` and
   * the centralised transcripts `.pi-global/sessions/{id}/`. Returns false if
   * the project was unknown.
   */
  removeProject(id: string): boolean {
    if (!this.store.has(id)) return false;
    this.runtimes.delete(id);
    this.store.remove(id);
    rmSync(this.projectDir(id), { recursive: true, force: true });
    rmSync(this.sessionsDir(id), { recursive: true, force: true });
    this.config.logger?.log(`[agent-server] removed project id=${id}`);
    return true;
  }
}

/**
 * Thrown when a supplied project name cannot produce a valid id. Surfaced as a
 * 400 by the HTTP layer (distinct from a generic 500).
 */
export class InvalidProjectNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProjectNameError";
  }
}
