import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  type ModelRegistry as ModelRegistryType,
} from "@earendil-works/pi-coding-agent";
import { AgentRuntime, type AgentRuntimeConfig } from "./runtime.js";

export type ProjectRuntimeContext = {
  id: string;
  name?: string;
  projectDir: string;
};

export type AgentRuntimeRegistryConfig = Omit<
  AgentRuntimeConfig,
  "authStorage" | "modelRegistry"
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
  readonly defaultRuntime: AgentRuntime;

  constructor(config: AgentRuntimeRegistryConfig) {
    this.config = {
      ...config,
      projectDir: resolve(config.projectDir),
      sessionsDir: resolve(config.sessionsDir),
      agentDir: config.agentDir ? resolve(config.agentDir) : undefined,
      defaultAgentsFile: config.defaultAgentsFile,
      projectExtensionPaths: config.projectExtensionPaths ?? [".pi/extensions/appx-guardrails.ts"],
    };

    const agentDir = this.config.agentDir;
    if (agentDir) mkdirSync(agentDir, { recursive: true });
    this.authStorage = agentDir
      ? AuthStorage.create(join(agentDir, "auth.json"))
      : AuthStorage.create();
    this.modelRegistry = agentDir
      ? ModelRegistry.create(this.authStorage, join(agentDir, "models.json"))
      : ModelRegistry.create(this.authStorage);
    this.config.configureModelRegistry?.(this.modelRegistry);

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
