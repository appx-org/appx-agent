import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { THINKING_LEVELS, clampThinkingLevelForModel, supportedThinkingLevelsForModel, type ThinkingLevel } from "../src/thinking.js";

const reasoningModel = {
  reasoning: true as const,
  thinkingLevelMap: { off: "none", low: "low", medium: "medium", high: "high" } as Record<string, string | null | undefined>,
};

const nonReasoningModel = {
  reasoning: false as const,
  thinkingLevelMap: undefined,
};

describe("thinking helpers", () => {
  test("THINKING_LEVELS includes off and xhigh in canonical order", () => {
    assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh"] satisfies ThinkingLevel[]);
  });

  test("non-reasoning models support only off", () => {
    assert.deepEqual(supportedThinkingLevelsForModel(nonReasoningModel), ["off"]);
  });

  test("supported levels exclude null entries and require explicit xhigh", () => {
    const supported = supportedThinkingLevelsForModel(reasoningModel);
    assert.ok(supported.includes("low"));
    assert.ok(supported.includes("high"));
    assert.ok(!supported.includes("xhigh"), "xhigh requires an explicit map entry");
  });

  test("clamp picks the next-higher level when requested level is unsupported", () => {
    const minimalNullModel = {
      reasoning: true as const,
      thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high" } as Record<string, string | null | undefined>,
    };
    assert.equal(clampThinkingLevelForModel(minimalNullModel, "minimal"), "low");
  });

  test("clamp falls back to the lowest supported level when requested is too high", () => {
    const onlyOff = { reasoning: false as const, thinkingLevelMap: undefined };
    assert.equal(clampThinkingLevelForModel(onlyOff, "high"), "off");
  });
});
