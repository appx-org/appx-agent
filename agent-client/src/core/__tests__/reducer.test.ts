/**
 * Unit tests for the pure `sessionReducer`. Because the reducer is a pure
 * `(state, action) => state` function with no I/O, we can drive it with synthetic
 * wire-event sequences and assert on the derived `UiMessage[]` directly.
 *
 * Wire fixtures are built loosely and cast once through `emit`: the canonical
 * `AssistantMessage` carries many fields (usage/model/stopReason/…) the reducer
 * never reads, so spelling them all out would add noise without adding coverage.
 */
import { describe, it, expect } from "vitest";
import { sessionReducer, type SessionAction } from "../reducer";
import {
  initialSessionState,
  type AgentEvent,
  type AgentMessage,
  type SessionState,
  type UiMessagePart,
} from "../types";

/** Apply one wire event to the state. */
function emit(state: SessionState, event: Record<string, unknown>): SessionState {
  return sessionReducer(state, {
    type: "agent_event",
    event: event as unknown as AgentEvent,
  });
}

/** Apply a fully-typed action. */
function dispatch(state: SessionState, action: SessionAction): SessionState {
  return sessionReducer(state, action);
}

/** Build an assistant-message partial snapshot from content blocks. */
function partial(content: unknown[]): Record<string, unknown> {
  return { role: "assistant", content };
}

function textPart(part: UiMessagePart | undefined) {
  if (!part || part.type !== "text") throw new Error("expected a text part");
  return part;
}

function toolPart(part: UiMessagePart | undefined) {
  if (!part || part.type !== "tool") throw new Error("expected a tool part");
  return part;
}

describe("sessionReducer — user prompt", () => {
  it("adds an optimistic user bubble and moves to 'starting'", () => {
    const state = dispatch(initialSessionState, {
      type: "user_prompt_submitted",
      text: "hallo",
      promptId: "p1",
    });

    expect(state.status).toBe("starting");
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.role).toBe("user");
    expect(textPart(state.messages[0]!.parts[0]).text).toBe("hallo");
    expect(state.messages[0]!.streaming).toBe(false);
    expect(state.messages[0]!.promptId).toBe("p1");
    expect(state.pendingPromptIds).toEqual(["p1"]);
  });
});

describe("sessionReducer — streaming text via partial snapshots", () => {
  it("accumulates text from the authoritative partial, not the delta", () => {
    let state = emit(initialSessionState, {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: "t0" },
    });
    expect(state.messages[0]!.streaming).toBe(true);
    expect(state.status).toBe("streaming");

    // Each delta carries the FULL accumulated text in `partial`.
    state = emit(state, {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Hel",
        partial: partial([{ type: "text", text: "Hel" }]),
      },
    });
    state = emit(state, {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "lo",
        partial: partial([{ type: "text", text: "Hello" }]),
      },
    });

    expect(textPart(state.messages[0]!.parts[0]).text).toBe("Hello");
  });
});

describe("sessionReducer — tool calls and execution merge", () => {
  it("derives tool parts from the snapshot with parsed args", () => {
    let state = emit(initialSessionState, {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: "t0" },
    });
    state = emit(state, {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "call_1", name: "search", arguments: { q: "der" } },
        partial: partial([
          { type: "toolCall", id: "call_1", name: "search", arguments: { q: "der" } },
        ]),
      },
    });

    const tool = toolPart(state.messages[0]!.parts[0]);
    expect(tool.id).toBe("call_1");
    expect(tool.name).toBe("search");
    expect(tool.args).toEqual({ q: "der" });
    expect(tool.status).toBe("pending");
  });

  it("preserves out-of-band execution status/result across later snapshots", () => {
    let state = emit(initialSessionState, {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: "t0" },
    });
    state = emit(state, {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "call_1", name: "search", arguments: { q: "der" } },
        partial: partial([
          { type: "toolCall", id: "call_1", name: "search", arguments: { q: "der" } },
        ]),
      },
    });

    // Execution result arrives out-of-band (NOT in the assistant message).
    state = emit(state, {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "search",
      result: "der: the",
      isError: false,
    });
    expect(toolPart(state.messages[0]!.parts[0]).status).toBe("done");
    expect(toolPart(state.messages[0]!.parts[0]).result).toBe("der: the");

    // A LATE assistant snapshot must not clobber the execution status/result.
    state = emit(state, {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "!",
        partial: partial([
          { type: "toolCall", id: "call_1", name: "search", arguments: { q: "der" } },
          { type: "text", text: "done!" },
        ]),
      },
    });

    const tool = toolPart(state.messages[0]!.parts[0]);
    expect(tool.status).toBe("done");
    expect(tool.result).toBe("der: the");
    expect(textPart(state.messages[0]!.parts[1]).text).toBe("done!");
  });
});

