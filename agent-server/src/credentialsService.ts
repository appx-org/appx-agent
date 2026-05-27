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
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import {
  type ThinkingLevel,
  clampThinkingLevelForModel,
} from "./thinking.js";

type SessionModel = NonNullable<CreateAgentSessionOptions["model"]>;

export type AgentModelRow = {
  provider: string;
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  available: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  defaultThinkingLevel?: ThinkingLevel;
};

export type AgentCredentialsServiceConfig = {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  modelsJsonPath: string;
  defaultModelProvider?: string;
  defaultModelId?: string;
  defaultThinkingLevel?: ThinkingLevel;
  modelThinkingDefaults?: Record<string, ThinkingLevel>;
  logger?: Pick<Console, "log" | "error">;
};

export class AgentCredentialsService {
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly modelsJsonPath: string;
  private readonly logger: Pick<Console, "log" | "error">;
  private readonly defaultModelProvider: string | undefined;
  private readonly defaultModelId: string | undefined;
  private readonly defaultThinkingLevel: ThinkingLevel | undefined;
  private readonly modelThinkingDefaults: Record<string, ThinkingLevel>;

  constructor(config: AgentCredentialsServiceConfig) {
    this.authStorage = config.authStorage;
    this.modelRegistry = config.modelRegistry;
    this.modelsJsonPath = config.modelsJsonPath;
    this.logger = config.logger ?? console;
    this.defaultModelProvider = config.defaultModelProvider;
    this.defaultModelId = config.defaultModelId;
    this.defaultThinkingLevel = config.defaultThinkingLevel;
    this.modelThinkingDefaults = config.modelThinkingDefaults ?? {};
  }

  private modelKey(model: Pick<SessionModel, "provider" | "id">): string {
    return `${model.provider}/${model.id}`;
  }

  defaultThinkingForModel(model: SessionModel): ThinkingLevel | undefined {
    const configured = this.modelThinkingDefaults[this.modelKey(model)] ?? this.defaultThinkingLevel;
    return configured ? clampThinkingLevelForModel(model, configured) : undefined;
  }

  modelRow(model: SessionModel): AgentModelRow {
    return {
      provider: model.provider,
      id: model.id,
      name: model.name,
      api: model.api,
      reasoning: model.reasoning,
      available: this.modelRegistry.hasConfiguredAuth(model),
      input: [...model.input],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      defaultThinkingLevel: this.defaultThinkingForModel(model),
    };
  }

  listModels(): AgentModelRow[] {
    return this.modelRegistry
      .getAll()
      .map((model) => this.modelRow(model as SessionModel))
      .sort(
        (a, b) =>
          Number(b.available) - Number(a.available) ||
          a.provider.localeCompare(b.provider) ||
          a.name.localeCompare(b.name),
      );
  }

  listAuthProviders(): never {
    throw new Error("not yet implemented");
  }
}
