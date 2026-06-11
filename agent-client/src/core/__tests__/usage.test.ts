import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../types";
import {
  aggregateSessionUsage,
  emptySessionUsageMetrics,
  type UsageCostRates,
} from "../usage";

type AssistantOverrides = {
  usage?: Partial<NonNullable<Extract<AgentMessage, { role: "assistant" }>["usage"]>>;
  cost?: Partial<Extract<AgentMessage, { role: "assistant" }>["usage"]["cost"]>;
  stopReason?: Extract<AgentMessage, { role: "assistant" }>["stopReason"];
  content?: Extract<AgentMessage, { role: "assistant" }>["content"];
  provider?: string;
  model?: string;
};

function assistant(overrides: AssistantOverrides = {}): AgentMessage {
  return {
    role: "assistant",
    content: overrides.content ?? [],
    api: "openai-completions",
    provider: overrides.provider ?? "litellm",
    model: overrides.model ?? "openai/gpt-5.5",
    stopReason: overrides.stopReason ?? "stop",
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      ...overrides.usage,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        ...overrides.cost,
      },
    },
  };
}

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 1 };
}

function toolResult(text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  };
}

const gpt55Rates: UsageCostRates = {
  input: 1.25,
  output: 10,
  cacheRead: 0.125,
  cacheWrite: 0,
};

describe("emptySessionUsageMetrics", () => {
  it("returns zeroed metrics with a full context window", () => {
    const metrics = emptySessionUsageMetrics(128_000);

    expect(metrics.tokens).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    });
    expect(metrics.cost.total).toBe(0);
    expect(metrics.context).toEqual({
      tokens: 0,
      contextWindow: 128_000,
      percent: 0,
      remainingTokens: 128_000,
      remainingPercent: 100,
    });
    expect(metrics.cacheHitPercent).toBe(0);
    expect(metrics.modelRef).toBeNull();
  });
});

