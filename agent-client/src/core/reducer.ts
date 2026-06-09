/**
 * Pure reducer translating agent-server SSE `AgentEvent`s and REST history into
 * renderable `UiMessage[]`
 * keep it framework-agnostic so it can be unit-tested in isolation.
 */
import type {
  AgentEvent,
  AgentModel,
  AgentSessionModelSettings,
  ExtensionUiRequest,
  AgentMessage,
  AssistantMessagePartial,
  SessionState,
  ToolCall,
  ToolResultMessage,
  UiMessage,
  UiMessagePart,
} from "./types";

type ToolPart = Extract<UiMessagePart, { type: "tool" }>;
type ToolPatch = Partial<Omit<ToolPart, "id" | "type">>;
type ToolInfo = { id: string; patch: ToolPatch };

/**
 * Extract a tool call from a content block. Tool-call blocks are the canonical
 * pi `ToolCall` shape (`{ type: 'toolCall'; id; name; arguments }`) — the same
 * contract agent-server publishes — so the fields are read directly, with no
 * field-name guessing.
 */
function toolInfoFromContent(
  content: Record<string, unknown> | undefined,
  contentIndex?: number,
): ToolInfo | null {
  if (!content || content.type !== "toolCall") return null;
  const toolCall = content as unknown as ToolCall;
  return {
    id: String(toolCall.id ?? `content-${contentIndex ?? 0}`),
    patch: {
      contentIndex,
      name: toolCall.name ?? "tool",
      args: toolCall.arguments,
    },
  };
}

/** Concatenate the text of a message's content (which may be a plain string). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      (block as { type?: string }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

/**
 * Build UI parts from a message's `content`. pi user messages may carry a plain
 * string; assistant messages carry an array of canonical content blocks
 * (`text` / `thinking` / `toolCall`).
 */
function partsFromContent(content: unknown): UiMessagePart[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content, contentIndex: 0 }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: UiMessagePart[] = [];
  for (const [contentIndex, raw] of (content as Array<Record<string, unknown>>).entries()) {
    if (raw.type === "text") {
      parts.push({ type: "text", text: String(raw.text ?? ""), contentIndex });
      continue;
    }
    const toolInfo = toolInfoFromContent(raw, contentIndex);
    if (toolInfo) {
      parts.push({
        type: "tool",
        id: toolInfo.id,
        name: toolInfo.patch.name ?? "tool",
        contentIndex,
        args: toolInfo.patch.args,
        status: "pending",
      });
    }
  }
  return parts;
}

const isToolResultMessage = (m: AgentMessage): m is ToolResultMessage =>
  (m as { role?: string }).role === "toolResult";

/**
 * Extract a provider/run error from a finalized assistant message, if any.
 *
 * pi reports LLM/provider failures as a *normal* run that ends with an assistant
 * message whose `stopReason` is `"error"` (carrying `errorMessage`) — it does not
 * throw, so the prompt promise resolves and nothing logs server-side. This is
 * therefore the only place the failure reason is carried; the reducer surfaces
 * it into `state.error` so the UI can show it instead of an empty bubble.
 * `"aborted"` is a user-initiated stop, not an error, so it is ignored.
 */
function assistantErrorMessage(message: AgentMessage): string | null {
  if (message.role !== "assistant") return null;
  if (message.stopReason !== "error") return null;
  return message.errorMessage || "The model returned an error.";
}

/**
 * Pull the text + originating tool-call id out of a tool-result message. pi's
 * `ToolResultMessage` carries a canonical `toolCallId` plus a `content` array of
 * text/image blocks, so both are read directly.
 */
function extractToolResultText(message: ToolResultMessage): {
  text: string;
  toolUseId: string | null;
} {
  return {
    text: contentText(message.content),
    toolUseId: message.toolCallId ?? null,
  };
}

