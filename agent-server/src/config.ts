/**
 * Server configuration loaded from environment variables.
 *
 * Single source of truth for the env-var contract: shape, defaults,
 * coercion, and validation all live in the Zod schema below. The rest
 * of the codebase consumes the typed `ServerConfig` object instead of
 * touching `process.env` directly — fail-fast at the boundary, twelve-
 * factor "config in env" with proper validation.
 *
 * Routing is always project-scoped (`/v1/projects/{id}/...`); there is
 * no single/multi mode switch. A standalone deployment is simply a
 * workspace that holds one project. See
 * docs/architecture/project-lifecycle-and-workspace-layout.md.
 *
 * Conventions
 * ───────────
 *   - Enum-valued vars accept exactly the canonical names listed below;
 *     anything else is rejected with a clear error. No aliases, no case
 *     folding. Strict-in-what-you-accept beats permissive-and-surprising.
 *   - Boolean-valued vars accept exactly "true" or "false" (lowercase).
 *     Unset → false. Anything else (e.g. "yes", "1", "True") is rejected.
 *     Matches GitHub Actions / 12-factor convention.
 *   - Empty / whitespace-only values are treated as unset.
 *
 * Filesystem convention
 * ─────────────────────
 * Everything lives under one mountable root, `WORKSPACE_DIR`:
 *   - Org-shared (`WORKSPACE_DIR/.pi-global/`):
 *       auth.json, models.json (Pi), plus projects.json (agent-server's
 *       durable project registry) and sessions/{id}/ (transcripts).
 *       Org-scoped (one agent-server process = one org).
 *   - Project tier (`WORKSPACE_DIR/{id}/.pi/`):
 *       AGENTS.md, skills/, extensions/, settings.json. Per project,
 *       config-only (committable) — transcripts live centrally under
 *       `.pi-global/sessions/{id}/`, not here.
 *
 * Project directories are created on demand by the project lifecycle
 * endpoints (`POST /v1/projects`); operators only configure
 * `WORKSPACE_DIR`. If a project has no `.pi/AGENTS.md`, its runtime
 * starts with no pinned prompt (silent skip).
 *
 * Pi additionally auto-discovers user-level resources from
 * `~/.pi/agent/skills/`, `~/.agents/skills/`, etc. if they exist;
 * agent-server inherits that for free but does not treat those
 * locations as part of its own contract.
 *
 * Environment variables
 * ─────────────────────
 *   WORKSPACE_DIR          (required) root holding every project dir
 *                          plus `.pi-global/`. Must exist on disk.
 *                          Mount as a Docker volume for restart-safe
 *                          projects + registry.
 *   ANTHROPIC_API_KEY      injected into pi's AuthStorage if set
 *
 *   PI_EXTENSION_PATHS     comma-separated extension/package sources
 *                          (npm:, git:, or filesystem paths)
 *   PI_SKILL_PATHS         comma-separated skill file/directory paths
 *   PI_PROMPT_PATHS        comma-separated prompt template paths
 *   PI_THEME_PATHS         comma-separated theme paths
 *   PI_NO_EXTENSIONS       "true" → disables project/global extension
 *                          discovery except PI_EXTENSION_PATHS
 *   PI_NO_SKILLS           "true" → disables project/global skill discovery
 *   PI_NO_PROMPTS          "true" → disables project/global prompt discovery
 *   PI_NO_THEMES           "true" → disables project/global theme discovery
 *
 *   AGENT_SERVER_HOST      bind host (default: 127.0.0.1)
 *   AGENT_SERVER_PORT      bind port (default: 4001)
 *   AGENT_SERVER_TOKEN     if set, /v1/* requires Bearer auth.
 *                          APPX_AGENT_SERVER_TOKEN is a legacy alias.
 *
 * LITELLM_* variables are owned by `./providers/litellm.ts` and parsed
 * separately at the same boundary.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * Treat empty / whitespace-only env vars as unset (POSIX convention).
 * Trims surrounding whitespace from non-empty values so downstream
 * consumers don't have to.
 */
