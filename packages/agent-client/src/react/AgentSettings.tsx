import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import type {
  AgentAuthProvider,
  AgentCustomProvider,
  AgentCustomProviderApi,
  AgentOAuthFlowState,
} from "../core/types";
import { useAgentChatContext } from "./context";

/** Local editor model for the custom-provider form (flattened single-model shape). */
type CustomForm = {
  provider: string;
  name: string;
  baseUrl: string;
  api: AgentCustomProviderApi;
  apiKey: string;
  modelId: string;
  modelName: string;
  reasoning: boolean;
  thinkingPreset: "standard" | "deepseek" | "none";
  contextWindow: string;
  maxTokens: string;
};

type CredentialMode = "subscription" | "api_key";

const defaultCustomForm: CustomForm = {
  provider: "litellm",
  name: "LiteLLM",
  baseUrl: "http://127.0.0.1:4000/v1",
  api: "openai-responses",
  apiKey: "",
  modelId: "openai/gpt-5.5",
  modelName: "GPT 5.5 via LiteLLM",
  reasoning: true,
  thinkingPreset: "standard",
  contextWindow: "128000",
  maxTokens: "16384",
};

/** Providers whose subscription login completes via a browser callback (with manual fallback). */
const callbackSubscriptionProviders = new Set(["anthropic", "openai-codex"]);

function sourceLabel(source?: AgentAuthProvider["source"]): string {
  switch (source) {
    case "stored":
      return "Stored";
    case "runtime":
      return "Runtime";
    case "environment":
      return "Environment";
    case "fallback":
      return "Fallback";
    case "models_json_key":
      return "Models JSON";
    case "models_json_command":
      return "Command";
    default:
      return "Not set";
  }
}

function apiLabel(api: AgentCustomProviderApi): string {
  switch (api) {
    case "openai-completions":
      return "OpenAI Chat";
    case "openai-responses":
      return "OpenAI Responses";
    case "anthropic-messages":
      return "Anthropic Messages";
  }
}

function providerSortScore(provider: AgentAuthProvider): number {
  if (provider.configured) return 0;
  if (provider.provider === "anthropic") return 1;
  if (provider.provider === "openai-codex") return 2;
  if (provider.provider === "openai") return 3;
  if (provider.provider === "google") return 4;
  return 5;
}

function providerTitle(provider: AgentAuthProvider): string {
  if (!provider.name || provider.name === provider.provider) return provider.provider;
  return `${provider.name} (${provider.provider})`;
}

function preferredCredentialMode(provider?: AgentAuthProvider): CredentialMode {
  if (!provider?.supportsSubscription) return "api_key";
  if (provider.credentialType === "api_key") return "api_key";
  return "subscription";
}

function isFlowTerminal(flow?: AgentOAuthFlowState | null): boolean {
  return Boolean(flow && ["complete", "error", "cancelled"].includes(flow.status));
}

function flowStatusLabel(status: AgentOAuthFlowState["status"]): string {
  switch (status) {
    case "starting":
      return "Starting";
    case "prompt":
      return "Input needed";
    case "auth":
    case "waiting":
      return "Waiting";
    case "complete":
      return "Connected";
    case "error":
      return "Error";
    case "cancelled":
      return "Cancelled";
  }
}

function flowStatusModifier(status: AgentOAuthFlowState["status"]): string {
  if (status === "complete") return "agent-settings-flow-pill-success";
  if (status === "error" || status === "cancelled") return "agent-settings-flow-pill-error";
  if (status === "prompt") return "agent-settings-flow-pill-warning";
  return "agent-settings-flow-pill-info";
}

function thinkingMap(form: CustomForm): Record<string, string | null> | undefined {
  if (!form.reasoning || form.thinkingPreset === "none") return undefined;
  if (form.thinkingPreset === "deepseek") {
    return { minimal: null, low: null, medium: null, high: "high", xhigh: "max" };
  }
  return {
    off: "none",
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
  };
}

function compatFor(form: CustomForm): Record<string, unknown> | undefined {
  if (form.api === "openai-responses") {
    return {
      thinkingFormat: "openai",
      supportsReasoningEffort: form.reasoning,
      maxTokensField: "max_output_tokens",
      supportsPromptCacheKey: form.modelId === "openai/gpt-5.5",
      promptCacheRetention: form.modelId === "openai/gpt-5.5" ? "24h" : undefined,
    };
  }
  if (form.thinkingPreset === "deepseek") {
    return { thinkingFormat: "deepseek", maxTokensField: "max_tokens" };
  }
  if (form.api === "openai-completions") {
    return {
      supportsDeveloperRole: false,
      supportsReasoningEffort: form.reasoning,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
    };
  }
  return undefined;
}

