/**
 * Per-session usage/cost aggregation.
 *
 * A pure fold over the transcript returned by `getSessionMessages` (or kept
 * up to date from `message_end` wire events): token totals, monetary cost,
 * cache-hit rate and context-window utilization.
 *
 * Cost normally comes straight off the wire (`AssistantMessage.usage.cost`),
 * but custom LiteLLM-routed models often report zero cost. Consumers can pass
 * per-million-token `costRates` to recalculate in that case; the wire cost
 * wins whenever it is non-zero.
 */
import type { AgentMessage } from "./types";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type WireUsage = AssistantMessage["usage"];

export type UsageTokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type UsageCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

/** USD per million tokens, used to recalculate cost when the wire reports zero. */
export type UsageCostRates = Omit<UsageCost, "total">;

export type ContextUsage = {
  /** Estimated tokens currently in the context window; null when unknown. */
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  remainingTokens: number | null;
  remainingPercent: number | null;
};

export type SessionUsageMetrics = {
  /** `provider/model` of the latest assistant turn; null before the first one. */
  modelRef: string | null;
  tokens: UsageTokens;
  cost: UsageCost;
  context: ContextUsage;
  cacheHitPercent: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
};

export type AggregateSessionUsageOptions = {
  contextWindow?: number;
  costRates?: UsageCostRates;
};

const emptyTokens: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const emptyCost: UsageCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

export function emptySessionUsageMetrics(contextWindow = 0): SessionUsageMetrics {
  return {
    modelRef: null,
    tokens: { ...emptyTokens },
    cost: { ...emptyCost },
    context: {
      tokens: 0,
      contextWindow,
      percent: 0,
      remainingTokens: contextWindow,
      remainingPercent: 100,
    },
    cacheHitPercent: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
  };
}

function hasCost(cost: UsageCost): boolean {
  return (
    cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0 || cost.total > 0
  );
}

function costFromRates(tokens: UsageTokens, rates: UsageCostRates | undefined): UsageCost {
  if (!rates) return { ...emptyCost };

  const input = (tokens.input / 1_000_000) * rates.input;
  const output = (tokens.output / 1_000_000) * rates.output;
  const cacheRead = (tokens.cacheRead / 1_000_000) * rates.cacheRead;
  const cacheWrite = (tokens.cacheWrite / 1_000_000) * rates.cacheWrite;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function contextTokens(usage: WireUsage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** A finished turn whose usage reflects the real context size. */
function isCleanAssistantTurn(message: AssistantMessage): boolean {
  return message.stopReason !== "aborted" && message.stopReason !== "error";
}

function contentCharCount(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;

  return content.reduce<number>((total, block) => {
    if (!block || typeof block !== "object") return total;
    const item = block as Record<string, unknown>;
    if (typeof item.text === "string") return total + item.text.length;
    if (typeof item.thinking === "string") return total + item.thinking.length;
    if (item.type === "image") return total + 4_800;
    if (typeof item.arguments === "string") return total + item.arguments.length;
    if (item.arguments && typeof item.arguments === "object") {
      return total + JSON.stringify(item.arguments).length;
    }
    return total;
  }, 0);
}

function estimateTokens(message: AgentMessage): number {
  const content = "content" in message ? message.content : undefined;
  return Math.ceil(contentCharCount(content) / 4);
}

function lastCleanAssistantIndex(messages: AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && isCleanAssistantTurn(message)) return index;
  }
  return -1;
}

function lastCompactionIndex(messages: AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "compactionSummary") return index;
  }
  return -1;
}

function unknownContext(contextWindow: number): ContextUsage {
  return {
    tokens: null,
    contextWindow,
    percent: null,
    remainingTokens: null,
    remainingPercent: null,
  };
}

function contextUsage(messages: AgentMessage[], contextWindow: number): ContextUsage {
  if (contextWindow <= 0) return unknownContext(0);

  const anchorIndex = lastCleanAssistantIndex(messages);
  // After a compaction the next assistant turn re-measures the window; until
  // then any previous usage overstates it, so report the context as unknown.
  if (lastCompactionIndex(messages) > anchorIndex) return unknownContext(contextWindow);

  const anchor = anchorIndex >= 0 ? (messages[anchorIndex] as AssistantMessage) : undefined;
  const trailing = messages.slice(anchorIndex + 1);
  const tokens =
    (anchor ? contextTokens(anchor.usage) : 0) +
    trailing.reduce((total, message) => total + estimateTokens(message), 0);
  const percent = (tokens / contextWindow) * 100;

  return {
    tokens,
    contextWindow,
    percent,
    remainingTokens: Math.max(0, contextWindow - tokens),
    remainingPercent: Math.max(0, 100 - percent),
  };
}

export function aggregateSessionUsage(
  messages: AgentMessage[],
  options: AggregateSessionUsageOptions = {},
): SessionUsageMetrics {
  const contextWindow = options.contextWindow ?? 0;
  const tokens = { ...emptyTokens };
  const cost = { ...emptyCost };
  let modelRef: string | null = null;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;

  for (const message of messages) {
    if (message.role === "user") userMessages += 1;
    if (message.role === "toolResult") toolResults += 1;
    if (message.role !== "assistant") continue;

    assistantMessages += 1;
    modelRef = `${message.provider}/${message.model}`;
    toolCalls += message.content.filter((block) => block.type === "toolCall").length;

    const { usage } = message;
    tokens.input += usage.input;
    tokens.output += usage.output;
    tokens.cacheRead += usage.cacheRead;
    tokens.cacheWrite += usage.cacheWrite;
    cost.input += usage.cost.input;
    cost.output += usage.cost.output;
    cost.cacheRead += usage.cost.cacheRead;
    cost.cacheWrite += usage.cost.cacheWrite;
    cost.total += usage.cost.total;
  }

  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  const promptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite;

  return {
    modelRef,
    tokens,
    cost: hasCost(cost) ? cost : costFromRates(tokens, options.costRates),
    context: contextUsage(messages, contextWindow),
    cacheHitPercent: promptTokens > 0 ? (tokens.cacheRead / promptTokens) * 100 : 0,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
  };
}
