/**
 * AgentCredentialsService — process-global credential state.
 *
 * Owns AuthStorage, ModelRegistry, models.json CRUD, and the in-memory
 * OAuth subscription flow state machine. AgentRuntime instances hold a
 * reference for read-only projections (listModels, modelRow used in
 * session settings). Routes for /v1/auth/* and /v1/custom/* call this
 * directly via createCredentialsApp.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import {
  type ThinkingLevel,
  clampThinkingLevelForModel,
} from "./thinking.js";

type SessionModel = NonNullable<CreateAgentSessionOptions["model"]>;
const CUSTOM_PROVIDER_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;

export type AgentCustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number];

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

export type AgentAuthProviderRow = {
  provider: string;
  name: string;
  configured: boolean;
  credentialType?: "api_key" | "oauth";
  source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
  label?: string;
  supportsApiKey: boolean;
  supportsSubscription: boolean;
  modelCount: number;
  availableModelCount: number;
};

export type AgentAuthPrompt = {
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
};

export type AgentCustomProviderModel = {
  id: string;
  name?: string;
  api?: AgentCustomProviderApi;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
};

export type AgentCustomProviderRow = {
  provider: string;
  name?: string;
  baseUrl?: string;
  api?: AgentCustomProviderApi;
  apiKeyConfigured: boolean;
  modelCount: number;
  models: AgentCustomProviderModel[];
};

export type UpsertCustomProviderRequest = {
  provider: string;
  name?: string;
  baseUrl: string;
  api: AgentCustomProviderApi;
  apiKey?: string;
  models: AgentCustomProviderModel[];
};

export type AgentOAuthFlowState = {
  id: string;
  provider: string;
  providerName: string;
  status: "starting" | "prompt" | "auth" | "waiting" | "complete" | "error" | "cancelled";
  authUrl?: string;
  instructions?: string;
  prompt?: AgentAuthPrompt;
  progress: string[];
  error?: string;
  expiresAt: string;
};

type PendingOAuthFlow = AgentOAuthFlowState & {
  version: number;
  abortController: AbortController;
  promptResolve?: (value: string) => void;
  promptReject?: (error: Error) => void;
  manualResolve?: (value: string) => void;
  manualReject?: (error: Error) => void;
  waiters: Array<(state: AgentOAuthFlowState) => void>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
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
  private readonly pendingOAuthFlows = new Map<string, PendingOAuthFlow>();

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

  private assertProviderId(provider: string): void {
    if (!/^[a-zA-Z0-9_.:-]+$/.test(provider)) {
      throw new Error("invalid provider id");
    }
  }

  private customProviderApi(value: unknown): AgentCustomProviderApi | undefined {
    return CUSTOM_PROVIDER_APIS.includes(value as AgentCustomProviderApi)
      ? (value as AgentCustomProviderApi)
      : undefined;
  }

  private readModelsJson(): { providers: Record<string, Record<string, unknown>> } {
    if (!existsSync(this.modelsJsonPath)) return { providers: {} };
    const parsed = JSON.parse(readFileSync(this.modelsJsonPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("models.json must be a JSON object");
    }
    const record = parsed as Record<string, unknown>;
    const providers = record.providers;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
      return { ...record, providers: {} } as { providers: Record<string, Record<string, unknown>> };
    }
    return { ...record, providers } as { providers: Record<string, Record<string, unknown>> };
  }

  private writeModelsJson(config: { providers: Record<string, Record<string, unknown>> }): void {
    writeFileSync(this.modelsJsonPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    chmodSync(this.modelsJsonPath, 0o600);
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

  listAuthProviders(): AgentAuthProviderRow[] {
    const byProvider = new Map<string, { modelCount: number; availableModelCount: number }>();
    for (const model of this.listModels()) {
      const current = byProvider.get(model.provider) ?? { modelCount: 0, availableModelCount: 0 };
      current.modelCount += 1;
      if (model.available) current.availableModelCount += 1;
      byProvider.set(model.provider, current);
    }
    const oauthProviderIds = new Set(this.authStorage.getOAuthProviders().map((provider) => provider.id));
    for (const provider of oauthProviderIds) {
      if (!byProvider.has(provider)) {
        byProvider.set(provider, { modelCount: 0, availableModelCount: 0 });
      }
    }

    return [...byProvider.entries()]
      .map(([provider, counts]) => {
        const status = this.modelRegistry.getProviderAuthStatus(provider);
        const credential = this.authStorage.get(provider);
        return {
          provider,
          name: this.modelRegistry.getProviderDisplayName(provider),
          configured: status.configured || status.source !== undefined,
          credentialType: credential?.type,
          source: status.source,
          label: status.label,
          supportsApiKey: counts.modelCount > 0,
          supportsSubscription: oauthProviderIds.has(provider),
          ...counts,
        };
      })
      .sort(
        (a, b) =>
          Number(b.configured) - Number(a.configured) ||
          b.availableModelCount - a.availableModelCount ||
          a.provider.localeCompare(b.provider),
      );
  }

  setProviderApiKey(provider: string, key: string): void {
    this.assertProviderId(provider);
    const trimmed = key.trim();
    if (!trimmed) throw new Error("key is required");
    this.authStorage.set(provider, { type: "api_key", key: trimmed });
    this.modelRegistry.refresh();
  }

  removeProviderCredential(provider: string): void {
    this.assertProviderId(provider);
    this.authStorage.remove(provider);
    this.modelRegistry.refresh();
  }

  private oauthFlowState(flow: PendingOAuthFlow): AgentOAuthFlowState {
    return {
      id: flow.id,
      provider: flow.provider,
      providerName: flow.providerName,
      status: flow.status,
      authUrl: flow.authUrl,
      instructions: flow.instructions,
      prompt: flow.prompt,
      progress: [...flow.progress],
      error: flow.error,
      expiresAt: flow.expiresAt,
    };
  }

  private updateOAuthFlow(flow: PendingOAuthFlow, patch: Partial<AgentOAuthFlowState>): void {
    Object.assign(flow, patch);
    flow.version += 1;
    const state = this.oauthFlowState(flow);
    const waiters = flow.waiters.splice(0);
    for (const waiter of waiters) waiter(state);
  }

  private scheduleOAuthFlowCleanup(flow: PendingOAuthFlow, delayMs = 10 * 60 * 1000): void {
    if (flow.cleanupTimer) clearTimeout(flow.cleanupTimer);
    flow.cleanupTimer = setTimeout(() => {
      this.pendingOAuthFlows.delete(flow.id);
    }, delayMs);
    flow.cleanupTimer.unref?.();
  }

  private activeOAuthFlowForProvider(provider: string): PendingOAuthFlow | undefined {
    const now = Date.now();
    for (const flow of this.pendingOAuthFlows.values()) {
      if (flow.provider !== provider) continue;
      if (["complete", "error", "cancelled"].includes(flow.status)) continue;
      if (Date.parse(flow.expiresAt) <= now) continue;
      return flow;
    }
    return undefined;
  }

  private oauthLoginErrorMessage(providerName: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("EADDRINUSE")) {
      return `${providerName} login callback is already running on its local port. Finish or cancel the existing login, then try again.`;
    }
    return message;
  }

  private waitForOAuthFlowUpdate(
    flow: PendingOAuthFlow,
    version: number,
    timeoutMs = 15_000,
  ): Promise<AgentOAuthFlowState> {
    if (flow.version !== version) return Promise.resolve(this.oauthFlowState(flow));
    if (["complete", "error", "cancelled"].includes(flow.status)) {
      return Promise.resolve(this.oauthFlowState(flow));
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(this.oauthFlowState(flow));
      }, timeoutMs);
      flow.waiters.push((state) => {
        clearTimeout(timer);
        resolve(state);
      });
    });
  }

  async startProviderSubscriptionLogin(provider: string): Promise<AgentOAuthFlowState> {
    this.assertProviderId(provider);
    const oauthProvider = this.authStorage.getOAuthProviders().find((entry) => entry.id === provider);
    if (!oauthProvider) throw new Error(`provider ${provider} does not support subscription auth`);

    const activeFlow = this.activeOAuthFlowForProvider(provider);
    if (activeFlow) return this.oauthFlowState(activeFlow);

    const flow: PendingOAuthFlow = {
      id: randomUUID(),
      provider,
      providerName: oauthProvider.name,
      status: "starting",
      progress: [],
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      version: 0,
      abortController: new AbortController(),
      waiters: [],
    };
    this.pendingOAuthFlows.set(flow.id, flow);
    this.scheduleOAuthFlowCleanup(flow);

    const loginPromise = this.authStorage.login(provider, {
      onAuth: (info) => {
        this.updateOAuthFlow(flow, {
          status: "auth",
          authUrl: info.url,
          instructions: info.instructions,
          prompt: undefined,
        });
      },
      onPrompt: (prompt) =>
        new Promise<string>((resolve, reject) => {
          flow.promptResolve = resolve;
          flow.promptReject = reject;
          this.updateOAuthFlow(flow, {
            status: "prompt",
            prompt: {
              message: prompt.message,
              placeholder: prompt.placeholder,
              allowEmpty: prompt.allowEmpty,
            },
          });
        }),
      onProgress: (message) => {
        this.updateOAuthFlow(flow, { progress: [...flow.progress, message] });
      },
      onManualCodeInput: () =>
        new Promise<string>((resolve, reject) => {
          flow.manualResolve = resolve;
          flow.manualReject = reject;
        }),
      signal: flow.abortController.signal,
    });

    void loginPromise
      .then(() => {
        this.modelRegistry.refresh();
        this.updateOAuthFlow(flow, {
          status: "complete",
          prompt: undefined,
          authUrl: undefined,
          instructions: undefined,
          progress: [...flow.progress, "Credentials saved."],
        });
        this.scheduleOAuthFlowCleanup(flow, 60_000);
      })
      .catch((error: unknown) => {
        this.updateOAuthFlow(flow, {
          status: flow.status === "cancelled" ? "cancelled" : "error",
          error: this.oauthLoginErrorMessage(flow.providerName, error),
        });
        this.scheduleOAuthFlowCleanup(flow, 60_000);
      });

    return this.waitForOAuthFlowUpdate(flow, 0);
  }

  async continueProviderSubscriptionLogin(id: string, value: string): Promise<AgentOAuthFlowState> {
    const flow = this.pendingOAuthFlows.get(id);
    if (!flow) throw new Error("subscription auth flow not found");
    const trimmed = value.trim();

    if (flow.promptResolve) {
      if (!trimmed && !flow.prompt?.allowEmpty) throw new Error("value is required");
      const resolve = flow.promptResolve;
      flow.promptResolve = undefined;
      flow.promptReject = undefined;
      this.updateOAuthFlow(flow, { status: "waiting", prompt: undefined });
      const waitVersion = flow.version;
      resolve(value);
      return this.waitForOAuthFlowUpdate(flow, waitVersion);
    }

    if (flow.manualResolve) {
      if (!trimmed) throw new Error("redirect URL or authorization code is required");
      const resolve = flow.manualResolve;
      flow.manualResolve = undefined;
      flow.manualReject = undefined;
      this.updateOAuthFlow(flow, { status: "waiting", prompt: undefined });
      const waitVersion = flow.version;
      resolve(trimmed);
      return this.waitForOAuthFlowUpdate(flow, waitVersion);
    }

    return this.oauthFlowState(flow);
  }

  getProviderSubscriptionLogin(id: string): AgentOAuthFlowState | undefined {
    const flow = this.pendingOAuthFlows.get(id);
    return flow ? this.oauthFlowState(flow) : undefined;
  }

  cancelProviderSubscriptionLogin(id: string): AgentOAuthFlowState | undefined {
    const flow = this.pendingOAuthFlows.get(id);
    if (!flow) return undefined;
    flow.abortController.abort();
    flow.promptReject?.(new Error("Login cancelled"));
    flow.manualReject?.(new Error("Login cancelled"));
    this.updateOAuthFlow(flow, { status: "cancelled", error: "Login cancelled" });
    this.scheduleOAuthFlowCleanup(flow, 60_000);
    return this.oauthFlowState(flow);
  }

  listCustomProviders(): AgentCustomProviderRow[] {
    const config = this.readModelsJson();
    return Object.entries(config.providers)
      .filter(([, providerConfig]) => Array.isArray(providerConfig.models))
      .map(([provider, providerConfig]) => {
        const models = (providerConfig.models as unknown[])
          .filter(
            (model): model is Record<string, unknown> =>
              Boolean(model) && typeof model === "object" && typeof (model as { id?: unknown }).id === "string",
          )
          .map((model) => ({
            ...model,
            id: String(model.id),
            name: typeof model.name === "string" ? model.name : undefined,
            api: this.customProviderApi(model.api),
            reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
            input: Array.isArray(model.input)
              ? model.input.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image")
              : undefined,
            contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined,
            maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : undefined,
            thinkingLevelMap:
              model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" && !Array.isArray(model.thinkingLevelMap)
                ? (model.thinkingLevelMap as Partial<Record<ThinkingLevel, string | null>>)
                : undefined,
            compat:
              model.compat && typeof model.compat === "object" && !Array.isArray(model.compat)
                ? (model.compat as Record<string, unknown>)
                : undefined,
          }));
        return {
          provider,
          name: typeof providerConfig.name === "string" ? providerConfig.name : undefined,
          baseUrl: typeof providerConfig.baseUrl === "string" ? providerConfig.baseUrl : undefined,
          api: this.customProviderApi(providerConfig.api),
          apiKeyConfigured: typeof providerConfig.apiKey === "string" && providerConfig.apiKey.trim().length > 0,
          modelCount: models.length,
          models,
        };
      })
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }

  upsertCustomProvider(input: UpsertCustomProviderRequest): AgentCustomProviderRow {
    this.assertProviderId(input.provider);
    const baseUrl = input.baseUrl.trim();
    if (!baseUrl) throw new Error("baseUrl is required");
    const parsedUrl = new URL(baseUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("baseUrl must use http or https");
    }
    const models = input.models.map((model) => ({ ...model, id: model.id.trim() }));
    if (models.some((model) => !model.id)) throw new Error("model id is required");
    if (!models.length) throw new Error("at least one model is required");

    const config = this.readModelsJson();
    const existing = config.providers[input.provider] ?? {};
    const apiKey = input.apiKey?.trim() || (typeof existing.apiKey === "string" ? existing.apiKey : "");
    if (!apiKey) throw new Error("apiKey is required for custom providers");

    config.providers[input.provider] = {
      name: input.name?.trim() || input.provider,
      baseUrl,
      api: input.api,
      apiKey,
      models: models.map((model) => ({
        ...model,
        name: model.name?.trim() || model.id,
        api: model.api,
        input: model.input ?? ["text"],
        contextWindow: model.contextWindow ?? 128000,
        maxTokens: model.maxTokens ?? 16384,
        reasoning: model.reasoning ?? false,
      })),
    };

    this.writeModelsJson(config);
    this.modelRegistry.refresh();
    return this.listCustomProviders().find((provider) => provider.provider === input.provider)!;
  }

  removeCustomProvider(provider: string): void {
    this.assertProviderId(provider);
    const config = this.readModelsJson();
    delete config.providers[provider];
    this.writeModelsJson(config);
    this.modelRegistry.refresh();
  }
}
