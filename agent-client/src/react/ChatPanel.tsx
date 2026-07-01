import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentModel, ThinkingLevel, UiMessage } from "../core/types";
import { aggregateSessionUsage } from "../core/usage";
import { resolveCostRates, useAgentChatContext } from "./context";
import { useAgentSession } from "./useAgentSession";
import { MessageItem } from "./MessageItem";
import { MessageList } from "./MessageList";
import { UsageBar } from "./UsageBar";
import { ExtensionRequestPanel, isBlockingRequest } from "./ExtensionRequestPanel";

function modelOptionValue(model: AgentModel): string {
  return JSON.stringify([model.provider, model.id]);
}

function parseModelOptionValue(value: string): { provider: string; modelId: string } | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || typeof parsed[1] !== "string")
      return null;
    return { provider: parsed[0], modelId: parsed[1] };
  } catch {
    return null;
  }
}

function modelLabel(model: AgentModel): string {
  return model.name && model.name !== model.id
    ? `${model.name} - ${model.provider}/${model.id}`
    : `${model.provider}/${model.id}`;
}

const thinkingLabels: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-high",
};

export interface ChatPanelProps {
  projectId: string;
  sessionId: string;
  /** Called once each time a streaming turn settles back to idle. */
  onTurnComplete?: () => void;
  /** Toggle the model + thinking-level selectors in the header. Default: true. */
  showModelControls?: boolean;
  /** Toggle the per-session usage readout (cost / cache-hit / context). Default: true. */
  showUsage?: boolean;
  /** Toggle the built-in header entirely. Default: true. */
  showHeader?: boolean;
  /** Override the rendering of a single message; receives the default node. */
  renderMessage?: (message: UiMessage, index: number, defaultNode: ReactNode) => ReactNode;
  /** Override the empty-conversation placeholder. */
  renderEmpty?: () => ReactNode;
  className?: string;
}

/**
 * The full single-session chat surface: streaming transcript, tool-call cards,
 * extension-UI prompts, model/thinking controls, and the composer. Pulls its
 * live state from the shared `SessionStore` via `useAgentSession`.
 */