describe("sessionReducer — finalisation", () => {
  it("clears streaming on message_end while retaining tool state", () => {
    let state = emit(initialSessionState, {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: "t0" },
    });
    state = emit(state, {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
        partial: partial([
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
        ]),
      },
    });
    state = emit(state, {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "bash",
      result: "file.txt",
      isError: false,
    });
    state = emit(state, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }],
        timestamp: "t1",
      },
    });

    expect(state.messages[0]!.streaming).toBe(false);
    expect(toolPart(state.messages[0]!.parts[0]).status).toBe("done");
  });

  it("clears all streaming flags on agent_end and returns to idle", () => {
    let state = emit(initialSessionState, {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: "t0" },
    });
    state = emit(state, { type: "agent_end", messages: [], willRetry: false });

    expect(state.status).toBe("idle");
    expect(state.messages.every((m) => !m.streaming)).toBe(true);
  });
});

describe("sessionReducer — history load", () => {
  it("rebuilds messages and applies tool results from a transcript", () => {
    const history: AgentMessage[] = [
      { role: "user", content: "hi", timestamp: "t0" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } },
        ],
        timestamp: "t1",
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
        isError: false,
        timestamp: "t2",
      },
    ] as unknown as AgentMessage[];

    const state = dispatch(initialSessionState, { type: "load_history", messages: history });

    expect(state.status).toBe("idle");
    expect(state.messages).toHaveLength(2);
    expect(textPart(state.messages[0]!.parts[0]).text).toBe("hi");
    const tool = toolPart(state.messages[1]!.parts[1]);
    expect(tool.status).toBe("done");
    expect(tool.result).toBe("contents");
  });
});

describe("sessionReducer — extension UI", () => {
  it("queues a blocking request and clears it on response", () => {
    let state = emit(initialSessionState, {
      type: "extension_ui_request",
      id: "req_1",
      method: "confirm",
      title: "Proceed?",
      message: "are you sure",
    });
    expect(state.extensionRequests).toHaveLength(1);

    state = dispatch(state, { type: "extension_ui_response", requestId: "req_1" });
    expect(state.extensionRequests).toHaveLength(0);
  });

  it("stores and clears non-blocking status updates", () => {
    let state = emit(initialSessionState, {
      type: "extension_ui_request",
      id: "s1",
      method: "setStatus",
      statusKey: "game",
      statusText: "Level 1",
    });
    expect(state.extensionStatus.game).toBe("Level 1");

    state = emit(state, {
      type: "extension_ui_request",
      id: "s2",
      method: "setStatus",
      statusKey: "game",
    });
    expect(state.extensionStatus.game).toBeUndefined();
  });
});

describe("sessionReducer — stable ids & reference preservation", () => {
  it("assigns unique ids to created messages", () => {
    let state = dispatch(initialSessionState, { type: "user_prompt_submitted", text: "a", promptId: "p1" });
    state = dispatch(state, { type: "user_prompt_submitted", text: "b", promptId: "p2" });
    const ids = state.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps a streaming message's id stable across updates", () => {
    let state = emit(initialSessionState, {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: "t0" },
    });
    const id = state.messages[0]!.id;
    state = emit(state, {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "x",
        partial: partial([{ type: "text", text: "x" }]),
      },
    });
    expect(state.messages[0]!.id).toBe(id);
  });

  it("derives reload-stable ids for history", () => {
    const history: AgentMessage[] = [
      { role: "user", content: "hi", timestamp: "t0" },
      { role: "assistant", content: [{ type: "text", text: "yo" }], timestamp: "t1" },
    ] as unknown as AgentMessage[];

    const first = dispatch(initialSessionState, { type: "load_history", messages: history });
    const second = dispatch(first, { type: "load_history", messages: history });
    expect(first.messages.map((m) => m.id)).toEqual(["h0", "h1"]);
    expect(second.messages.map((m) => m.id)).toEqual(["h0", "h1"]);
  });

  it("preserves the reference of unchanged parts between snapshots", () => {
    let state = emit(initialSessionState, {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: "t0" },
    });
    state = emit(state, {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "Wor",
        partial: partial([
          { type: "text", text: "Hello" },
          { type: "text", text: "Wor" },
        ]),
      },
    });
    const firstParts = state.messages[0]!.parts;

    state = emit(state, {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "ld",
        partial: partial([
          { type: "text", text: "Hello" },
          { type: "text", text: "World" },
        ]),
      },
    });
    const secondParts = state.messages[0]!.parts;

    // The unchanged first block keeps its reference (memoized child can bail);
    // the growing block gets a fresh object.
    expect(secondParts[0]).toBe(firstParts[0]);
    expect(secondParts[1]).not.toBe(firstParts[1]);
    expect(textPart(secondParts[1]).text).toBe("World");
  });

  it("leaves other messages' references untouched when one streams", () => {
    let state = dispatch(initialSessionState, { type: "user_prompt_submitted", text: "hi", promptId: "p1" });
    state = emit(state, {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: "t0" },
    });
    const userMessage = state.messages[0]!;

    state = emit(state, {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "x",
        partial: partial([{ type: "text", text: "x" }]),
      },
    });

    expect(state.messages[0]).toBe(userMessage);
  });
});

