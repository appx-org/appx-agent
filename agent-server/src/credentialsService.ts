/**
 * AgentCredentialsService — process-global credential state.
 *
 * Owns AuthStorage, ModelRegistry, models.json CRUD, and the in-memory
 * OAuth subscription flow state machine. AgentRuntime instances hold a
 * reference for read-only projections (listModels, modelRow used in
 * session settings). Routes for /v1/auth/* and /v1/custom/* call this
 * directly via createCredentialsApp.
 */
import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

export type AgentCredentialsServiceConfig = {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  modelsJsonPath: string;
  logger?: Pick<Console, "log" | "error">;
};

export class AgentCredentialsService {
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly modelsJsonPath: string;
  private readonly logger: Pick<Console, "log" | "error">;

  constructor(config: AgentCredentialsServiceConfig) {
    this.authStorage = config.authStorage;
    this.modelRegistry = config.modelRegistry;
    this.modelsJsonPath = config.modelsJsonPath;
    this.logger = config.logger ?? console;
  }

  listAuthProviders(): never {
    throw new Error("not yet implemented");
  }
}