function applyToolResult(messages: UiMessage[], toolCallId: string, patch: ToolPatch): UiMessage[] {
  return messages.map((m) => {
    const idx = m.parts.findIndex((p) => p.type === "tool" && p.id === toolCallId);
    if (idx === -1) return m;
    const next = [...m.parts];
    next[idx] = { ...(next[idx] as ToolPart), ...patch };
    return { ...m, parts: next };
  });
}

function latestAssistantIndex(messages: UiMessage[], requireStreaming: boolean): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && message.role === "assistant" && (!requireStreaming || message.streaming))
      return i;
  }
  return -1;
}

function insertPartByContentIndex(parts: UiMessagePart[], part: UiMessagePart): UiMessagePart[] {
  if (typeof part.contentIndex !== "number") return [...parts, part];
  const insertAt = parts.findIndex(
    (candidate) =>
      typeof candidate.contentIndex === "number" && candidate.contentIndex > part.contentIndex!,
  );
  if (insertAt === -1) return [...parts, part];
  return [...parts.slice(0, insertAt), part, ...parts.slice(insertAt)];
}

function findToolPartIndex(
  parts: UiMessagePart[],
  toolCallId: string,
  contentIndex?: number,
): number {
  return parts.findIndex(
    (p) =>
      p.type === "tool" &&
      ((toolCallId && p.id === toolCallId) ||
        (typeof contentIndex === "number" && p.contentIndex === contentIndex)),
  );
}

/**
 * Carry forward tool execution state (status / result / isError) onto freshly
 * derived parts. Tool execution outcomes are NOT part of the assistant message
 * — they arrive via separate `tool_execution_*` events and `toolResult`
 * messages — so when we re-derive parts from an assistant-message snapshot we
 * must preserve any execution state already recorded on the prior parts.
 */
function mergeToolState(newParts: UiMessagePart[], prevParts: UiMessagePart[]): UiMessagePart[] {
  return newParts.map((part) => {
    if (part.type !== "tool") return part;
    const prev = prevParts.find(
      (candidate) =>
        candidate.type === "tool" &&
        ((part.id && candidate.id === part.id) ||
          (typeof part.contentIndex === "number" && candidate.contentIndex === part.contentIndex)),
    ) as ToolPart | undefined;
    return prev
      ? {
          ...part,
          status: prev.status,
          result: prev.result,
          isError: prev.isError,
        }
      : part;
  });
}

/**
 * Structural equality for two UI parts. Used to decide whether a freshly
 * derived part can reuse the previous object's *reference* (so memoized part
 * components bail out of re-rendering)
 */
function samePart(a: UiMessagePart, b: UiMessagePart): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "text" && b.type === "text") {
    return a.text === b.text && a.contentIndex === b.contentIndex;
  }
  if (a.type === "tool" && b.type === "tool") {
    return (
      a.id === b.id &&
      a.name === b.name &&
      a.status === b.status &&
      a.isError === b.isError &&
      a.contentIndex === b.contentIndex &&
      a.args === b.args &&
      a.result === b.result
    );
  }
  return false;
}

/**
 * Return `next`, but substitute the previous part object wherever it is
 * structurally identical. This keeps stable references for parts that didn't
 * change between snapshots (e.g. a completed text block above the one currently
 * streaming), letting `React.memo`'d part components skip re-rendering — and,
 * crucially, skip re-parsing markdown.
 */
function preservePartRefs(next: UiMessagePart[], prev: UiMessagePart[]): UiMessagePart[] {
  return next.map((part) => prev.find((candidate) => samePart(candidate, part)) ?? part);
}

/**
 * Re-derive the streaming assistant message's parts from the authoritative
 * `partial` snapshot that every `message_update` sub-event carries.
 */
function applyAssistantSnapshot(
  messages: UiMessage[],
  partial: AssistantMessagePartial,
): UiMessage[] {
  let messageIndex = latestAssistantIndex(messages, true);
  if (messageIndex === -1) messageIndex = latestAssistantIndex(messages, false);
  if (messageIndex === -1) return messages;

  const rebuilt = partsFromContent(partial.content);
  if (rebuilt.length === 0) return messages;

  const message = messages[messageIndex]!;
  const nextParts = preservePartRefs(mergeToolState(rebuilt, message.parts), message.parts);
  const nextMessages = [...messages];
  nextMessages[messageIndex] = { ...message, parts: nextParts };
  return nextMessages;
}

