import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  AuthStorage,
  getAgentDir,
  ModelRegistry,
  type ModelRegistry as ModelRegistryType,
} from "@earendil-works/pi-coding-agent";
import { AgentCredentialsService } from "./credentialsService.js";
import { ProjectRuntime, type ProjectRuntimeConfig } from "./projectRuntime.js";

export type ProjectRuntimeContext = {
  id: string;
  name?: string;
  projectDir: string;
};

export type AgentRuntimeRegistryConfig = Omit<
  ProjectRuntimeConfig,
  "authStorage" | "modelRegistry" | "credentials"
> & {
  /**
   * Agents file for the default runtime. Set to false for multi-project hosts
   * where the default runtime only owns shared auth/model settings and should
   * not try to load a prompt from the host project root.
   */
  defaultAgentsFile?: string | false;
  /**
   * Project-local extension files loaded for each project when present.
   * Relative paths are resolved against that project's root.
   */
  projectExtensionPaths?: string[];
};

type RuntimeEntry = {
  projectDir: string;
  runtime: ProjectRuntime;
};

/**
 * Registry of per-project ProjectRuntimes sharing one process-global
 * AuthStorage / ModelRegistry / AgentCredentialsService.
 *
 * Construction is async because each ProjectRuntime now builds an
 * AgentSessionServices bundle (which walks the filesystem to resolve
 * extensions/skills/themes once per project). Use the static factory:
 *
 *     const registry = await AgentRuntimeRegistry.create(config);
 *
 * forProject() is also async — it lazily constructs project runtimes
 * on first request and caches them by id.
 *
 * See docs/architecture/use-agent-session-services.md.
 */
export class AgentRuntimeRegistry {
  private readonly config: AgentRuntimeRegistryConfig;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistryType;
  private readonly runtimes = new Map<string, RuntimeEntry>();
  readonly credentials: AgentCredentialsService;
  readonly defaultRuntime: ProjectRuntime;

  /**
   * Async factory. Sets up shared auth/model state, then builds the
   * default runtime by awaiting its services bundle.
   */
  static async create(config: AgentRuntimeRegistryConfig): Promise<AgentRuntimeRegistry> {
    // Resolve agentDir once so AuthStorage, ModelRegistry, AgentCredentialsService,
    // and every per-project ProjectRuntime all read/write the same auth.json and
    // models.json files. Without this, an undefined agentDir falls back to Pi's
    // getAgentDir() inside each AuthStorage/ModelRegistry/ProjectRuntime, while the
    // credentials service would silently target a different path.
    const agentDir = config.agentDir ? resolve(config.agentDir) : getAgentDir();
    const resolvedConfig: AgentRuntimeRegistryConfig = {
      ...config,
      projectDir: resolve(config.projectDir),
      sessionsDir: resolve(config.sessionsDir),
      agentDir,
      defaultAgentsFile: config.defaultAgentsFile,
      projectExtensionPaths:
        config.projectExtensionPaths ?? [".pi/extensions/appx-guardrails.ts"],
    };

    mkdirSync(agentDir, { recursive: true });
    const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
    const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
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

    // Build the default runtime up-front so the registry exposes it
    // synchronously (matching server.ts's mounting expectations).
    const defaultRuntime = await buildRuntime(
      { id: "default", projectDir: resolvedConfig.projectDir },
      resolvedConfig,
      authStorage,
      modelRegistry,
      credentials,
    );

    return new AgentRuntimeRegistry(
      resolvedConfig,
      authStorage,
      modelRegistry,
      credentials,
      defaultRuntime,
    );
  }

  private constructor(
    config: AgentRuntimeRegistryConfig,
    authStorage: AuthStorage,
    modelRegistry: ModelRegistryType,
    credentials: AgentCredentialsService,
    defaultRuntime: ProjectRuntime,
  ) {
    this.config = config;
    this.authStorage = authStorage;
    this.modelRegistry = modelRegistry;
    this.credentials = credentials;
    this.defaultRuntime = defaultRuntime;
  }

  /**
   * Get (or lazily build) the ProjectRuntime for a project context.
   * Async because ProjectRuntime.create walks the filesystem once to
   * load resources.
   */
  async forProject(context: ProjectRuntimeContext): Promise<ProjectRuntime> {
    const projectDir = resolve(context.projectDir);
    if (!context.id.trim()) throw new Error("project id is required");
    if (!existsSync(projectDir)) throw new Error(`project directory does not exist: ${projectDir}`);

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
 * Module-private helper so both `create()` (static) and `forProject()`
 * (instance) can share the runtime-construction recipe without
 * needing access to half-initialised instance state.
 */
async function buildRuntime(
  context: ProjectRuntimeContext,
  config: AgentRuntimeRegistryConfig,
  authStorage: AuthStorage,
  modelRegistry: ModelRegistryType,
  credentials: AgentCredentialsService,
): Promise<ProjectRuntime> {
  const projectDir = resolve(context.projectDir);
  const agentsFile =
    context.id === "default"
      ? config.defaultAgentsFile === false
        ? undefined
        : config.defaultAgentsFile ?? config.agentsFile
      : config.agentsFile;
  const extensionPaths = [
    ...(config.extensionPaths ?? []),
    ...resolveProjectExtensionPaths(config.projectExtensionPaths ?? [], projectDir),
  ];

  config.logger?.log(
    `[agent-server] creating Pi runtime project=${context.id} dir=${projectDir}`,
  );

  return ProjectRuntime.create({
    ...config,
    projectDir,
    sessionsDir:
      context.id === "default"
        ? config.sessionsDir
        : resolve(projectDir, "data/sessions"),
    credentials,
    authStorage,
    modelRegistry,
    // Shared modelRegistry was already configured by the caller of
    // AgentRuntimeRegistry.create; clear the hook so per-project
    // ProjectRuntime.create doesn't double-apply it.
    configureModelRegistry: undefined,
    extensionPaths,
    agentsFile,
  });
}

function resolveProjectExtensionPaths(
  paths: string[],
  projectDir: string,
): string[] {
  return paths
    .map((entry) => (isAbsolute(entry) ? entry : resolve(projectDir, entry)))
    .filter((entry) => existsSync(entry));
}