export function ChatPanel({
  projectId,
  sessionId,
  onTurnComplete,
  showModelControls = true,
  showUsage = true,
  showHeader = true,
  renderMessage,
  renderEmpty,
  className,
}: ChatPanelProps) {
  const { classNames, labels, costRates } = useAgentChatContext();
  const { state, sendPrompt, abort, respondExtensionRequest, loadModelSettings, updateModelSettings } =
    useAgentSession(projectId, sessionId);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const prevStatusRef = useRef(state.status);

  // Model/thinking settings are owned by the store (single source of truth),
  // so the panel just reads the live slice instead of duplicating it locally.
  const { models, modelSettings: sessionSettings, modelSettingsError: settingsError } = state;
  const isRunning = state.status === "streaming" || state.status === "starting";
  // The store's status already reflects whether a turn is running (locally or
  // from another client via the shared SSE stream), so we no longer poll the
  // server's `isStreaming` flag to gate the controls.
  const controlsDisabled = state.modelSettingsBusy || isRunning;
  const modelValue = sessionSettings?.model ? modelOptionValue(sessionSettings.model) : "";
  const thinkingLevels: ThinkingLevel[] = sessionSettings?.availableThinkingLevels ?? ["off"];
  const extensionStatus = Object.values(state.extensionStatus).find(Boolean);
  const activeExtensionRequest = state.extensionRequests.find(isBlockingRequest);

  // Per-session usage folds the raw transcript against the active model's
  // context window and (for zero-cost LiteLLM models) consumer-supplied rates.
  const activeModel = sessionSettings?.model ?? null;
  const costRatesForModel = useMemo(
    () => resolveCostRates(costRates, activeModel),
    [costRates, activeModel],
  );
  const usage = useMemo(
    () =>
      aggregateSessionUsage(state.rawMessages, {
        contextWindow: activeModel?.contextWindow,
        costRates: costRatesForModel,
      }),
    [state.rawMessages, activeModel?.contextWindow, costRatesForModel],
  );
  const showUsageBar = showUsage && usage.assistantMessages > 0;

  useEffect(() => {
    // Usage needs the active model's contextWindow / cost rates, so load
    // settings whenever either the controls or the usage readout is shown.
    if (showModelControls || showUsage) void loadModelSettings();
  }, [showModelControls, showUsage, loadModelSettings]);

  useEffect(() => {
    if (prevStatusRef.current !== "idle" && state.status === "idle") {
      onTurnComplete?.();
    }
    prevStatusRef.current = state.status;
  }, [state.status, onTurnComplete]);

  const updateModelSelection = (next: { provider: string; modelId: string }) => {
    void updateModelSettings(next);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    try {
      await sendPrompt(text);
    } catch (err) {
      console.error("[agent-client] failed to send prompt:", err);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const renderDefaultMessage = (message: UiMessage): ReactNode => (
    <MessageItem
      message={message}
      agentName={labels.agentName}
      userName={labels.userName}
      messageClass={classNames.message}
      userMessageClass={classNames.userMessage}
      assistantMessageClass={classNames.assistantMessage}
      toolCardClass={classNames.toolCard}
    />
  );

  return (
    <div
      className={["agent-chat-chat-panel", classNames.chatPanel, className]
        .filter(Boolean)
        .join(" ")}
    >
      {showHeader && (
        <div className="agent-chat-header">
          <div className="agent-chat-header-status">
            <span className="agent-chat-header-title">{labels.agentName}</span>
            <span
              className={
                isRunning ? "agent-chat-status agent-chat-status-active" : "agent-chat-status"
              }
            >
              {!state.connected ? "connecting" : isRunning ? state.status : "idle"}
            </span>
            {extensionStatus && <span className="agent-chat-ext-status">{extensionStatus}</span>}
            {settingsError && (
              <span className="agent-chat-settings-error" title={settingsError}>
                model settings unavailable
              </span>
            )}
          </div>
          {showModelControls && (
            <div className="agent-chat-model-controls" aria-label="Agent model settings">
              <label className="agent-chat-control">
                <span className="agent-chat-control-label">Model</span>
                <select
                  className="agent-chat-select"
                  value={modelValue}
                  onChange={(e) => {
                    const next = parseModelOptionValue(e.target.value);
                    if (next) updateModelSelection(next);
                  }}
                  disabled={controlsDisabled || models.length === 0}
                  title={
                    sessionSettings?.model ? modelLabel(sessionSettings.model) : "No model selected"
                  }
                >
                  {!sessionSettings?.model && <option value="">No model</option>}
                  {models.map((model) => (
                    <option
                      key={`${model.provider}/${model.id}`}
                      value={modelOptionValue(model)}
                      disabled={!model.available}
                    >
                      {model.available ? modelLabel(model) : `${modelLabel(model)} - unavailable`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="agent-chat-control">
                <span className="agent-chat-control-label">Think</span>
                <select
                  className="agent-chat-select"
                  value={sessionSettings?.thinkingLevel ?? "off"}
                  onChange={(e) =>
                    void updateModelSettings({ thinkingLevel: e.target.value as ThinkingLevel })
                  }
                  disabled={controlsDisabled || !sessionSettings || thinkingLevels.length <= 1}
                  title={
                    sessionSettings?.supportsThinking
                      ? "Thinking level for the next agent turn"
                      : "Selected model does not support thinking"
                  }
                >
                  {thinkingLevels.map((level) => (
                    <option key={level} value={level}>
                      {thinkingLabels[level]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </div>
      )}

      {state.messages.length === 0 ? (
        <div className="agent-chat-messages agent-chat-messages-empty">
          {renderEmpty ? (
            renderEmpty()
          ) : (
            <div className="agent-chat-empty">
              <span className="agent-chat-empty-text">{labels.emptyConversation}</span>
            </div>
          )}
        </div>
      ) : (
        // Remount per session so the list re-anchors at that session's newest
        // message (initialTopMostItemIndex is read on mount).
        <MessageList
          key={sessionId}
          messages={state.messages}
          renderItem={(message, index) => {
            const defaultNode = renderDefaultMessage(message);
            return renderMessage ? renderMessage(message, index, defaultNode) : defaultNode;
          }}
        />
      )}

      {state.error && <div className="agent-chat-error-banner">{state.error}</div>}
      {state.extensionNotice && (
        <div
          className={
            state.extensionNotice.type === "error"
              ? "agent-chat-error-banner"
              : "agent-chat-notice-banner"
          }
        >
          {state.extensionNotice.message}
        </div>
      )}
      {activeExtensionRequest && (
        <ExtensionRequestPanel
          request={activeExtensionRequest}
          onRespond={respondExtensionRequest}
        />
      )}

      <div className={["agent-chat-input-bar", classNames.inputBar].filter(Boolean).join(" ")}>
        <textarea
          className="agent-chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isRunning ? labels.workingPlaceholder : labels.inputPlaceholder}
          rows={1}
          disabled={sending}
        />
        {isRunning ? (
          <button className="agent-chat-btn-stop" onClick={() => void abort()}>
            {labels.stopButton}
          </button>
        ) : (
          <button
            className="agent-chat-btn-send"
            onClick={() => void handleSend()}
            disabled={sending || !input.trim()}
          >
            {sending ? "..." : labels.sendButton}
          </button>
        )}
      </div>

      {showUsageBar && (
        <UsageBar
          metrics={usage}
          labels={{
            cost: labels.usageCost,
            cache: labels.usageCache,
            context: labels.usageContext,
          }}
        />
      )}
    </div>
  );
}
