/**
 * Tests for the reducer's raw-transcript accumulation (`state.rawMessages`),
 * which usage aggregation folds over. The reducer only stores the wire messages
 * here — cost/context math lives in `aggregateSessionUsage` (see usage.test.ts).
 */
import { describe, it, expect } from "vitest";
import { sessionReducer, type SessionAction } from "../reducer";
import { initialSessionState, type AgentEvent, type SessionState } from "../types";

function emit(state: SessionState, event: Record<string, unknown>): SessionState {
  return sessionReducer(state, { type: "agent_event", event: event as unknown as AgentEvent });
}

function dispatch(state: SessionState, action: SessionAction): SessionState {
  return sessionReducer(state, action);
}

const assistantEnd = (usageTotal: number, stopReason = "stop") => ({
  type: "message_end",
  message: {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "litellm",
    model: "openai/gpt-5.5",
    stopReason,
    timestamp: 1,
    usage: {
      input: usageTotal,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usageTotal,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  },
});

describe("sessionReducer — raw transcript accumulation", () => {
  it("starts empty", () => {
    expect(initialSessionState.rawMessages).toEqual([]);
  });

  it("seeds rawMessages from a full history load and replaces prior contents", () => {
    let state = emit(initialSessionState, assistantEnd(10));
    expect(state.rawMessages).toHaveLength(1);

    const history = [
      { role: "user", content: "hi", timestamp: 1 },
      { role: "assistant", content: [], provider: "p", model: "m", stopReason: "stop", timestamp: 2 },
    ];
    state = dispatch(state, { type: "load_history", messages: history as never });

    // A full reload is authoritative, so it replaces the accumulated tail.
    expect(state.rawMessages).toHaveLength(2);
    expect(state.rawMessages).toEqual(history);
  });

  it("appends finalised assistant messages on message_end", () => {
    let state = emit(initialSessionState, assistantEnd(10));
    state = emit(state, assistantEnd(20, "aborted"));

    expect(state.rawMessages).toHaveLength(2);
    expect(state.rawMessages[0]!.role).toBe("assistant");
    expect(state.rawMessages[1]!.role).toBe("assistant");
  });

  it("records a synthetic compactionSummary when a compaction completes", () => {
    let state = emit(initialSessionState, assistantEnd(90));
    state = emit(state, {
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      result: { summary: "compacted", firstKeptEntryId: "e1", tokensBefore: 90 },
    });

    expect(state.rawMessages).toHaveLength(2);
    const summary = state.rawMessages[1]!;
    expect(summary.role).toBe("compactionSummary");
    expect((summary as { tokensBefore?: number }).tokensBefore).toBe(90);
  });

  it("ignores an aborted compaction", () => {
    const state = emit(initialSessionState, {
      type: "compaction_end",
      reason: "manual",
      aborted: true,
      willRetry: false,
    });
    expect(state.rawMessages).toEqual([]);
  });

  it("clears rawMessages on reset", () => {
    let state = emit(initialSessionState, assistantEnd(10));
    state = dispatch(state, { type: "reset" });
    expect(state.rawMessages).toEqual([]);
  });
});
