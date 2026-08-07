/**
 * LiteLLM runtime wiring for the embedded Pi SDK.
 *
 * SDK session model selection happens before extension session_start handlers,
 * so dynamic provider registration has to happen directly on ProjectRuntime's
 * ModelRegistry before createAgentSession().
 *
 * ## Configuration
 *
 * The model list comes from ONE place: a JSON file named by
 * `LITELLM_MODELS_PATH`, containing an array of model entries. Everything else
 * is a scalar: `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `LITELLM_API` and
 * `LITELLM_DEFAULT_MODEL`.
 *
 * A file rather than an env var because the list is structured, per-model
 * config that a control plane generates from its own model catalogue — it wants
 * to be diffable and reviewable, not a multi-kilobyte single-line env value.
 *
 * `modelPreset()` supplies thinking metadata (`thinkingLevelMap`,
 * `defaultThinkingLevel`, `compat.thinkingFormat`) for models whose dialect we
 * know; file entries override it field by field.
 */
import { readFileSync } from "node:fs";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ProjectRuntimeConfig } from "../runtime/projectRuntime.js";
import {
	clampThinkingLevelForModel,
	THINKING_LEVELS as SHARED_THINKING_LEVELS,
	supportedThinkingLevelsForModel,
	type ThinkingLevel,
} from "../shared/thinking.js";

type ProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages";

type LiteLlmModel = {
	id: string;
	name?: string;
	baseUrl?: string;
	api?: ProviderApi;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
	/** Session thinking default to use when this model is the selected default. */
	defaultThinkingLevel?: ThinkingLevel;
	input?: Array<"text" | "image">;
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	/** Model-level OpenAI-compatible provider quirks. Overrides the conservative defaults. */
	compat?: Record<string, unknown>;
};

type ProviderConfig = Parameters<ModelRegistry["registerProvider"]>[1];
type ProviderModel = NonNullable<ProviderConfig["models"]>[number];

type ResolvedLiteLlmConfig = {
	baseUrl: string;
	providerApi: ProviderApi;
	providerCompat: Record<string, unknown>;
	models: ProviderModel[];
	defaultModelId: string;
	defaultModel: ProviderModel;
	/** Effective thinking level for the selected default model. */
	thinkingLevel: ThinkingLevel | undefined;
	/** Per-model defaults keyed as `${provider}/${modelId}` for ProjectRuntime. */
	modelThinkingDefaults: Record<string, ThinkingLevel>;
};

type NormalisedLiteLlmModel = {
	model: ProviderModel;
	defaultThinkingLevel?: ThinkingLevel;
};

const LOG_PREFIX = "[agent-server-litellm]";
const apiValues = new Set<ProviderApi>(["openai-completions", "openai-responses", "anthropic-messages"]);
const thinkingValues = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const conservativeOpenAiCompat = {
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: false,
	maxTokensField: "max_tokens",
};

const gpt55ThinkingLevelMap: Partial<Record<ThinkingLevel, string | null>> = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
};

const deepSeekV4ThinkingLevelMap: Partial<Record<ThinkingLevel, string | null>> = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: "max",
};

let cachedConfig: ResolvedLiteLlmConfig | null | undefined;
let startupConfigLogged = false;

function parseApi(raw: string | undefined, fallback: ProviderApi): ProviderApi {
	const value = raw?.trim();
	if (!value) return fallback;
	if (apiValues.has(value as ProviderApi)) return value as ProviderApi;
	console.warn(`${LOG_PREFIX} unsupported API ${value}; using ${fallback}`);
	return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function modelPreset(id: string): Partial<LiteLlmModel> {
	if (id === "openai/gpt-5.5") {
		return {
			name: "GPT 5.5 (Codex)",
			api: "openai-responses",
			reasoning: true,
			thinkingLevelMap: gpt55ThinkingLevelMap,
			defaultThinkingLevel: "xhigh",
			compat: {
				thinkingFormat: "openai",
				supportsReasoningEffort: true,
				maxTokensField: "max_output_tokens",
				supportsPromptCacheKey: true,
				promptCacheRetention: "24h",
			},
		};
	}
	if (id === "deepseek/deepseek-v4-pro" || id === "deepseek/deepseek-v4-flash") {
		return {
			api: "openai-completions",
			reasoning: true,
			thinkingLevelMap: deepSeekV4ThinkingLevelMap,
			defaultThinkingLevel: "high",
			compat: {
				thinkingFormat: "deepseek",
				maxTokensField: "max_tokens",
			},
		};
	}
	return {};
}

function parseThinkingLevelValue(raw: unknown, name: string, warnOnly = false): ThinkingLevel | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "string") {
		const message = `${LOG_PREFIX} ${name} must be a string`;
		if (warnOnly) {
			console.warn(`${message}; Pi default will be used`);
			return undefined;
		}
		throw new Error(`${name} must be one of ${SHARED_THINKING_LEVELS.join(", ")}`);
	}
	const value = raw.trim();
	if (!value) return undefined;
	if (thinkingValues.has(value as ThinkingLevel)) return value as ThinkingLevel;
	const message = `${LOG_PREFIX} unsupported ${name} ${value}`;
	if (warnOnly) {
		console.warn(`${message}; Pi default will be used`);
		return undefined;
	}
	throw new Error(`${name} must be one of ${SHARED_THINKING_LEVELS.join(", ")}`);
}

