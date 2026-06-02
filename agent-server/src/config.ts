/**
 * Server configuration loaded from environment variables.
 *
 * Single source of truth for the env-var contract: shape, defaults,
 * coercion, and validation all live in the Zod schema below. The rest
 * of the codebase consumes the typed `ServerConfig` object instead of
 * touching `process.env` directly — fail-fast at the boundary, twelve-
 * factor "config in env" with proper validation.
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
 *   - Org-shared (`GLOBAL_AGENT_DIR`, defaults to `~/.pi/agent/`):
 *       auth.json, models.json. These are org-scoped (one
 *       agent-server process = one org) and *must* be shared, so
 *       every runtime references the same instances.
 *   - Project tier (`<projectDir>/.pi/`):
 *       AGENTS.md, sessions/, skills/, extensions/, settings.json.
 *       Per-runtime — the default runtime uses its own projectDir's
 *       `.pi/`, just like every per-project runtime in multi mode.
 *
 * The runtime derives the project tier from `PROJECT_DIR` automatically;
 * there are no separate env vars for AGENTS.md or sessions paths. If a
 * project has no `.pi/AGENTS.md`, the runtime starts with no pinned
 * prompt (silent skip). Place project-local skills/extensions/prompts
 * under `.pi/` and Pi auto-discovers them.
 *
 * Pi additionally auto-discovers user-level resources from
 * `~/.pi/agent/skills/`, `~/.agents/skills/`, etc. if they exist;
 * agent-server inherits that for free but does not treat those
 * locations as part of its own contract.
 *
 * Environment variables
 * ─────────────────────
 *   PROJECT_DIR            (required) cwd handed to pi in single mode;
 *                          host root in multi mode. Must exist on disk.
 *
 *   AGENT_SERVER_MODE      "single" | "multi" (default: single).
 *   GLOBAL_AGENT_DIR       Pi's process-global config dir holding
 *                          auth.json + models.json. Falls back to
 *                          Pi's own getAgentDir() (which honours
 *                          PI_CODING_AGENT_DIR) when unset. Distinct
 *                          from <PROJECT_DIR>/.pi/, which is the
 *                          project tier. The name signals scope:
 *                          credentials live above any project's
 *                          commit/share boundary.
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
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";


export const ServerMode = {
  Single: "single",
  Multi: "multi",
} as const;
export type ServerMode = (typeof ServerMode)[keyof typeof ServerMode];

const SERVER_MODE_VALUES = [ServerMode.Single, ServerMode.Multi] as const;

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
const requiredString = z.preprocess(
  blankToUndefined,
  z.string({ required_error: "is required" }),
);

/** Optional string field. Empty → undefined. */
const optionalString = z.preprocess(blankToUndefined, z.string().optional());

/** Optional string with an explicit default. Empty → default. */
const stringWithDefault = (defaultValue: string) =>
  z.preprocess(blankToUndefined, z.string().default(defaultValue));

/** Comma-separated list → string[]; empty entries dropped. */
const commaList = z
  .preprocess(blankToUndefined, z.string().optional())
  .transform((raw) =>
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
 * Server routing mode. Strict enum — only canonical lowercase names.
 */
const modeSchema = z.preprocess(
  blankToUndefined,
  z
    .enum(SERVER_MODE_VALUES, {
      errorMap: () => ({ message: 'must be "single" or "multi"' }),
    })
    .default(ServerMode.Single),
);

/**
 * Raw env schema. Coerces primitives but defers cross-field path
 * resolution and filesystem checks to `loadConfig()` below — schemas
 * stay pure (no I/O), which keeps tests trivial to mock.
 */
const RawEnv = z.object({
  PROJECT_DIR: requiredString,
  GLOBAL_AGENT_DIR: optionalString,

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
  AGENT_SERVER_PORT: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().positive().max(65535).default(4001),
  ),
  AGENT_SERVER_TOKEN: optionalString,
  APPX_AGENT_SERVER_TOKEN: optionalString,
  AGENT_SERVER_MODE: modeSchema,
});

/** Fully resolved, validated server configuration. */
export type ServerConfig = {
  projectDir: string;
  agentDir: string | undefined;
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
  mode: ServerMode;
};

/**
 * Thrown by `loadConfig()` when the environment is invalid. Callers
 * are expected to print `.message` and exit with a non-zero status.
 */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `invalid configuration:\n${issues.map((issue) => `  ${issue}`).join("\n")}`,
    );
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

  const projectDir = resolve(raw.PROJECT_DIR);
  if (!existsSync(projectDir)) {
    throw new ConfigError([`PROJECT_DIR does not exist: ${projectDir}`]);
  }

  // Cross-field path resolution: a relative GLOBAL_AGENT_DIR is
  // resolved against the project directory so deployments can use
  // short relative paths without surprises. (Sessions and AGENTS.md are
  // derived inside the runtime from `<PROJECT_DIR>/.pi/` per Pi's
  // project convention — no env vars needed.)
  const agentDir = raw.GLOBAL_AGENT_DIR
    ? resolveAgainst(raw.GLOBAL_AGENT_DIR, projectDir)
    : undefined;

  // AGENT_SERVER_TOKEN wins over the legacy APPX_AGENT_SERVER_TOKEN
  // alias when both are set.
  const token = raw.AGENT_SERVER_TOKEN ?? raw.APPX_AGENT_SERVER_TOKEN;

  return {
    projectDir,
    agentDir,
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
    mode: raw.AGENT_SERVER_MODE,
  };
}

function resolveAgainst(path: string, anchorDir: string): string {
  return isAbsolute(path) ? path : resolve(anchorDir, path);
}