function modelFromCustom(provider: AgentCustomProvider): CustomForm {
  const model = provider.models[0];
  const api = model?.api || provider.api || "openai-responses";
  const hasDeepSeekMap = model?.thinkingLevelMap?.xhigh === "max";
  return {
    provider: provider.provider,
    name: provider.name || provider.provider,
    baseUrl: provider.baseUrl || "",
    api,
    apiKey: "",
    modelId: model?.id || "",
    modelName: model?.name || model?.id || "",
    reasoning: Boolean(model?.reasoning),
    thinkingPreset: model?.reasoning ? (hasDeepSeekMap ? "deepseek" : "standard") : "none",
    contextWindow: String(model?.contextWindow || 128000),
    maxTokens: String(model?.maxTokens || 16384),
  };
}

const cx = (...classes: Array<string | false | undefined>): string =>
  classes.filter(Boolean).join(" ");

export interface AgentSettingsProps {
  /** Optional heading rendered above the credentials panel. */
  title?: string;
  /** Optional description rendered under the heading. */
  description?: string;
  /** Extra class appended to the root element for theming. */
  className?: string;
}

/**
 * Self-contained provider-credential management panel for the agent runtime:
 * API keys, subscription (OAuth) logins, and custom (models.json) providers.
 * Talks to agent-server via the `AgentClient` from `AgentChatProvider`, so any
 * host app gets credential management without re-implementing the transport.
 */
