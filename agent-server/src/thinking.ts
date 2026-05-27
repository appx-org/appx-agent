/**
 * Thin wrapper over Pi's thinking-level helpers.
 *
 * Pi owns the canonical clamp + supported-levels logic in
 * `@earendil-works/pi-ai/models.ts`. We re-export them under
 * agent-server-friendly names and a `Pick`-style type so callers can
 * pass either a real Pi `Model` or a partial { reasoning, thinkingLevelMap }
 * shape (used by litellm config validation).
 */
import {
	type Api,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
} from "@earendil-works/pi-ai";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

type ThinkingLevelInput = Pick<Model<Api>, "reasoning" | "thinkingLevelMap">;

export function supportedThinkingLevelsForModel(model: ThinkingLevelInput): ThinkingLevel[] {
	return getSupportedThinkingLevels(model as Model<Api>) as ThinkingLevel[];
}

export function clampThinkingLevelForModel(model: ThinkingLevelInput, level: ThinkingLevel): ThinkingLevel {
	return clampThinkingLevel(model as Model<Api>, level) as ThinkingLevel;
}