function createToolPart(toolCallId: string, patch: ToolPatch): ToolPart {
  const tool: ToolPart = {
    type: "tool",
    id: toolCallId,
    name: patch.name ?? "tool",
    status: patch.status ?? "pending",
  };
  if ("contentIndex" in patch) tool.contentIndex = patch.contentIndex;
  if ("args" in patch) tool.args = patch.args;
  if ("result" in patch) tool.result = patch.result;
  if ("isError" in patch) tool.isError = patch.isError;
  return tool;
}

function upsertToolPart(messages: UiMessage[], toolCallId: string, patch: ToolPatch): UiMessage[] {
  let found = false;
  const patched = messages.map((m) => {
    const idx = findToolPartIndex(m.parts, toolCallId, patch.contentIndex);
    if (idx === -1) return m;
    found = true;
    const next = [...m.parts];
    next[idx] = { ...(next[idx] as ToolPart), ...patch };
    return { ...m, parts: next };
  });
  if (found) return patched;

  let messageIndex = latestAssistantIndex(patched, true);
  if (messageIndex === -1) messageIndex = latestAssistantIndex(patched, false);
  if (messageIndex === -1) return patched;

  const nextMessages = [...patched];
  const message = nextMessages[messageIndex]!;
  nextMessages[messageIndex] = {
    ...message,
    parts: insertPartByContentIndex(message.parts, createToolPart(toolCallId, patch)),
  };
  return nextMessages;
}

function resultToText(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object" && Array.isArray((result as { content?: unknown }).content)) {
    return (result as { content: Array<{ type?: string; text?: string }> }).content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export type SessionAction =
  | { type: "agent_event"; event: AgentEvent }
  | { type: "set_session_id"; sessionId: string }
  | { type: "set_connected"; connected: boolean }
  | { type: "set_error"; error: string | null }
  | { type: "user_prompt_submitted"; text: string; promptId: string }
  | { type: "load_history"; messages: AgentMessage[] }
  | { type: "load_extension_requests"; requests: ExtensionUiRequest[] }
  | { type: "extension_ui_response"; requestId: string }
  | { type: "set_models"; models: AgentModel[] }
  | { type: "set_model_settings"; settings: AgentSessionModelSettings }
  | { type: "set_model_settings_busy"; busy: boolean }
  | { type: "set_model_settings_error"; error: string | null }
  | { type: "reset" };

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "set_session_id":
      return { ...state, sessionId: action.sessionId };
    case "set_connected":
      return { ...state, connected: action.connected };
    case "set_error":
      return { ...state, error: action.error };
    case "user_prompt_submitted":
      return {
        ...state,
        status: "starting",
        error: null,
        messageSeq: state.messageSeq + 1,
        // Track the correlation id (FIFO) so the server echo can be matched by
        // id, not by comparing prompt text (see `message_start`).
        pendingPromptIds: [...state.pendingPromptIds, action.promptId],
        messages: [
          ...state.messages,
          {
            id: `m${state.messageSeq}`,
            role: "user",
            parts: [{ type: "text", text: action.text }],
            streaming: false,
            timestamp: new Date().toISOString(),
            promptId: action.promptId,
          },
        ],
      };
    case "reset":
      return {
        ...state,
        messages: [],
        pendingPromptIds: [],
        extensionRequests: [],
        extensionNotice: null,
        status: "idle",
        error: null,
      };
    case "load_history":
      return loadHistory(state, action.messages);
    case "load_extension_requests":
      return mergeExtensionRequests(state, action.requests);
    case "extension_ui_response":
      return {
        ...state,
        extensionRequests: state.extensionRequests.filter(
          (request) => request.id !== action.requestId,
        ),
      };
    case "set_models":
      return { ...state, models: action.models };
    case "set_model_settings":
      return { ...state, modelSettings: action.settings, modelSettingsError: null };
    case "set_model_settings_busy":
      return { ...state, modelSettingsBusy: action.busy };
    case "set_model_settings_error":
      return { ...state, modelSettingsError: action.error };
    case "agent_event":
      return reduceEvent(state, action.event);
  }
}

