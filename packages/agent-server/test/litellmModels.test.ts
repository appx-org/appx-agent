/**
 * LiteLLM model-list resolution.
 *
 * The model list has exactly one source: the JSON file named by
 * `LITELLM_MODELS_PATH`. These tests cover that contract — loading, precedence
 * against `modelPreset()`, and the failure modes that must be loud rather than
 * silent, because a misconfiguration that merely registers no provider looks
 * like "the agent has no models" with nothing pointing at the cause.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { resetLiteLlmConfigForTests, resolveLiteLlmConfig } from "../src/providers/litellm.js";

const ENV_KEYS = [
	"LITELLM_BASE_URL",
	"LITELLM_API_KEY",
	"LITELLM_MODELS_PATH",
	"LITELLM_DEFAULT_MODEL",
	"LITELLM_API",
	// Removed in 0.2.0; asserted to be rejected below.
	"LITELLM_MODELS_JSON",
	"LITELLM_MODELS",
	"LITELLM_CONTEXT_WINDOW",
	"LITELLM_MAX_TOKENS",
	"LITELLM_REASONING",
	"LITELLM_COMPAT_JSON",
	"LITELLM_DEFAULT_THINKING",
];

let saved: Map<string, string | undefined>;
let dir: string;

/** Write a models file and point the env var at it. */
function writeModels(models: unknown): string {
	const path = resolve(dir, "models.json");
	writeFileSync(path, typeof models === "string" ? models : JSON.stringify(models), "utf8");
	process.env.LITELLM_MODELS_PATH = path;
	return path;
}

beforeEach(() => {
	saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
	for (const key of ENV_KEYS) delete process.env[key];
	dir = mkdtempSync(resolve(tmpdir(), "litellm-models-test-"));
	process.env.LITELLM_BASE_URL = "http://litellm.test/v1";
	process.env.LITELLM_API_KEY = "test-key";
	resetLiteLlmConfigForTests();
});

afterEach(() => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(dir, { recursive: true, force: true });
	resetLiteLlmConfigForTests();
});

