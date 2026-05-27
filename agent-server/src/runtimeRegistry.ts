import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  AuthStorage,
  getAgentDir,
  ModelRegistry,
  type ModelRegistry as ModelRegistryType,
} from "@earendil-works/pi-coding-agent";
import { AgentRuntime, type AgentRuntimeConfig } from "./runtime.js";
import { AgentCredentialsService } from "./credentialsService.js";

export type ProjectRuntimeContext = {
  id: string;
  name?: string;
  projectDir: string;
};

export type AgentRuntimeRegistryConfig = Omit<
  AgentRuntimeConfig,
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
  runtime: AgentRuntime;
};

export class AgentRuntimeRegistry {
  private readonly config: AgentRuntimeRegistryConfig;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistryType;
  private readonly runtimes = new Map<string, RuntimeEntry>();
  readonly credentials: AgentCredentialsService;
  readonly defaultRuntime: AgentRuntime;

  constructor(config: AgentRuntimeRegistryConfig) {
    // Resolve agentDir once so AuthStorage, ModelRegistry, AgentCredentialsService,
    // and every per-project AgentRuntime all read/write the same auth.json and
    // models.json files. Without this, an undefined agentDir falls back to Pi's
    // getAgentDir() inside each AuthStorage/ModelRegistry/AgentRuntime, while the
    // credentials service would silently target a different path.
    const agentDir = config.agentDir ? resolve(config.agentDir) : getAgentDir();
    this.config = {
      ...config,
      projectDir: resolve(config.projectDir),
      sessionsDir: resolve(config.sessionsDir),
      agentDir,
      defaultAgentsFile: config.defaultAgentsFile,
      projectExtensionPaths: config.projectExtensionPaths ?? [".pi/extensions/appx-guardrails.ts"],
    };

    mkdirSync(agentDir, { recursive: true });
    this.authStorage = AuthStorage.create(join(agentDir, "auth.json"));
    this.modelRegistry = ModelRegistry.create(this.authStorage, join(agentDir, "models.json"));
    this.config.configureModelRegistry?.(this.modelRegistry);

    this.credentials = new AgentCredentialsService({
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      modelsJsonPath: join(agentDir, "models.json"),
      defaultModelProvider: this.config.defaultModelProvider,
      defaultModelId: this.config.defaultModelId,
      defaultThinkingLevel: this.config.defaultThinkingLevel,
      modelThinkingDefaults: this.config.modelThinkingDefaults,
      logger: this.config.logger,
    });

    this.defaultRuntime = this.createRuntime({
      id: "default",
      projectDir: this.config.projectDir,
    });
  }

  forProject(context: ProjectRuntimeContext): AgentRuntime {
    const projectDir = resolve(context.projectDir);
    if (!context.id.trim()) throw new Error("project id is required");
    if (!existsSync(projectDir)) throw new Error(`project directory does not exist: ${projectDir}`);

    const existing = this.runtimes.get(context.id);
    if (existing?.projectDir === projectDir) return existing.runtime;

    const runtime = this.createRuntime({ ...context, projectDir });
    this.runtimes.set(context.id, { projectDir, runtime });
    return runtime;
  }

  private createRuntime(context: ProjectRuntimeContext): AgentRuntime {
    const projectDir = resolve(context.projectDir);
    const agentsFile =
      context.id === "default"
        ? this.config.defaultAgentsFile === false
          ? undefined
          : this.config.defaultAgentsFile ?? this.config.agentsFile
        : this.config.agentsFile;
    const extensionPaths = [
      ...(this.config.extensionPaths ?? []),
      ...this.projectExtensionPaths(projectDir),
    ];

    this.config.logger?.log(
      `[agent-server] creating Pi runtime project=${context.id} dir=${projectDir}`,
    );

    return new AgentRuntime({
      ...this.config,
      projectDir,
      sessionsDir:
        context.id === "default"
          ? this.config.sessionsDir
          : resolve(projectDir, "data/sessions"),
      credentials: this.credentials,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      configureModelRegistry: undefined,
      extensionPaths,
      agentsFile,
    });
  }

  private projectExtensionPaths(projectDir: string): string[] {
    return (this.config.projectExtensionPaths ?? [])
      .map((entry) => (isAbsolute(entry) ? entry : resolve(projectDir, entry)))
      .filter((entry) => existsSync(entry));
  }
}