describe("aggregateSessionUsage", () => {
  it("returns empty metrics for an empty history", () => {
    const metrics = aggregateSessionUsage([], { contextWindow: 128_000 });

    expect(metrics.tokens.total).toBe(0);
    expect(metrics.context.contextWindow).toBe(128_000);
    expect(metrics.cacheHitPercent).toBe(0);
  });

  it("aggregates tokens, cost and message counts from assistant messages", () => {
    const messages: AgentMessage[] = [
      user("Build a dashboard"),
      assistant({
        content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
        usage: { input: 100, output: 40, cacheRead: 900, cacheWrite: 20, totalTokens: 1060 },
        cost: { input: 0.0001, output: 0.0004, cacheRead: 0.00009, cacheWrite: 0, total: 0.00059 },
      }),
      toolResult("file contents"),
    ];

    const metrics = aggregateSessionUsage(messages, { contextWindow: 128_000 });

    expect(metrics.tokens).toEqual({
      input: 100,
      output: 40,
      cacheRead: 900,
      cacheWrite: 20,
      total: 1060,
    });
    expect(metrics.cost.total).toBeCloseTo(0.00059);
    expect(metrics.cacheHitPercent).toBeCloseTo((900 / 1020) * 100);
    expect(metrics.userMessages).toBe(1);
    expect(metrics.assistantMessages).toBe(1);
    expect(metrics.toolCalls).toBe(1);
    expect(metrics.toolResults).toBe(1);
    expect(metrics.context.tokens).toBeGreaterThan(1060);
    expect(metrics.context.remainingPercent).toBeLessThan(100);
  });

  it("recalculates cost from rates when the wire cost is zero", () => {
    const messages: AgentMessage[] = [
      assistant({
        usage: { input: 1_000_000, output: 100_000, cacheRead: 500_000, totalTokens: 1_600_000 },
      }),
    ];

    const metrics = aggregateSessionUsage(messages, {
      contextWindow: 2_000_000,
      costRates: gpt55Rates,
    });

    expect(metrics.cost.input).toBeCloseTo(1.25);
    expect(metrics.cost.output).toBeCloseTo(1);
    expect(metrics.cost.cacheRead).toBeCloseTo(0.0625);
    expect(metrics.cost.total).toBeCloseTo(2.3125);
  });

  it("prefers the wire cost over rates when it is non-zero", () => {
    const messages: AgentMessage[] = [
      assistant({
        usage: { input: 1_000_000, totalTokens: 1_000_000 },
        cost: { input: 0.5, total: 0.5 },
      }),
    ];

    const metrics = aggregateSessionUsage(messages, { costRates: gpt55Rates });

    expect(metrics.cost.total).toBeCloseTo(0.5);
  });

  it("derives context from the last assistant usage plus trailing message estimates", () => {
    const messages: AgentMessage[] = [
      user("root"),
      assistant({ usage: { input: 10, output: 5, totalTokens: 15 } }),
      assistant({ usage: { input: 20, output: 10, totalTokens: 30 } }),
    ];

    const metrics = aggregateSessionUsage(messages, { contextWindow: 100 });

    expect(metrics.context.tokens).toBe(30);
    expect(metrics.context.percent).toBe(30);
    expect(metrics.context.remainingTokens).toBe(70);
    expect(metrics.context.remainingPercent).toBe(70);
  });

  it("estimates trailing messages that follow the last assistant usage", () => {
    const messages: AgentMessage[] = [
      assistant({ usage: { input: 10, output: 5, totalTokens: 15 } }),
      user("x".repeat(400)),
    ];

    const metrics = aggregateSessionUsage(messages, { contextWindow: 1_000 });

    expect(metrics.context.tokens).toBe(15 + 100);
  });

  it("ignores aborted and errored assistant messages for the context anchor", () => {
    const messages: AgentMessage[] = [
      assistant({ usage: { input: 10, output: 5, totalTokens: 15 } }),
      assistant({ usage: { input: 90, output: 5, totalTokens: 95 }, stopReason: "aborted" }),
    ];

    const metrics = aggregateSessionUsage(messages, { contextWindow: 100 });

    // Spend still counts both turns; context anchors on the last clean turn.
    expect(metrics.tokens.total).toBe(110);
    expect(metrics.context.tokens).toBe(15);
  });

  it("marks context as unknown after compaction until the next assistant usage", () => {
    const messages: AgentMessage[] = [
      user("old"),
      assistant({ usage: { input: 80, output: 10, totalTokens: 90 } }),
      { role: "compactionSummary", summary: "compacted", tokensBefore: 90, timestamp: 2 },
      user("after"),
    ];

    const metrics = aggregateSessionUsage(messages, { contextWindow: 100 });

    expect(metrics.context.tokens).toBeNull();
    expect(metrics.context.percent).toBeNull();
  });

  it("restores context once an assistant turn lands after compaction", () => {
    const messages: AgentMessage[] = [
      assistant({ usage: { input: 80, output: 10, totalTokens: 90 } }),
      { role: "compactionSummary", summary: "compacted", tokensBefore: 90, timestamp: 2 },
      assistant({ usage: { input: 20, output: 5, totalTokens: 25 } }),
    ];

    const metrics = aggregateSessionUsage(messages, { contextWindow: 100 });

    expect(metrics.context.tokens).toBe(25);
  });

  it("reports an unknown context when no window is provided", () => {
    const metrics = aggregateSessionUsage([assistant({ usage: { input: 10, totalTokens: 10 } })]);

    expect(metrics.context).toEqual({
      tokens: null,
      contextWindow: 0,
      percent: null,
      remainingTokens: null,
      remainingPercent: null,
    });
  });

  it("takes the model ref from the latest assistant message", () => {
    const messages: AgentMessage[] = [
      assistant({ provider: "litellm", model: "openai/gpt-5.5" }),
      assistant({ provider: "codex-proxy", model: "openai/gpt-5.5" }),
    ];

    expect(aggregateSessionUsage(messages).modelRef).toBe("codex-proxy/openai/gpt-5.5");
  });
});
