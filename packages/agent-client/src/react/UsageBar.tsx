import { memo } from "react";
import type { SessionUsageMetrics } from "../core/usage";

export interface UsageBarLabels {
  cost?: string;
  cache?: string;
  context?: string;
}

export interface UsageBarProps {
  /** Aggregated metrics from `aggregateSessionUsage`. */
  metrics: SessionUsageMetrics;
  labels?: UsageBarLabels;
  className?: string;
}

/** Format a USD amount with enough precision for sub-cent per-session spend. */
function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

/** Round a percentage; render an em dash when the value is unknown (null). */
function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${Math.round(value)}%`;
}

/** Compact token count (1_234 → "1.2k", 3_400_000 → "3.4M"). */
function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/**
 * Compact per-session usage readout: monetary cost, cache-hit rate and
 * context-window utilization. Purely presentational — feed it the output of
 * `aggregateSessionUsage`. Memoized so it only re-renders when metrics change.
 */
export const UsageBar = memo(function UsageBar({ metrics, labels, className }: UsageBarProps) {
  const { tokens, cost, cacheHitPercent, context } = metrics;
  const costLabel = labels?.cost ?? "cost";
  const cacheLabel = labels?.cache ?? "cache";
  const contextLabel = labels?.context ?? "ctx";

  const costTitle = `input ${formatUsd(cost.input)} · output ${formatUsd(
    cost.output,
  )} · cache-read ${formatUsd(cost.cacheRead)} · cache-write ${formatUsd(cost.cacheWrite)}`;
  const cacheTitle = `cache-read ${formatTokens(tokens.cacheRead)} of ${formatTokens(
    tokens.input + tokens.cacheRead + tokens.cacheWrite,
  )} prompt tokens`;
  const contextTitle =
    context.tokens === null
      ? "Context size unknown until the next assistant turn"
      : `${formatTokens(context.tokens)} / ${formatTokens(context.contextWindow)} tokens`;

  return (
    <div
      className={["agent-chat-usage", className].filter(Boolean).join(" ")}
      aria-label="Session usage"
    >
      <span className="agent-chat-usage-item" title={costTitle}>
        <span className="agent-chat-usage-label">{costLabel}</span>
        <span className="agent-chat-usage-value">{formatUsd(cost.total)}</span>
      </span>
      <span className="agent-chat-usage-item" title={cacheTitle}>
        <span className="agent-chat-usage-label">{cacheLabel}</span>
        <span className="agent-chat-usage-value">{formatPercent(cacheHitPercent)}</span>
      </span>
      <span className="agent-chat-usage-item" title={contextTitle}>
        <span className="agent-chat-usage-label">{contextLabel}</span>
        <span className="agent-chat-usage-value">{formatPercent(context.percent)}</span>
      </span>
    </div>
  );
});