const blankToUndefined = (value: unknown): unknown => {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

/** Required string field. Empty / whitespace-only counts as missing. */
const requiredString = z.preprocess(blankToUndefined, z.string({ required_error: "is required" }));

/** Optional string field. Empty → undefined. */
const optionalString = z.preprocess(blankToUndefined, z.string().optional());

/** Optional string with an explicit default. Empty → default. */
const stringWithDefault = (defaultValue: string) => z.preprocess(blankToUndefined, z.string().default(defaultValue));

/** Comma-separated list → string[]; empty entries dropped. */
const commaList = z.preprocess(blankToUndefined, z.string().optional()).transform((raw) =>
	(raw ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean),
);

/**
 * Strict boolean env flag. Accepts exactly "true" or "false" (lowercase).
 * Unset / blank → false. Anything else is rejected with a clear error.
 *
 * Industry convention (12-factor, GitHub Actions, GoogleSRE): one canonical
 * spelling per value. Permissive parsers ("yes"/"on"/"1"/"True") look
 * friendly but make config files harder to grep for and let typos like
 * "flase" silently coerce to false.
 */
const booleanFlag = z
	.preprocess(
		blankToUndefined,
		z
			.enum(["true", "false"], {
				errorMap: () => ({ message: 'must be "true" or "false"' }),
			})
			.optional(),
	)
	.transform((value) => value === "true");

/**
 * Raw env schema. Coerces primitives but defers cross-field path
 * resolution and filesystem checks to `loadConfig()` below — schemas
 * stay pure (no I/O), which keeps tests trivial to mock.
 */
const RawEnv = z.object({
	WORKSPACE_DIR: requiredString,

	ANTHROPIC_API_KEY: optionalString,

	PI_EXTENSION_PATHS: commaList,
	PI_SKILL_PATHS: commaList,
	PI_PROMPT_PATHS: commaList,
	PI_THEME_PATHS: commaList,
	PI_NO_EXTENSIONS: booleanFlag,
	PI_NO_SKILLS: booleanFlag,
	PI_NO_PROMPTS: booleanFlag,
	PI_NO_THEMES: booleanFlag,

	AGENT_SERVER_HOST: stringWithDefault("127.0.0.1"),
	AGENT_SERVER_PORT: z.preprocess(blankToUndefined, z.coerce.number().int().positive().max(65535).default(4001)),
	AGENT_SERVER_TOKEN: optionalString,
	APPX_AGENT_SERVER_TOKEN: optionalString,
});

/** Fully resolved, validated server configuration. */
export type ServerConfig = {
	/** Root holding every project dir plus `.pi-global/`. */
	workspaceDir: string;
	anthropicApiKey: string | undefined;
	extensionPaths: string[];
	skillPaths: string[];
	promptTemplatePaths: string[];
	themePaths: string[];
	noExtensions: boolean;
	noSkills: boolean;
	noPromptTemplates: boolean;
	noThemes: boolean;
	host: string;
	port: number;
	token: string | undefined;
};

/**
 * Thrown by `loadConfig()` when the environment is invalid. Callers
 * are expected to print `.message` and exit with a non-zero status.
 */
export class ConfigError extends Error {
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(`invalid configuration:\n${issues.map((issue) => `  ${issue}`).join("\n")}`);
		this.name = "ConfigError";
		this.issues = issues;
	}
}

/**
 * Load + validate server configuration from the given env source
 * (defaults to `process.env`). Throws `ConfigError` with all collected
 * issues so the entrypoint can print and exit fast.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
	const parsed = RawEnv.safeParse(env);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => {
			const key = issue.path.join(".") || "(root)";
			return `${key}: ${issue.message}`;
		});
		throw new ConfigError(issues);
	}
	const raw = parsed.data;

	const workspaceDir = resolve(raw.WORKSPACE_DIR);
	if (!existsSync(workspaceDir)) {
		throw new ConfigError([`WORKSPACE_DIR does not exist: ${workspaceDir}`]);
	}

	// AGENT_SERVER_TOKEN wins over the legacy APPX_AGENT_SERVER_TOKEN
	// alias when both are set.
	const token = raw.AGENT_SERVER_TOKEN ?? raw.APPX_AGENT_SERVER_TOKEN;

	return {
		workspaceDir,
		anthropicApiKey: raw.ANTHROPIC_API_KEY,
		extensionPaths: raw.PI_EXTENSION_PATHS,
		skillPaths: raw.PI_SKILL_PATHS,
		promptTemplatePaths: raw.PI_PROMPT_PATHS,
		themePaths: raw.PI_THEME_PATHS,
		noExtensions: raw.PI_NO_EXTENSIONS,
		noSkills: raw.PI_NO_SKILLS,
		noPromptTemplates: raw.PI_NO_PROMPTS,
		noThemes: raw.PI_NO_THEMES,
		host: raw.AGENT_SERVER_HOST,
		port: raw.AGENT_SERVER_PORT,
		token,
	};
}
