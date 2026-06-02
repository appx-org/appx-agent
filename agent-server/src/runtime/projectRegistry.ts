import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AuthStorage,
  getAgentDir,
  ModelRegistry,
  type ModelRegistry as ModelRegistryType,
} from "@earendil-works/pi-coding-agent";
import { AgentCredentialsService } from "../credentials/credentialsService.js";
import { ProjectRuntime, type ProjectRuntimeConfig } from "./projectRuntime.js";

export type ProjectRuntimeContext = {
  id: string;
  name?: string;
  projectDir: string;
};

/**
 * ProjectRegistry config — same shape as a ProjectRuntime config minus
 * the shared services (which the registry owns and injects per runtime).
 *
 * Per Pi's project convention each runtime derives its own paths from
 * `<projectDir>/.pi/` automatically; the registry passes config through
 * untouched and lets every runtime go through the same `forProject()`
 * recipe — there is no eager "default" runtime and no mode awareness at
 * the registry level.
 */
export type ProjectRegistryConfig = Omit<
  ProjectRuntimeConfig,
  "authStorage" | "modelRegistry" | "credentials"
>;

type RuntimeEntry = {
  projectDir: string;
  runtime: ProjectRuntime;
};

/**
 * Registry of per-project ProjectRuntimes sharing one process-global
 * AuthStorage / ModelRegistry / AgentCredentialsService.
 *
 * The registry owns **only** org-scoped state: credentials and the
 * model catalog (one agent-server process serves one organisation).
 * Every project runtime — single mode's boot-time runtime included —
 * is built lazily through `forProject()` and references the registry's
 * shared services. There is no eager `defaultRuntime`: in multi mode it
 * was pure dead work (filesystem walks, AGENTS.md probes, services
 * bundle construction) that no session route ever consumed; in single
 * mode the boot entrypoint just awaits one `forProject()` call.
 *
 * Industry best practice followed here: keep mode awareness in the
 * routing layer (server.ts / openapi.ts), not in the state-management
 * layer. The registry is mode-agnostic.
 *
 * Filesystem convention:
 *   - Org-shared (`agentDir`, defaults to `~/.pi/agent/`):
 *     `auth.json`, `models.json`. Org-scoped — must be shared because
 *     one agent-server process serves one organisation.
 *   - Project tier (`<projectDir>/.pi/`): AGENTS.md, sessions/,
 *     skills/, extensions/, settings.json. Per-runtime — agent-server's
 *     contract has no separate "global skills" or "global settings"
 *     location.
 *
 * Construction is async because each ProjectRuntime builds an
 * AgentSessionServices bundle that walks the filesystem to resolve
 * extensions/skills/themes once per project. Use the static factory:
 *
 *     const registry = await ProjectRegistry.create(config);
 *     const runtime  = await registry.forProject({ id, projectDir });
 *
 * See docs/architecture/use-agent-session-services.md and
 * docs/superpowers/plans/2026-06-02-pi-conventions-alignment.md.
 */
export class ProjectRegistry {
  private readonly config: ProjectRegistryConfig;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistryType;
  private readonly runtimes = new Map<string, RuntimeEntry>();
  readonly credentials: AgentCredentialsService;

  /**
   * Async factory. Sets up shared auth/model state and the credentials
   * service. Project runtimes are built lazily via `forProject()`.
   */
  static async create(config: ProjectRegistryConfig): Promise<ProjectRegistry> {
    // Resolve agentDir once so AuthStorage, ModelRegistry, AgentCredentialsService,
    // and every per-project ProjectRuntime all read/write the same auth.json and
    // models.json files. Without this, an undefined agentDir falls back to Pi's
    // getAgentDir() inside each AuthStorage/ModelRegistry/ProjectRuntime, while the
    // credentials service would silently target a different path.
    const agentDir = config.agentDir ? resolve(config.agentDir) : getAgentDir();
    const resolvedConfig: ProjectRegistryConfig = {
      ...config,
      projectDir: resolve(config.projectDir),
      agentDir,
    };

    mkdirSync(agentDir, { recursive: true });
    const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
    const modelRegistry = ModelRegistry.create(
      authStorage,
      join(agentDir, "models.json"),
    );
    resolvedConfig.configureModelRegistry?.(modelRegistry);

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
      authStorage,
      modelRegistry,
      credentials,
    );
  }

  private constructor(
    config: ProjectRegistryConfig,
    authStorage: AuthStorage,
    modelRegistry: ModelRegistryType,
    credentials: AgentCredentialsService,
  ) {
    this.config = config;
    this.authStorage = authStorage;
    this.modelRegistry = modelRegistry;
    this.credentials = credentials;
  }

  /**
   * Get (or lazily build) the ProjectRuntime for a project context.
   *
   * Used by both single mode (called once at boot with the
   * `PROJECT_DIR`-derived context) and multi mode (called per request
   * with header-derived context). Async because ProjectRuntime.create
   * walks the filesystem once to load resources.
   *
   * Cache semantics: keyed by `context.id`. If the same id arrives
   * with a different `projectDir`, the entry is rebuilt — a project
   * "moved" on disk gets a fresh runtime rather than a stale cached one.
   */
  async forProject(context: ProjectRuntimeContext): Promise<ProjectRuntime> {
    const projectDir = resolve(context.projectDir);
    if (!context.id.trim()) throw new Error("project id is required");
    if (!existsSync(projectDir))
      throw new Error(`project directory does not exist: ${projectDir}`);

    const existing = this.runtimes.get(context.id);
    if (existing?.projectDir === projectDir) return existing.runtime;

    const runtime = await buildRuntime(
      { ...context, projectDir },
      this.config,
      this.authStorage,
      this.modelRegistry,
      this.credentials,
    );
    this.runtimes.set(context.id, { projectDir, runtime });
    return runtime;
  }
}

/**
 * Module-private helper that constructs a ProjectRuntime against the
 * shared registry services. Identical for every runtime — no
 * default-vs-per-project branching. Each runtime derives
 * `<projectDir>/.pi/sessions/` and `<projectDir>/.pi/AGENTS.md` via Pi's
 * project convention (see ProjectRuntime.create).
 */
async function buildRuntime(
  context: ProjectRuntimeContext,
  config: ProjectRegistryConfig,
  authStorage: AuthStorage,
  modelRegistry: ModelRegistryType,
  credentials: AgentCredentialsService,
): Promise<ProjectRuntime> {
  const projectDir = resolve(context.projectDir);

  config.logger?.log(
    `[agent-server] creating Pi runtime project=${context.id} dir=${projectDir}`,
  );

  return ProjectRuntime.create({
    ...config,
    projectDir,
    // Always derive sessions per project from <projectDir>/.pi/sessions
    // — the convention is uniform across every runtime. Callers who
    // need a non-conventional layout can pass sessionsDir on
    // ProjectRuntimeConfig directly when embedding ProjectRuntime.
    sessionsDir: undefined,
    credentials,
    authStorage,
    modelRegistry,
    // Shared modelRegistry was already configured by the caller of
    // ProjectRegistry.create; clear the hook so per-project
    // ProjectRuntime.create doesn't double-apply it.
    configureModelRegistry: undefined,
  });
}