export function AgentSettings({
  title = "Agent Credentials",
  description = "Manage provider API keys, subscription logins, and custom models for the agent runtime.",
  className,
}: AgentSettingsProps) {
  const { client } = useAgentChatContext();
  const [providers, setProviders] = useState<AgentAuthProvider[]>([]);
  const [customProviders, setCustomProviders] = useState<AgentCustomProvider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [newKey, setNewKey] = useState("");
  const [subscriptionFlow, setSubscriptionFlow] = useState<AgentOAuthFlowState | null>(null);
  const [subscriptionInput, setSubscriptionInput] = useState("");
  const [subscriptionFallbackOpen, setSubscriptionFallbackOpen] = useState(false);
  const [credentialMode, setCredentialMode] = useState<CredentialMode>("api_key");
  const [customEditorOpen, setCustomEditorOpen] = useState(false);
  const [customForm, setCustomForm] = useState<CustomForm>(defaultCustomForm);
  const [saving, setSaving] = useState(false);
  const [customSaving, setCustomSaving] = useState(false);
  const [subscriptionBusy, setSubscriptionBusy] = useState(false);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const sortedProviders = useMemo(
    () =>
      [...providers].sort(
        (a, b) =>
          providerSortScore(a) - providerSortScore(b) ||
          b.availableModelCount - a.availableModelCount ||
          a.provider.localeCompare(b.provider),
      ),
    [providers],
  );

  const selected = sortedProviders.find((provider) => provider.provider === selectedProvider);
  const configuredCount = sortedProviders.filter((provider) => provider.configured).length;
  // Treat a *missing* capability flag as "API key allowed" so the panel never
  // collapses to a bare provider dropdown against an older/partial agent-server
  // that omits these fields. Only an explicit `false` hides the API-key input.
  const selectedSupportsKey = selected ? selected.supportsApiKey !== false : false;
  const selectedSupportsSubscription = selected?.supportsSubscription === true;
  const canRemoveSelected = selected?.source === "stored" || selected?.credentialType === "oauth";
  const subscriptionActive = Boolean(subscriptionFlow && !isFlowTerminal(subscriptionFlow));
  const showApiKeyControls =
    selectedSupportsKey && (!selectedSupportsSubscription || credentialMode === "api_key");
  const showSubscriptionControls = selectedSupportsSubscription && credentialMode === "subscription";

  const clearMessages = () => {
    setError("");
    setSuccess("");
  };

  const chooseProvider = useCallback((provider: string) => {
    setSelectedProvider(provider);
    setNewKey("");
    setSubscriptionInput("");
    setSubscriptionFallbackOpen(false);
    setSubscriptionFlow(null);
  }, []);

  const loadProviders = useCallback(async () => {
    setLoadingProviders(true);
    try {
      const [authRes, customRes] = await Promise.all([
        client.listAuthProviders(),
        client.listCustomProviders(),
      ]);
      setProviders(authRes.providers);
      setCustomProviders(customRes.providers);
      setSelectedProvider((current) => {
        if (current && authRes.providers.some((provider) => provider.provider === current)) {
          return current;
        }
        const preferred =
          authRes.providers.find((provider) => provider.configured) ||
          authRes.providers.find((provider) => provider.provider === "anthropic") ||
          authRes.providers.find((provider) => provider.provider === "openai-codex") ||
          authRes.providers.find((provider) => provider.provider === "openai") ||
          authRes.providers[0];
        return preferred?.provider ?? "";
      });
    } finally {
      setLoadingProviders(false);
    }
  }, [client]);

  useEffect(() => {
    loadProviders().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [loadProviders]);

  useEffect(() => {
    if (!subscriptionFlow || isFlowTerminal(subscriptionFlow)) return;
    const timer = window.setInterval(() => {
      client
        .getSubscriptionFlow(subscriptionFlow.id)
        .then(async (state) => {
          setSubscriptionFlow(state);
          if (state.status === "complete") {
            setSubscriptionInput("");
            setSubscriptionFallbackOpen(false);
            setSuccess(`${state.providerName} subscription saved.`);
            await loadProviders();
          }
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [client, loadProviders, subscriptionFlow]);

  useEffect(() => {
    setCredentialMode(preferredCredentialMode(selected));
  }, [selected]);

  const handleProviderSelect = (event: ChangeEvent<HTMLSelectElement>) => {
    chooseProvider(event.target.value);
    event.currentTarget.blur();
  };

  const handleCredentialModeChange = async (mode: CredentialMode) => {
    setCredentialMode(mode);
    setNewKey("");
    setSubscriptionInput("");
    setSubscriptionFallbackOpen(false);
    if (mode === "api_key" && subscriptionFlow && !isFlowTerminal(subscriptionFlow)) {
      setSubscriptionBusy(true);
      try {
        await client.cancelSubscriptionFlow(subscriptionFlow.id);
      } catch {
        // Best-effort cleanup; switching modes should still keep the UI moving.
      } finally {
        setSubscriptionBusy(false);
      }
    }
    if (mode === "api_key") setSubscriptionFlow(null);
  };

  const handleSaveKey = async () => {
    if (!selectedProvider || !newKey.trim() || !selectedSupportsKey) return;
    setSaving(true);
    clearMessages();
    try {
      await client.setProviderApiKey(selectedProvider, newKey.trim());
      await loadProviders();
      setNewKey("");
      setSuccess(`${selected?.name || selectedProvider} API key saved.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save credential");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteCredential = async () => {
    if (!selectedProvider) return;
    setSaving(true);
    clearMessages();
    try {
      await client.deleteProviderCredential(selectedProvider);
      await loadProviders();
      setSubscriptionFlow(null);
      setSuccess(`${selected?.name || selectedProvider} credential removed.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to remove credential");
    } finally {
      setSaving(false);
    }
  };

  const handleStartSubscription = async () => {
    if (!selectedProvider || !selectedSupportsSubscription) return;
    setSubscriptionBusy(true);
    clearMessages();
    setSubscriptionInput("");
    setSubscriptionFallbackOpen(false);
    try {
      const state = await client.startProviderSubscription(selectedProvider);
      setSubscriptionFlow(state);
      if (state.status === "complete") {
        setSubscriptionFallbackOpen(false);
        setSuccess(`${state.providerName} subscription saved.`);
        await loadProviders();
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to start subscription login");
    } finally {
      setSubscriptionBusy(false);
    }
  };

  const handleContinueSubscription = async () => {
    if (!subscriptionFlow) return;
    setSubscriptionBusy(true);
    clearMessages();
    try {
      const state = await client.continueSubscriptionFlow(subscriptionFlow.id, subscriptionInput);
      setSubscriptionFlow(state);
      if (state.status === "complete") {
        setSubscriptionInput("");
        setSubscriptionFallbackOpen(false);
        setSuccess(`${state.providerName} subscription saved.`);
        await loadProviders();
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to continue subscription login");
    } finally {
      setSubscriptionBusy(false);
    }
  };

  const handleCancelSubscription = async () => {
    if (!subscriptionFlow) return;
    setSubscriptionBusy(true);
    clearMessages();
    try {
      await client.cancelSubscriptionFlow(subscriptionFlow.id);
      setSubscriptionFlow(null);
      setSubscriptionInput("");
      setSubscriptionFallbackOpen(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to cancel subscription login");
    } finally {
      setSubscriptionBusy(false);
    }
  };

  const updateCustomForm = <K extends keyof CustomForm>(key: K, value: CustomForm[K]) => {
    setCustomForm((current) => ({ ...current, [key]: value }));
  };

  const openCustomProviderEditor = (provider?: AgentCustomProvider) => {
    setCustomForm(provider ? modelFromCustom(provider) : defaultCustomForm);
    setCustomEditorOpen(true);
  };

  const closeCustomProviderEditor = () => {
    setCustomEditorOpen(false);
    setCustomForm(defaultCustomForm);
  };

  const handleSaveCustomProvider = async () => {
    const existing = customProviders.find(
      (provider) => provider.provider === customForm.provider.trim(),
    );
    const contextWindow = Number(customForm.contextWindow);
    const maxTokens = Number(customForm.maxTokens);
    if (!customForm.provider.trim() || !customForm.baseUrl.trim() || !customForm.modelId.trim())
      return;
    if (!customForm.apiKey.trim() && !existing?.apiKeyConfigured) return;
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      setError("Context window must be a positive integer.");
      return;
    }
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      setError("Max tokens must be a positive integer.");
      return;
    }

    setCustomSaving(true);
    clearMessages();
    try {
      const saved = await client.upsertCustomProvider({
        provider: customForm.provider.trim(),
        name: customForm.name.trim() || customForm.provider.trim(),
        baseUrl: customForm.baseUrl.trim(),
        api: customForm.api,
        apiKey: customForm.apiKey.trim() || undefined,
        models: [
          {
            id: customForm.modelId.trim(),
            name: customForm.modelName.trim() || customForm.modelId.trim(),
            api: customForm.api,
            reasoning: customForm.reasoning,
            thinkingLevelMap: thinkingMap(customForm),
            input: ["text"],
            contextWindow,
            maxTokens,
            compat: compatFor(customForm),
          },
        ],
      });
      await loadProviders();
      setCustomForm((current) => ({ ...current, apiKey: "" }));
      setCustomEditorOpen(false);
      setSuccess(`${saved.name || saved.provider} provider saved.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save custom provider");
    } finally {
      setCustomSaving(false);
    }
  };

  const handleDeleteCustomProvider = async (provider: string) => {
    const deletingOpenProvider = customForm.provider === provider;
    setCustomSaving(true);
    clearMessages();
    try {
      await client.deleteCustomProvider(provider);
      await loadProviders();
      if (deletingOpenProvider) closeCustomProviderEditor();
      setSuccess(`${provider} custom provider removed.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to remove custom provider");
    } finally {
      setCustomSaving(false);
    }
  };

  const subscriptionInputPlaceholder =
    subscriptionFlow?.status === "prompt"
      ? subscriptionFlow.prompt?.placeholder || "Value"
      : "Paste redirect URL or authorization code";
  const subscriptionNeedsInput =
    subscriptionFlow?.status === "prompt" ||
    (subscriptionFlow?.status === "auth" && subscriptionFallbackOpen);
  const subscriptionCanUseFallback =
    subscriptionFlow?.status === "auth" &&
    callbackSubscriptionProviders.has(subscriptionFlow.provider) &&
    !isFlowTerminal(subscriptionFlow);
  const showSubscriptionInstructions =
    Boolean(subscriptionFlow?.instructions) &&
    (subscriptionFlow?.status !== "auth" ||
      subscriptionFallbackOpen ||
      !callbackSubscriptionProviders.has(subscriptionFlow.provider));
  const subscriptionContinueDisabled =
    subscriptionBusy ||
    !subscriptionFlow ||
    !subscriptionNeedsInput ||
    (!subscriptionInput.trim() && subscriptionFlow.status !== "prompt") ||
    (!subscriptionInput.trim() &&
      subscriptionFlow.status === "prompt" &&
      !subscriptionFlow.prompt?.allowEmpty);

  const hasOpenEditorProvider = customProviders.some(
    (provider) => provider.provider === customForm.provider.trim(),
  );
  const editorApiKeyMissing =
    !customForm.apiKey.trim() &&
    !customProviders.find((provider) => provider.provider === customForm.provider.trim())
      ?.apiKeyConfigured;

  return (
    <div className={cx("agent-client-root", "agent-settings", className)}>
      <div className="agent-settings-card">
        <h3 className="agent-settings-card-title">{title}</h3>
        {description && <p className="agent-settings-description">{description}</p>}

        <div className="agent-settings-status-row">
          <span className="agent-settings-label">Status</span>
          {loadingProviders ? (
            <span className="agent-settings-muted">Loading...</span>
          ) : configuredCount > 0 ? (
            <span className="agent-settings-status agent-settings-status-on">
              <span className="agent-settings-dot agent-settings-dot-on" />
              {configuredCount} configured
            </span>
          ) : (
            <span className="agent-settings-status agent-settings-status-off">
              <span className="agent-settings-dot agent-settings-dot-off" />
              None stored
            </span>
          )}
        </div>

        {error && <div className="agent-settings-error">{error}</div>}
        {success && <div className="agent-settings-success">{success}</div>}

        <div className="agent-settings-provider-control-row">
          <select
            className="agent-settings-select agent-settings-provider-select"
            value={selectedProvider}
            onChange={handleProviderSelect}
            disabled={loadingProviders || sortedProviders.length === 0}
          >
            {sortedProviders.map((provider) => (
              <option key={provider.provider} value={provider.provider}>
                {providerTitle(provider)}
              </option>
            ))}
          </select>
          {selectedSupportsSubscription && (
            <div className="agent-settings-mode-toggle" role="group" aria-label="Credential mode">
              <button
                type="button"
                className={cx(
                  "agent-settings-mode-btn",
                  credentialMode === "subscription" && "agent-settings-mode-btn-active",
                )}
                onClick={() => void handleCredentialModeChange("subscription")}
              >
                Subscription
              </button>
              <button
                type="button"
                className={cx(
                  "agent-settings-mode-btn",
                  credentialMode === "api_key" && "agent-settings-mode-btn-active",
                )}
                onClick={() => void handleCredentialModeChange("api_key")}
              >
                API key
              </button>
            </div>
          )}
        </div>

        {showApiKeyControls && (
          <div className="agent-settings-key-row">
            <input
              className="agent-settings-input"
              type="password"
              placeholder={
                selected ? `${selected.name || selected.provider} API key` : "Provider API key"
              }
              value={newKey}
              onChange={(event) => setNewKey(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void handleSaveKey()}
            />
            <button
              className="agent-settings-save-btn"
              onClick={() => void handleSaveKey()}
              disabled={saving || !selectedProvider || !newKey.trim()}
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        )}

        {selected && (
          <div className="agent-settings-provider-meta">
            <span className="agent-settings-label">Selected</span>
            <span
              className={
                selected.configured ? "agent-settings-configured" : "agent-settings-unset"
              }
            >
              {sourceLabel(selected.source)}
            </span>
            <span className="agent-settings-muted">
              {selected.availableModelCount}/{selected.modelCount} models
            </span>
          </div>
        )}

        {(showSubscriptionControls || canRemoveSelected) && (
          <div className="agent-settings-action-row">
            {showSubscriptionControls && (
              <button
                className="agent-settings-outline-btn"
                onClick={() => void handleStartSubscription()}
                disabled={subscriptionBusy || subscriptionActive || !selectedProvider}
              >
                {subscriptionBusy
                  ? "Working..."
                  : subscriptionActive
                    ? "Login in progress"
                    : "Subscription Login"}
              </button>
            )}
            {canRemoveSelected && (
              <button
                className="agent-settings-remove-btn"
                onClick={() => void handleDeleteCredential()}
                disabled={saving}
              >
                Remove credential
              </button>
            )}
          </div>
        )}

        {showSubscriptionControls && subscriptionFlow && (
          <div className="agent-settings-flow-panel">
            <div className="agent-settings-flow-header">
              <div className="agent-settings-flow-title-group">
                <span className="agent-settings-label">Browser login</span>
                <span className="agent-settings-flow-provider">{subscriptionFlow.providerName}</span>
              </div>
              <span
                className={cx(
                  "agent-settings-flow-pill",
                  flowStatusModifier(subscriptionFlow.status),
                )}
              >
                {flowStatusLabel(subscriptionFlow.status)}
              </span>
            </div>
            {subscriptionFlow.authUrl && (
              <div className="agent-settings-login-row">
                <a
                  className="agent-settings-login-link"
                  href={subscriptionFlow.authUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open login
                </a>
                {!subscriptionFallbackOpen && !isFlowTerminal(subscriptionFlow) && (
                  <span className="agent-settings-waiting">Waiting for login to finish</span>
                )}
              </div>
            )}
            {subscriptionFlow.prompt && (
              <p className="agent-settings-flow-text">{subscriptionFlow.prompt.message}</p>
            )}
            {showSubscriptionInstructions && (
              <p className="agent-settings-flow-text">{subscriptionFlow.instructions}</p>
            )}
            {subscriptionFlow.error && (
              <div className="agent-settings-error">{subscriptionFlow.error}</div>
            )}
            {subscriptionFlow.progress.length > 0 && (
              <div className="agent-settings-progress">{subscriptionFlow.progress.at(-1)}</div>
            )}
            {subscriptionNeedsInput && (
              <div className="agent-settings-flow-input-row">
                <input
                  className="agent-settings-input"
                  value={subscriptionInput}
                  placeholder={subscriptionInputPlaceholder}
                  onChange={(event) => setSubscriptionInput(event.target.value)}
                  onKeyDown={(event) =>
                    event.key === "Enter" &&
                    !subscriptionContinueDisabled &&
                    void handleContinueSubscription()
                  }
                />
                <button
                  className="agent-settings-save-btn"
                  onClick={() => void handleContinueSubscription()}
                  disabled={subscriptionContinueDisabled}
                >
                  {subscriptionFlow.status === "prompt" ? "Continue" : "Submit"}
                </button>
              </div>
            )}
            {!isFlowTerminal(subscriptionFlow) && (
              <div className="agent-settings-flow-actions">
                {subscriptionCanUseFallback && !subscriptionFallbackOpen && (
                  <button
                    type="button"
                    className="agent-settings-fallback-btn"
                    onClick={() => setSubscriptionFallbackOpen(true)}
                  >
                    Use manual fallback
                  </button>
                )}
                <button
                  type="button"
                  className="agent-settings-flow-cancel-btn"
                  onClick={() => void handleCancelSubscription()}
                  disabled={subscriptionBusy}
                >
                  Cancel login
                </button>
              </div>
            )}
          </div>
        )}

        <div className="agent-settings-provider-list">
          {sortedProviders.length === 0 ? (
            <span className="agent-settings-empty">No providers reported by agent-server</span>
          ) : (
            sortedProviders.slice(0, 14).map((provider) => (
              <button
                key={provider.provider}
                type="button"
                className={cx(
                  "agent-settings-provider-row",
                  provider.provider === selectedProvider && "agent-settings-provider-row-active",
                )}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseProvider(provider.provider)}
              >
                <span className="agent-settings-provider-name">
                  {provider.name || provider.provider}
                </span>
                <span
                  className={
                    provider.configured ? "agent-settings-configured" : "agent-settings-unset"
                  }
                >
                  {sourceLabel(provider.source)}
                </span>
                <span className="agent-settings-provider-count">
                  {provider.availableModelCount}/{provider.modelCount}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="agent-settings-section">
          <div className="agent-settings-section-header">
            <div className="agent-settings-section-title-group">
              <h3 className="agent-settings-card-title agent-settings-section-title">
                Custom Provider
              </h3>
              <span className="agent-settings-muted">
                {customProviders.length === 1
                  ? "1 configured"
                  : `${customProviders.length} configured`}
              </span>
            </div>
            <button
              type="button"
              className="agent-settings-icon-btn"
              aria-label={customEditorOpen ? "Close custom provider editor" : "Add custom provider"}
              title={customEditorOpen ? "Close" : "Add custom provider"}
              onClick={
                customEditorOpen ? closeCustomProviderEditor : () => openCustomProviderEditor()
              }
            >
              {customEditorOpen ? "\u00d7" : "+"}
            </button>
          </div>

          {customProviders.length > 0 ? (
            <div className="agent-settings-custom-list">
              {customProviders.map((provider) => (
                <div key={provider.provider} className="agent-settings-custom-row">
                  <button
                    type="button"
                    className="agent-settings-custom-pick"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => openCustomProviderEditor(provider)}
                  >
                    <span className="agent-settings-provider-name">
                      {provider.name || provider.provider}
                    </span>
                    <span className="agent-settings-muted">{provider.modelCount} models</span>
                    <span
                      className={
                        provider.apiKeyConfigured
                          ? "agent-settings-configured"
                          : "agent-settings-unset"
                      }
                    >
                      {provider.apiKeyConfigured ? "Key stored" : "No key"}
                    </span>
                  </button>
                  <button
                    className="agent-settings-remove-btn"
                    onClick={() => void handleDeleteCustomProvider(provider.provider)}
                    disabled={customSaving}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : (
            !customEditorOpen && <span className="agent-settings-empty">No custom providers</span>
          )}

          {customEditorOpen && (
            <div className="agent-settings-custom-editor">
              <div className="agent-settings-custom-grid">
                <label className="agent-settings-field">
                  Provider
                  <input
                    className="agent-settings-input"
                    value={customForm.provider}
                    onChange={(event) => updateCustomForm("provider", event.target.value)}
                  />
                </label>
                <label className="agent-settings-field">
                  Name
                  <input
                    className="agent-settings-input"
                    value={customForm.name}
                    onChange={(event) => updateCustomForm("name", event.target.value)}
                  />
                </label>
                <label className="agent-settings-field agent-settings-field-wide">
                  Base URL
                  <input
                    className="agent-settings-input"
                    value={customForm.baseUrl}
                    onChange={(event) => updateCustomForm("baseUrl", event.target.value)}
                  />
                </label>
                <label className="agent-settings-field">
                  API
                  <select
                    className="agent-settings-select"
                    value={customForm.api}
                    onChange={(event) =>
                      updateCustomForm("api", event.target.value as AgentCustomProviderApi)
                    }
                  >
                    {(
                      [
                        "openai-responses",
                        "openai-completions",
                        "anthropic-messages",
                      ] as AgentCustomProviderApi[]
                    ).map((api) => (
                      <option key={api} value={api}>
                        {apiLabel(api)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="agent-settings-field">
                  API key
                  <input
                    className="agent-settings-input"
                    type="password"
                    value={customForm.apiKey}
                    placeholder={hasOpenEditorProvider ? "Stored" : "Required"}
                    onChange={(event) => updateCustomForm("apiKey", event.target.value)}
                  />
                </label>
                <label className="agent-settings-field agent-settings-field-wide">
                  Model
                  <input
                    className="agent-settings-input"
                    value={customForm.modelId}
                    onChange={(event) => updateCustomForm("modelId", event.target.value)}
                  />
                </label>
                <label className="agent-settings-field agent-settings-field-wide">
                  Model name
                  <input
                    className="agent-settings-input"
                    value={customForm.modelName}
                    onChange={(event) => updateCustomForm("modelName", event.target.value)}
                  />
                </label>
                <label className="agent-settings-field">
                  Context
                  <input
                    className="agent-settings-input"
                    inputMode="numeric"
                    value={customForm.contextWindow}
                    onChange={(event) => updateCustomForm("contextWindow", event.target.value)}
                  />
                </label>
                <label className="agent-settings-field">
                  Max tokens
                  <input
                    className="agent-settings-input"
                    inputMode="numeric"
                    value={customForm.maxTokens}
                    onChange={(event) => updateCustomForm("maxTokens", event.target.value)}
                  />
                </label>
              </div>

              <div className="agent-settings-toggle-row">
                <label className="agent-settings-checkbox">
                  <input
                    type="checkbox"
                    checked={customForm.reasoning}
                    onChange={(event) => updateCustomForm("reasoning", event.target.checked)}
                  />
                  Reasoning
                </label>
                <select
                  className="agent-settings-compact-select"
                  value={customForm.thinkingPreset}
                  onChange={(event) =>
                    updateCustomForm(
                      "thinkingPreset",
                      event.target.value as CustomForm["thinkingPreset"],
                    )
                  }
                  disabled={!customForm.reasoning}
                >
                  <option value="standard">Standard thinking</option>
                  <option value="deepseek">DeepSeek thinking</option>
                  <option value="none">No thinking map</option>
                </select>
                <button
                  className="agent-settings-save-btn"
                  onClick={() => void handleSaveCustomProvider()}
                  disabled={
                    customSaving ||
                    !customForm.provider.trim() ||
                    !customForm.baseUrl.trim() ||
                    !customForm.modelId.trim() ||
                    editorApiKeyMissing
                  }
                >
                  {customSaving ? "Saving..." : "Save provider"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