describe("litellm models file", () => {
	test("loads every entry and defaults to the first model", () => {
		writeModels([{ id: "anthropic/claude-sonnet-5" }, { id: "openai/gpt-5.5" }]);

		const config = resolveLiteLlmConfig();
		assert.equal(config?.models.length, 2);
		assert.deepEqual(
			config?.models.map((model) => model.id),
			["anthropic/claude-sonnet-5", "openai/gpt-5.5"],
		);
		assert.equal(config?.defaultModelId, "anthropic/claude-sonnet-5");
	});

	test("LITELLM_DEFAULT_MODEL selects a model from the file", () => {
		writeModels([{ id: "anthropic/claude-sonnet-5" }, { id: "openai/gpt-5.5" }]);
		process.env.LITELLM_DEFAULT_MODEL = "openai/gpt-5.5";
		resetLiteLlmConfigForTests();

		assert.equal(resolveLiteLlmConfig()?.defaultModelId, "openai/gpt-5.5");
	});

	test("a default model absent from the file is a hard error", () => {
		writeModels([{ id: "anthropic/claude-sonnet-5" }]);
		process.env.LITELLM_DEFAULT_MODEL = "openai/gpt-5.5";
		resetLiteLlmConfigForTests();

		assert.throws(() => resolveLiteLlmConfig(), /LITELLM_DEFAULT_MODEL openai\/gpt-5\.5 is not present/);
	});

	test("per-model metadata is carried through verbatim", () => {
		writeModels([
			{
				id: "anthropic/claude-sonnet-5",
				name: "Claude Sonnet 5",
				reasoning: true,
				contextWindow: 400_000,
				maxTokens: 64_000,
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				compat: { supportsPromptCacheKey: true },
			},
		]);

		const model = resolveLiteLlmConfig()?.defaultModel;
		assert.equal(model?.name, "Claude Sonnet 5");
		assert.equal(model?.contextWindow, 400_000);
		assert.equal(model?.maxTokens, 64_000);
		assert.deepEqual(model?.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
		assert.equal((model?.compat as Record<string, unknown>).supportsPromptCacheKey, true);
	});

	test("unset LITELLM_MODELS_PATH registers no provider rather than throwing", () => {
		// A deployment that has not configured models yet is not an error: the
		// caller warns and skips registration.
		assert.equal(resolveLiteLlmConfig(), null);
	});

	test("baseline fills fields the file omits", () => {
		writeModels([{ id: "some/unknown-model" }]);

		const model = resolveLiteLlmConfig()?.defaultModel;
		assert.equal(model?.name, "some/unknown-model");
		assert.equal(model?.contextWindow, 128_000);
		assert.equal(model?.maxTokens, 16_384);
		assert.equal(model?.reasoning, false);
		assert.deepEqual(model?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});
});

describe("litellm models file: presets", () => {
	test("a known model inherits its preset dialect and thinking map", () => {
		writeModels([{ id: "openai/gpt-5.5" }]);

		const config = resolveLiteLlmConfig();
		const model = config?.defaultModel;
		assert.equal(model?.api, "openai-responses");
		assert.equal(model?.reasoning, true);
		assert.equal((model?.compat as Record<string, unknown>).thinkingFormat, "openai");
		// The preset's defaultThinkingLevel drives the session default.
		assert.equal(config?.thinkingLevel, "xhigh");
	});

	test("file entries override preset fields", () => {
		writeModels([{ id: "openai/gpt-5.5", name: "Custom Name", api: "openai-completions", contextWindow: 1000 }]);

		const model = resolveLiteLlmConfig()?.defaultModel;
		assert.equal(model?.name, "Custom Name");
		assert.equal(model?.api, "openai-completions");
		assert.equal(model?.contextWindow, 1000);
		// Untouched preset fields still apply.
		assert.equal((model?.compat as Record<string, unknown>).thinkingFormat, "openai");
	});

	test("deepseek unsupported thinking levels stay unsupported", () => {
		writeModels([{ id: "deepseek/deepseek-v4-pro" }]);

		const model = resolveLiteLlmConfig()?.defaultModel;
		// null means "this model cannot do that level" and drives clamping.
		assert.equal(model?.thinkingLevelMap?.low, null);
		assert.equal(model?.thinkingLevelMap?.high, "high");
		assert.equal(model?.thinkingLevelMap?.xhigh, "max");
	});
});

describe("litellm models file: failure modes", () => {
	test("an unreadable path throws rather than silently registering nothing", () => {
		process.env.LITELLM_MODELS_PATH = resolve(dir, "does-not-exist.json");
		resetLiteLlmConfigForTests();

		assert.throws(() => resolveLiteLlmConfig(), /could not be read/);
	});

	test("malformed JSON throws", () => {
		writeModels("{not json");
		assert.throws(() => resolveLiteLlmConfig(), /is not valid JSON/);
	});

	test("a JSON object rather than an array throws", () => {
		writeModels({ id: "openai/gpt-5.5" });
		assert.throws(() => resolveLiteLlmConfig(), /must contain a JSON array/);
	});

	test("an entry without an id throws", () => {
		writeModels([{ name: "no id here" }]);
		assert.throws(() => resolveLiteLlmConfig(), /missing id/);
	});

	test("an unsupported thinkingLevelMap key throws", () => {
		writeModels([{ id: "openai/gpt-5.5", thinkingLevelMap: { turbo: "high" } }]);
		assert.throws(() => resolveLiteLlmConfig(), /unsupported thinkingLevelMap key turbo/);
	});
});

describe("litellm models file: removed environment variables", () => {
	// Each of these silently did nothing once the file became the only source,
	// which is exactly the failure that is hard to diagnose in a deployment.
	for (const [name, value] of [
		["LITELLM_MODELS_JSON", '[{"id":"openai/gpt-5.5"}]'],
		["LITELLM_MODELS", "openai/gpt-5.5"],
		["LITELLM_CONTEXT_WINDOW", "200000"],
		["LITELLM_MAX_TOKENS", "32000"],
		["LITELLM_REASONING", "true"],
		["LITELLM_COMPAT_JSON", "{}"],
		["LITELLM_DEFAULT_THINKING", "high"],
	] as const) {
		test(`${name} is rejected with an actionable message`, () => {
			writeModels([{ id: "openai/gpt-5.5" }]);
			process.env[name] = value;
			resetLiteLlmConfigForTests();

			assert.throws(
				() => resolveLiteLlmConfig(),
				new RegExp(`${name}.*removed in agent-server 0\\.2\\.0|removed in agent-server 0\\.2\\.0.*${name}`, "s"),
			);
		});
	}

	test("the error names LITELLM_MODELS_PATH as the replacement", () => {
		writeModels([{ id: "openai/gpt-5.5" }]);
		process.env.LITELLM_MODELS_JSON = "[]";
		resetLiteLlmConfigForTests();

		assert.throws(() => resolveLiteLlmConfig(), /LITELLM_MODELS_PATH/);
	});
});
