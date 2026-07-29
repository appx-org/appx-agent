// @vitest-environment jsdom
/**
 * Rendering tests for the presentational `UsageBar`. It's a pure function of the
 * `SessionUsageMetrics` it receives, so we feed it fixtures and assert the
 * formatted output (cost precision, cache %, and the unknown-context em dash).
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { UsageBar } from "../UsageBar";
import { emptySessionUsageMetrics, type SessionUsageMetrics } from "../../core/usage";

afterEach(cleanup);

function metrics(overrides: Partial<SessionUsageMetrics> = {}): SessionUsageMetrics {
  return { ...emptySessionUsageMetrics(128_000), ...overrides };
}

describe("UsageBar", () => {
  it("renders cost, cache-hit and context values", () => {
    const { container } = render(
      <UsageBar
        metrics={metrics({
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
          cacheHitPercent: 88,
          context: {
            tokens: 12_800,
            contextWindow: 128_000,
            percent: 10,
            remainingTokens: 115_200,
            remainingPercent: 90,
          },
        })}
      />,
    );

    const values = Array.from(container.querySelectorAll(".agent-chat-usage-value")).map(
      (node) => node.textContent,
    );
    expect(values).toEqual(["$0.012", "88%", "10%"]);
  });

  it("shows an em dash when the context size is unknown (post-compaction)", () => {
    const { container } = render(
      <UsageBar
        metrics={metrics({
          context: {
            tokens: null,
            contextWindow: 128_000,
            percent: null,
            remainingTokens: null,
            remainingPercent: null,
          },
        })}
      />,
    );

    const values = Array.from(container.querySelectorAll(".agent-chat-usage-value")).map(
      (node) => node.textContent,
    );
    expect(values[2]).toBe("—");
  });

  it("honours custom labels", () => {
    const { container } = render(
      <UsageBar
        metrics={metrics()}
        labels={{ cost: "Kosten", cache: "Cache", context: "Kontext" }}
      />,
    );
    const labels = Array.from(container.querySelectorAll(".agent-chat-usage-label")).map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(["Kosten", "Cache", "Kontext"]);
  });
});