describe("sessionReducer — optimistic prompt reconciliation", () => {
  it("reconciles the server echo against the pending correlation id, not text", () => {
    let state = dispatch(initialSessionState, {
      type: "user_prompt_submitted",
      text: "hallo",
      promptId: "p1",
    });
    expect(state.pendingPromptIds).toEqual(["p1"]);

    // The server echoes the user message; it must update the existing bubble
    // (matched by id) rather than appending a duplicate.
    state = emit(state, {
      type: "message_start",
      message: { role: "user", content: "hallo", timestamp: "t0" },
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.promptId).toBeUndefined();
    expect(state.messages[0]!.timestamp).toBe("t0");
    expect(state.pendingPromptIds).toEqual([]);
  });

  it("does not mis-dedupe two identical prompts (matches by FIFO id)", () => {
    // Two identical prompts queued before either echo arrives.
    let state = dispatch(initialSessionState, {
      type: "user_prompt_submitted",
      text: "hi",
      promptId: "p1",
    });
    state = dispatch(state, { type: "user_prompt_submitted", text: "hi", promptId: "p2" });
    expect(state.messages).toHaveLength(2);
    expect(state.pendingPromptIds).toEqual(["p1", "p2"]);

    // Echoes arrive in order; each reconciles the oldest pending bubble.
    state = emit(state, {
      type: "message_start",
      message: { role: "user", content: "hi", timestamp: "t1" },
    });
    state = emit(state, {
      type: "message_start",
      message: { role: "user", content: "hi", timestamp: "t2" },
    });

    // Still exactly two bubbles, both reconciled — no duplicate, none dropped.
    expect(state.messages).toHaveLength(2);
    expect(state.messages.every((m) => m.role === "user")).toBe(true);
    expect(state.messages.map((m) => m.promptId)).toEqual([undefined, undefined]);
    expect(state.pendingPromptIds).toEqual([]);
  });

  it("appends a user message_start that has no pending optimistic bubble", () => {
    // e.g. a message injected server-side or sent from another client.
    const state = emit(initialSessionState, {
      type: "message_start",
      message: { role: "user", content: "from elsewhere", timestamp: "t0" },
    });

    expect(state.messages).toHaveLength(1);
    expect(textPart(state.messages[0]!.parts[0]).text).toBe("from elsewhere");
  });
});

describe("sessionReducer — model settings slice", () => {
  it("stores the model catalogue and active settings", () => {
    const models = [
      {
        provider: "openai",
        id: "gpt-5",
        name: "GPT-5",
        api: "responses",
        reasoning: true,
        available: true,
        input: ["text"],
        contextWindow: 200000,
        maxTokens: 64000,
      },
    ];
    let state = dispatch(initialSessionState, {
      type: "set_models",
      models: models as SessionState["models"],
    });
    expect(state.models).toEqual(models);

    state = dispatch(state, {
      type: "set_model_settings",
      settings: {
        model: models[0]!,
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        supportsThinking: false,
        isStreaming: false,
      } as SessionState["modelSettings"] & object,
    });
    expect(state.modelSettings?.model?.id).toBe("gpt-5");
    expect(state.modelSettingsError).toBeNull();
  });

  it("tracks busy state and clears errors on a successful settings load", () => {
    let state = dispatch(initialSessionState, { type: "set_model_settings_busy", busy: true });
    expect(state.modelSettingsBusy).toBe(true);

    state = dispatch(state, { type: "set_model_settings_error", error: "nope" });
    expect(state.modelSettingsError).toBe("nope");

    state = dispatch(state, {
      type: "set_model_settings",
      settings: {
        model: null,
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        supportsThinking: false,
        isStreaming: false,
      },
    });
    expect(state.modelSettingsError).toBeNull();

    state = dispatch(state, { type: "set_model_settings_busy", busy: false });
    expect(state.modelSettingsBusy).toBe(false);
  });
});

describe("sessionReducer — referential stability", () => {
  it("returns the same state object for ignored events", () => {
    const state = dispatch(initialSessionState, {
      type: "user_prompt_submitted",
      text: "x",
      promptId: "p1",
    });
    const next = emit(state, { type: "turn_start" });
    expect(next).toBe(state);
  });
});