function modelKey(modelId: string): string {
	return `litellm/${modelId}`;
}

/**
 * Baseline for a model entry: the values used for any field the file (and then
 * the preset) leaves unset. Costs default to zero, so a consumer that wants a
 * meaningful in-UI spend estimate has to supply real figures per model.
 */
function modelBaseline(id: string): LiteLlmModel {
	return {
		id,
		name: id,
		input: ["text"],
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function modelCompat(
	model: LiteLlmModel,
	providerCompat: Record<string, unknown>,
	presetCompat: Record<string, unknown> | undefined,
): Record<string, unknown> {
	if (model.compat !== undefined && !isRecord(model.compat)) {
		throw new Error(`LiteLLM model ${model.id || "<unknown>"} compat must be a JSON object`);
	}
	return { ...providerCompat, ...(presetCompat ?? {}), ...(model.compat ?? {}) };
}

function normaliseThinkingLevelMap(
	modelId: string,
	map: LiteLlmModel["thinkingLevelMap"],
): LiteLlmModel["thinkingLevelMap"] {
	if (map === undefined) return undefined;
	if (!isRecord(map)) throw new Error(`LiteLLM model ${modelId} thinkingLevelMap must be a JSON object`);
	const result: Partial<Record<ThinkingLevel, string | null>> = {};
	for (const [key, value] of Object.entries(map)) {
		if (!thinkingValues.has(key as ThinkingLevel)) {
			throw new Error(`LiteLLM model ${modelId} has unsupported thinkingLevelMap key ${key}`);
		}
		if (value !== null && typeof value !== "string") {
			throw new Error(`LiteLLM model ${modelId} thinkingLevelMap.${key} must be a string or null`);
		}
		result[key as ThinkingLevel] = value;
	}
	return result;
}

function mergeThinkingLevelMaps(
	modelId: string,
	presetMap: LiteLlmModel["thinkingLevelMap"],
	modelMap: LiteLlmModel["thinkingLevelMap"],
): LiteLlmModel["thinkingLevelMap"] {
	const normalisedPreset = normaliseThinkingLevelMap(modelId, presetMap);
	const normalisedModel = normaliseThinkingLevelMap(modelId, modelMap);
	if (!normalisedPreset && !normalisedModel) return undefined;
	return { ...(normalisedPreset ?? {}), ...(normalisedModel ?? {}) };
}

function normaliseModel(model: LiteLlmModel, providerCompat: Record<string, unknown>): NormalisedLiteLlmModel {
	if (!isRecord(model)) throw new Error("LiteLLM model entries must be JSON objects");
	if (!model.id?.trim()) throw new Error("LiteLLM model entry is missing id");
	const id = model.id.trim();
	const base = modelBaseline(id);
	const preset = modelPreset(id);
	const fallbackApi = parseApi(process.env.LITELLM_API, "openai-completions");
	const { defaultThinkingLevel: presetDefaultThinkingLevel, ...presetForProvider } = preset;
	const { defaultThinkingLevel: modelDefaultThinkingLevel, ...modelForProvider } = model;
	const thinkingLevelMap = mergeThinkingLevelMaps(id, preset.thinkingLevelMap, model.thinkingLevelMap);
	const defaultThinkingLevel = modelDefaultThinkingLevel ?? presetDefaultThinkingLevel;
	const providerModel: ProviderModel = {
		...base,
		...presetForProvider,
		...modelForProvider,
		id,
		name: model.name ?? preset.name ?? id,
		api: model.api ? parseApi(model.api, fallbackApi) : (preset.api ?? fallbackApi),
		reasoning: model.reasoning ?? preset.reasoning ?? false,
		thinkingLevelMap,
		input: model.input ?? preset.input ?? base.input!,
		contextWindow: model.contextWindow ?? preset.contextWindow ?? base.contextWindow!,
		maxTokens: model.maxTokens ?? preset.maxTokens ?? base.maxTokens!,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			...(preset.cost ?? {}),
			...(model.cost ?? {}),
		},
		compat: modelCompat(model, providerCompat, preset.compat),
	};
	return {
		model: providerModel,
		defaultThinkingLevel: defaultThinkingLevel
			? clampThinkingLevelForModel(
					providerModel,
					parseThinkingLevelValue(defaultThinkingLevel, `LiteLLM model ${id} defaultThinkingLevel`)!,
				)
			: undefined,
	};
}

/**
 * Env vars removed in 0.2.0. They are rejected rather than ignored: a stale
 * value would otherwise leave the provider silently unregistered, which reads
 * as "the agent has no models" with nothing pointing at the cause.
 */
const REMOVED_ENV_VARS: ReadonlyArray<[string, string]> = [
	["LITELLM_MODELS_JSON", "write the same JSON array to a file and set LITELLM_MODELS_PATH"],
	["LITELLM_MODELS", "list the models in the LITELLM_MODELS_PATH file"],
	["LITELLM_CONTEXT_WINDOW", "set contextWindow per model in the LITELLM_MODELS_PATH file"],
	["LITELLM_MAX_TOKENS", "set maxTokens per model in the LITELLM_MODELS_PATH file"],
	["LITELLM_REASONING", "set reasoning per model in the LITELLM_MODELS_PATH file"],
	["LITELLM_COMPAT_JSON", "set compat per model in the LITELLM_MODELS_PATH file"],
	["LITELLM_DEFAULT_THINKING", "set defaultThinkingLevel on the default model entry"],
];

function assertNoRemovedEnvVars(): void {
	const present = REMOVED_ENV_VARS.filter(([name]) => process.env[name]?.trim());
	if (present.length === 0) return;
	const detail = present.map(([name, hint]) => `${name} (${hint})`).join("; ");
	throw new Error(
		`${LOG_PREFIX} these environment variables were removed in agent-server 0.2.0: ${detail}. ` +
			`The model list now comes only from the JSON file named by LITELLM_MODELS_PATH.`,
	);
}

/**
 * Read the model list from `LITELLM_MODELS_PATH`.
 *
 * Returns an empty list when the variable is unset, so a deployment that has
 * not configured models yet registers no provider (the caller warns). A path
 * that IS set but unreadable or malformed throws: that is a misconfiguration,
 * and failing loudly at boot beats an agent that silently has no models.
 */
function parseModels(providerCompat: Record<string, unknown>): NormalisedLiteLlmModel[] {
	assertNoRemovedEnvVars();

	const path = process.env.LITELLM_MODELS_PATH?.trim();
	if (!path) return [];

	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`LITELLM_MODELS_PATH ${path} could not be read: ${reason}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(contents) as unknown;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`LITELLM_MODELS_PATH ${path} is not valid JSON: ${reason}`);
	}
	if (!Array.isArray(parsed)) {
		throw new Error(`LITELLM_MODELS_PATH ${path} must contain a JSON array of model entries`);
	}
	return parsed.map((entry) => normaliseModel(entry as LiteLlmModel, providerCompat));
}

function resolvedEffort(model: ProviderModel, thinkingLevel: ThinkingLevel): string {
	const mapped = model.thinkingLevelMap?.[thinkingLevel];
	if (mapped === null) return `${thinkingLevel}(unsupported)`;
	return mapped ?? thinkingLevel;
}

export function litellmRequestHint(model: ProviderModel, thinkingLevel: ThinkingLevel | undefined): string {
	if (!model.reasoning) return "reasoning=disabled";

	const compat = (model.compat ?? {}) as Record<string, unknown>;
	const format = compat.thinkingFormat;
	const thinkingEnabled = Boolean(thinkingLevel && thinkingLevel !== "off");
	const effort = thinkingEnabled ? resolvedEffort(model, thinkingLevel!) : undefined;

	if (model.api === "openai-responses") {
		return thinkingEnabled
			? `reasoning.effort=${effort}`
			: `reasoning.effort=${String(model.thinkingLevelMap?.off ?? "none")}`;
	}
	if (model.api !== "openai-completions") return "api-specific";
	if (format === "deepseek") {
		return thinkingEnabled ? `thinking.type=enabled,reasoning_effort=${effort}` : "thinking.type=disabled";
	}
	if (format === "openrouter") {
		return thinkingEnabled ? `reasoning.effort=${effort}` : "reasoning.effort=none";
	}
	if (format === "together") {
		return thinkingEnabled
			? compat.supportsReasoningEffort === false
				? "reasoning.enabled=true"
				: `reasoning.enabled=true,reasoning_effort=${effort}`
			: "reasoning.enabled=false";
	}
	if (["zai", "qwen", "qwen-chat-template"].includes(String(format))) {
		return thinkingEnabled ? "enable_thinking=true" : "enable_thinking=false";
	}
	if (thinkingEnabled && compat.supportsReasoningEffort !== false) return `reasoning_effort=${effort}`;
	if (thinkingEnabled) return "reasoning=not-sent(supportsReasoningEffort=false)";
	return "reasoning=off";
}

function logResolvedConfig(config: ResolvedLiteLlmConfig, phase: "startup" | "runtime"): void {
	const model = config.defaultModel;
	const compat = (model.compat ?? {}) as Record<string, unknown>;
	const thinking = config.thinkingLevel ?? "unset";
	console.log(
		`${LOG_PREFIX} ${phase} config: ` +
			`api=${model.api} ` +
			`defaultModel=${config.defaultModelId} ` +
			`reasoning=${model.reasoning} ` +
			`defaultThinking=${thinking} ` +
			`compat.thinkingFormat=${String(compat.thinkingFormat ?? "auto")} ` +
			`compat.supportsReasoningEffort=${String(compat.supportsReasoningEffort ?? "auto")} ` +
			`compat.maxTokensField=${String(compat.maxTokensField ?? "auto")} ` +
			`request=${litellmRequestHint(model, config.thinkingLevel)}`,
	);
	for (const entry of config.models) {
		const levels = supportedThinkingLevelsForModel(entry);
		const defaultThinking = config.modelThinkingDefaults[modelKey(entry.id)];
		const hints =
			levels
				.filter((level) => level !== "off")
				.map((level) => `${level}:${litellmRequestHint(entry, level)}`)
				.join("|") || litellmRequestHint(entry, "off");
		console.log(
			`${LOG_PREFIX} ${phase} model: ` +
				`model=${entry.id} api=${entry.api} reasoning=${entry.reasoning} ` +
				`defaultThinking=${defaultThinking ?? "unset"} ` +
				`levels=${levels.join(",")} ` +
				`requests=${hints}`,
		);
	}
}

export function resolveLiteLlmConfig(): ResolvedLiteLlmConfig | null {
	if (cachedConfig !== undefined) return cachedConfig;

	const baseUrl = process.env.LITELLM_BASE_URL?.trim();
	if (!baseUrl) {
		cachedConfig = null;
		return cachedConfig;
	}

	const providerApi = parseApi(process.env.LITELLM_API, "openai-completions");
	// Provider-wide compat is now a fixed conservative baseline; per-model
	// `compat` in the models file is the only override.
	const providerCompat: Record<string, unknown> = { ...conservativeOpenAiCompat };
	const modelEntries = parseModels(providerCompat);
	const models = modelEntries.map((entry) => entry.model);
	if (models.length === 0) {
		console.warn(
			`${LOG_PREFIX} LITELLM_BASE_URL is set but no models were provided; ` +
				`set LITELLM_MODELS_PATH to a JSON file listing the models this deployment serves`,
		);
		cachedConfig = null;
		return cachedConfig;
	}

	const defaultModelId = process.env.LITELLM_DEFAULT_MODEL?.trim() || models[0]!.id;
	const defaultEntry = modelEntries.find((entry) => entry.model.id === defaultModelId);
	const defaultModel = defaultEntry?.model;
	if (!defaultModel) {
		throw new Error(`LITELLM_DEFAULT_MODEL ${defaultModelId} is not present in the LITELLM_MODELS_PATH file`);
	}

	const modelThinkingDefaults = Object.fromEntries(
		modelEntries
			.filter((entry): entry is NormalisedLiteLlmModel & { defaultThinkingLevel: ThinkingLevel } =>
				Boolean(entry.defaultThinkingLevel),
			)
			.map((entry) => [modelKey(entry.model.id), entry.defaultThinkingLevel]),
	);

	cachedConfig = {
		baseUrl,
		providerApi,
		providerCompat,
		models,
		defaultModelId,
		defaultModel,
		thinkingLevel: defaultEntry.defaultThinkingLevel,
		modelThinkingDefaults,
	};
	return cachedConfig;
}

export function resetLiteLlmConfigForTests(): void {
	cachedConfig = undefined;
	startupConfigLogged = false;
}

export function logLiteLlmStartupConfig(): void {
	if (startupConfigLogged) return;
	startupConfigLogged = true;
	const config = resolveLiteLlmConfig();
	if (config) logResolvedConfig(config, "startup");
}

export function litellmRuntimeConfig(): Partial<ProjectRuntimeConfig> {
	const config = resolveLiteLlmConfig();
	if (!config) return {};

	const providerConfig: ProviderConfig = {
		name: "LiteLLM",
		baseUrl: config.baseUrl,
		api: config.providerApi,
		apiKey: "LITELLM_API_KEY",
		models: config.models,
	};

	return {
		configureModelRegistry(modelRegistry) {
			modelRegistry.registerProvider("litellm", providerConfig);
			console.log(
				`${LOG_PREFIX} registered ${config.models.length} model(s); providerDefaultApi=${config.providerApi}`,
			);
			logResolvedConfig(config, "runtime");
		},
		defaultModelProvider: "litellm",
		defaultModelId: config.defaultModelId,
		defaultThinkingLevel: config.thinkingLevel,
		modelThinkingDefaults: config.modelThinkingDefaults,
	};
}