function isBlockingExtensionRequest(request: ExtensionUiRequest): boolean {
  return (
    request.method === "select" ||
    request.method === "confirm" ||
    request.method === "input" ||
    request.method === "editor"
  );
}

function mergeExtensionRequests(state: SessionState, requests: ExtensionUiRequest[]): SessionState {
  const activeIds = new Set(
    requests.filter(isBlockingExtensionRequest).map((request) => request.id),
  );
  let next = {
    ...state,
    extensionRequests: state.extensionRequests.filter((request) => activeIds.has(request.id)),
  };
  for (const request of requests) next = reduceExtensionUiRequest(next, request);
  return next;
}

function reduceExtensionUiRequest(state: SessionState, request: ExtensionUiRequest): SessionState {
  if (request.method === "setStatus") {
    const extensionStatus = { ...state.extensionStatus };
    if (request.statusText) extensionStatus[request.statusKey] = request.statusText;
    else delete extensionStatus[request.statusKey];
    return { ...state, extensionStatus };
  }
  if (request.method === "notify") {
    return {
      ...state,
      extensionNotice: {
        id: request.id,
        message: request.message,
        type: request.notifyType,
      },
    };
  }
  if (!isBlockingExtensionRequest(request)) return state;
  if (state.extensionRequests.some((existing) => existing.id === request.id)) return state;
  return { ...state, extensionRequests: [...state.extensionRequests, request] };
}

function loadHistory(state: SessionState, history: AgentMessage[]): SessionState {
  const messages: UiMessage[] = [];
  for (const m of history) {
    if (isToolResultMessage(m)) continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    const parts = partsFromContent(m.content);
    if (parts.length === 0) continue;
    messages.push({
      // History is rebuilt deterministically from the server transcript, so a
      // position-based id stays stable across repeated reloads (no churn).
      id: `h${messages.length}`,
      role: m.role,
      parts,
      streaming: false,
      timestamp: m.timestamp,
    });
  }

  let result = messages;
  for (const m of history) {
    if (!isToolResultMessage(m)) continue;
    const { text, toolUseId } = extractToolResultText(m);
    if (!toolUseId) continue;
    result = applyToolResult(result, toolUseId, {
      status: m.isError ? "error" : "done",
      result: text,
      isError: m.isError,
    });
  }

  return { ...state, messages: result, status: "idle", error: null, pendingPromptIds: [] };
}

function reduceEvent(state: SessionState, event: AgentEvent): SessionState {
  switch (event.type) {
    case "extension_ui_request":
      return reduceExtensionUiRequest(state, event);
    case "agent_start":
      return { ...state, status: "starting", error: null };
    case "turn_start":
      return state;
    case "message_start": {
      if (isToolResultMessage(event.message)) return state;
      if (event.message.role !== "user" && event.message.role !== "assistant") return state;

      // Reconcile a user message against the optimistic bubble we already added
      // when the prompt was submitted. We match the oldest still-pending
      // correlation id (FIFO) rather than comparing message text, so two
      // identical prompts in a row can't mis-dedupe. A user message_start with
      // no pending id (e.g. injected server-side or from another client) falls
      // through and is appended as a new message.
      if (event.message.role === "user" && state.pendingPromptIds.length > 0) {
        const [promptId, ...restPending] = state.pendingPromptIds;
        const serverParts = partsFromContent(event.message.content);
        const messages = state.messages.map((message) =>
          message.promptId === promptId
            ? {
                ...message,
                // Adopt the server's content/timestamp so any extension-side
                // input transform is reflected; clear the now-settled id.
                parts: serverParts.length > 0 ? serverParts : message.parts,
                timestamp: event.message.timestamp,
                promptId: undefined,
              }
            : message,
        );
        return { ...state, pendingPromptIds: restPending, messages };
      }

      const initialParts = partsFromContent(event.message.content);
      const newMsg: UiMessage = {
        id: `m${state.messageSeq}`,
        role: event.message.role,
        parts: initialParts,
        streaming: event.message.role === "assistant",
        timestamp: event.message.timestamp,
      };
      return {
        ...state,
        // A fresh assistant message clears any error from a previous turn or a
        // since-retried attempt, so an auto-retry that ultimately succeeds
        // doesn't leave a stale error banner.
        error: event.message.role === "assistant" ? null : state.error,
        status: event.message.role === "assistant" ? "streaming" : state.status,
        messageSeq: state.messageSeq + 1,
        messages: [...state.messages, newMsg],
      };
    }
    case "message_update": {
      // Every streaming sub-event except `done`/`error` carries `partial` — the
      // full accumulated AssistantMessage. We re-derive the message's parts from
      // that authoritative snapshot rather than hand-accumulating deltas (see
      // `applyAssistantSnapshot`). `done`/`error` carry no `partial`; the
      // terminal `message_end` event finalises the message instead.
      const ev = event.assistantMessageEvent;
      if (!("partial" in ev)) return state;
      return {
        ...state,
        messages: applyAssistantSnapshot(state.messages, ev.partial),
        status: "streaming",
      };
    }
    case "message_end": {
      if (isToolResultMessage(event.message)) {
        const { text, toolUseId } = extractToolResultText(event.message);
        const isError = event.message.isError;
        if (!toolUseId) return state;
        return {
          ...state,
          messages: applyToolResult(state.messages, toolUseId, {
            status: isError ? "error" : "done",
            result: text,
            isError,
          }),
        };
      }
      if (event.message.role !== "user" && event.message.role !== "assistant") return state; // FIXME: what case is that even covering?
      const finalisedParts = partsFromContent(event.message.content);
      let replaced = false;
      const messages = state.messages.map((m) => {
        if (replaced) return m;
        if (m.role !== event.message.role || !m.streaming) return m;
        replaced = true;
        const merged = mergeToolState(finalisedParts, m.parts);
        return {
          ...m,
          parts: merged.length > 0 ? merged : m.parts,
          streaming: false,
        };
      });
      // pi delivers provider/run failures as the finalized assistant message's
      // stopReason/errorMessage (empty content), so surface it here.
      const runError = assistantErrorMessage(event.message);
      return { ...state, messages, ...(runError ? { error: runError } : {}) };
    }
    case "tool_execution_start":
      return {
        ...state,
        messages: upsertToolPart(state.messages, event.toolCallId, {
          name: event.toolName,
          args: event.args,
          status: "running",
        }),
      };
    case "tool_execution_update":
      return {
        ...state,
        messages: upsertToolPart(state.messages, event.toolCallId, {
          name: event.toolName,
          args: event.args,
          status: "running",
          result: resultToText(event.partialResult),
        }),
      };
    case "tool_execution_end":
      return {
        ...state,
        messages: upsertToolPart(state.messages, event.toolCallId, {
          name: event.toolName,
          status: event.isError ? "error" : "done",
          result: resultToText(event.result),
          isError: event.isError,
        }),
      };
    case "agent_end": {
      // Belt-and-suspenders: agent_end always carries the terminal messages plus
      // `willRetry`, so on a non-retrying end we surface any error the final
      // assistant message reported even if message_end was missed. While a retry
      // is pending we leave the (cleared-on-next-message_start) state alone.
      const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
      const runError =
        !event.willRetry && lastAssistant ? assistantErrorMessage(lastAssistant) : null;
      return {
        ...state,
        status: "idle",
        error: runError ?? state.error,
        messages: state.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
      };
    }
    default:
      return state;
  }
}
