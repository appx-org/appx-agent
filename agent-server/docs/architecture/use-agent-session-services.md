# Refactor: Adopt `AgentSessionServices` in `ProjectRuntime`

## Status

Proposed. **Depends on `project-runtime-and-session-split.md` landing first.**

## Goal

Replace `ProjectRuntime`'s individually-held service references (`authStorage`, `modelRegistry`, `agentDir`, plus per-session-recreated `SettingsManager` and `ResourceLoader`) with a single `services: AgentSessionServices` bundle constructed via Pi's `createAgentSessionServices()`.

After this refactor:

- One `ResourceLoader` and one `SettingsManager` per project, reused across all sessions in that project (instead of recreated per session).
- Session creation goes through `createAgentSessionFromServices()` instead of the lower-level `createAgentSession()`.
- Pi's `AgentSessionRuntimeDiagnostic[]` is captured and exposable via API instead of silently dropped.
- `ProjectRuntime` construction becomes async (static factory pattern), matching Pi's own SDK ergonomics.

## Why This Is a Separate Commit

Keeping this as its own commit on top of the split refactor:

1. **Independent rollback.** If the snapshot semantics on `ResourceLoader` (see Risks) cause an unforeseen issue in production, we can revert this commit cleanly without losing the `ProjectRuntime` / `ProjectSession` separation.
2. **Bisectable.** Two changes with two different blast radii deserve two commits.
3. **Reviewable.** Reviewers can evaluate "should we adopt Pi's services bundle?" separately from "should we split per-session concerns out of `AgentRuntime`?"
4. **Self-contained scope.** This refactor doesn't touch `routes.ts` or `ProjectSession` — only `ProjectRuntime`, `runtimeRegistry.ts`, `server.ts` startup, and tests' construction calls.

## Prerequisite State (After the Split)

The split refactor leaves us with:

```
ProjectRuntime                        ← project-level
  • authStorage, modelRegistry        (held individually, shared from registry)
  • agentDir, projectDir, sessionsDir
  • agentsFile, systemPrompt
  • extension/skill/prompt/theme paths + flags
  • Map<sessionId, ProjectSession>
  • makeResourceLoader()              ← per-session, expensive
  • createNewSession() / getSession() / listSessions()
  • diagnostics: silently dropped
        │
        ▼ for each session:
  createAgentSession({                ← lower-level Pi API
    authStorage, modelRegistry,
    sessionManager,
    resourceLoader: await makeResourceLoader(),  // fresh every call
  })
```

Specifically, today's per-session creation calls `makeResourceLoader()`, which:

```typescript
private async makeResourceLoader(): Promise<DefaultResourceLoader> {
  const settingsManager = SettingsManager.create(this.projectDir, this.agentDir);
  const loader = new DefaultResourceLoader({ ... });
  await loader.reload();   // ← walks fs, parses extensions, loads skills/themes
  return loader;
}
```

For a project with N sessions, `loader.reload()` runs N times. That's the inefficiency this refactor eliminates.

## Target State

```
ProjectRuntime                        ← project-level
  • services: AgentSessionServices    ← bundle (cwd, agentDir, authStorage,
  •                                      settingsManager, modelRegistry,
  •                                      resourceLoader, diagnostics)
  • credentials                       (still passed in from registry)
  • projectDir, sessionsDir           (still held — services has cwd, but
  •                                    sessionsDir is agent-server-specific
  •                                    and not in services)
  • model defaults (provider/id/thinking)
  • Map<sessionId, ProjectSession>
  • static create(config) → Promise<ProjectRuntime>     ← async factory
  • createNewSession() / getSession() / listSessions()  ← unchanged signatures
  • reload() → Promise<void>          ← NEW: explicit ResourceLoader refresh
  • diagnostics → readonly[]          ← NEW: accessor
        │
        ▼ for each session:
  createAgentSessionFromServices({    ← higher-level Pi API
    services: this.services,
    sessionManager,
    ...modelDefaults,
  })
```

## Pros & Cons (Recap)

### Pros

1. **One `ResourceLoader.reload()` per project, not per session.** For a 10-session project, eliminates 9 redundant filesystem walks, extension parses, and theme loads.
2. **One `SettingsManager` per project.** Settings don't change per-session.
3. **Diagnostics get a real home.** Pi expects callers to surface `AgentSessionRuntimeDiagnostic[]`. Today we drop them. Now we hold them and can expose them via API later.
4. **Cleaner session creation.** `createAgentSessionFromServices({ services, sessionManager, ...defaults })` reads better than the current hand-rolled options object.
5. **Pi vocabulary alignment.** Same types/names appear in agent-server and Pi's docs/source. Easier onboarding.
6. **Future-proof.** New cwd-bound services Pi adds to the bundle come for free.
7. **Extension-provided custom providers register once per project.** Currently re-registered per session.

### Cons

1. **Behavior change: resources snapshot at project startup.** Today, every `createNewSession()` / `getSession()` triggers a fresh `reload()` — new files on disk are picked up. With shared services, sessions created later see the project-startup snapshot until something calls `reload()`.
   - For builder-container deployment (resources baked into image): no impact.
   - For dev workflows (skill files added during a session): mitigated by `await projectRuntime.reload()` API.
2. **`ProjectRuntime` construction becomes async.** Ripples to `AgentRuntimeRegistry` (also becomes async-constructed) and to anywhere that creates a registry at startup.
3. **Tighter coupling to `AgentSessionServices` shape.** A breaking change in Pi's bundle interface affects us. Risk is real but small — it's been stable.
4. **One more concept for contributors.** "Why services and not individual fields?" Worth a doc paragraph.

## File-by-File Plan

Assumes the split refactor has landed. Files referenced are post-split names.

### 1. `src/projectRuntime.ts`

Replace individual service fields with `services`. Move agentsFile/systemPrompt reading into the static factory. Remove `makeResourceLoader()`.

```typescript
import {
  type AgentSessionServices,
  type AgentSessionRuntimeDiagnostic,
  type AuthStorage,
  type ModelRegistry,
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  type SessionInfo,
  // ... other imports unchanged
} from "@earendil-works/pi-coding-agent";

export type ProjectRuntimeConfig = {
  projectDir: string;
  sessionsDir: string;
  agentDir?: string;
  credentials: AgentCredentialsService;
  authStorage?: AuthStorage;          // shared from registry, optional input
  modelRegistry?: ModelRegistry;      // shared from registry, optional input
  anthropicApiKey?: string;
  configureModelRegistry?: (modelRegistry: ModelRegistry) => void;
  defaultModelProvider?: string;
  defaultModelId?: string;
  defaultThinkingLevel?: ThinkingLevel;
  modelThinkingDefaults?: Record<string, ThinkingLevel>;
  extensionPaths?: string[];
  skillPaths?: string[];
  promptTemplatePaths?: string[];
  themePaths?: string[];
  extensionFactories?: ExtensionFactory[];
  noExtensions?: boolean;
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  agentsFile?: string;
  logger?: Pick<Console, "log" | "error">;
};

export class ProjectRuntime {
  readonly credentials: AgentCredentialsService;
  readonly services: AgentSessionServices;

  private readonly projectDir: string;
  private readonly sessionsDir: string;
  private readonly defaultModelProvider: string | undefined;
  private readonly defaultModelId: string | undefined;
  private readonly defaultThinkingLevel: ThinkingLevel | undefined;
  private readonly logger: Pick<Console, "log" | "error">;
  private readonly sessions = new Map<string, ProjectSession>();

  /**
   * Async factory. Creates the AgentSessionServices bundle (which runs
   * resourceLoader.reload() once and registers extension-provided custom
   * model providers into the shared modelRegistry) and constructs the
   * runtime around it.
   */
  static async create(config: ProjectRuntimeConfig): Promise<ProjectRuntime> {
    const projectDir = resolve(config.projectDir);
    const sessionsDir = resolve(config.sessionsDir);
    const agentDir = config.agentDir ? resolve(config.agentDir) : getAgentDir();
    const logger = config.logger ?? console;

    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });

    // Read pinned system prompt if specified, suppress ancestor walk if so.
    const { systemPrompt, agentsFilePath } = readPinnedSystemPrompt(config, projectDir, logger);

    // Inject runtime API key into shared AuthStorage (caller-provided).
    if (config.anthropicApiKey && config.authStorage) {
      config.authStorage.setRuntimeApiKey("anthropic", config.anthropicApiKey);
      logger.log("[agent] runtime ANTHROPIC_API_KEY injected");
    }

    // Build the services bundle. Pi creates ResourceLoader + SettingsManager
    // here, runs reload(), and registers extension-provided custom providers
    // into the (shared) modelRegistry.
    const services = await createAgentSessionServices({
      cwd: projectDir,
      agentDir,
      authStorage: config.authStorage,
      modelRegistry: config.modelRegistry,
      resourceLoaderOptions: {
        additionalExtensionPaths: config.extensionPaths,
        additionalSkillPaths: config.skillPaths,
        additionalPromptTemplatePaths: config.promptTemplatePaths,
        additionalThemePaths: config.themePaths,
        extensionFactories: config.extensionFactories,
        noExtensions: config.noExtensions,
        noSkills: config.noSkills,
        noPromptTemplates: config.noPromptTemplates,
        noThemes: config.noThemes,
        // When systemPrompt is pinned, suppress Pi's ancestor AGENTS.md walk.
        noContextFiles: systemPrompt !== undefined,
        systemPrompt,
      },
    });

    if (agentsFilePath) {
      logger.log(
        `[agent] system prompt loaded from ${agentsFilePath} (${systemPrompt!.length} chars)`,
      );
    }

    // Apply caller's modelRegistry hook only if registry isn't shared.
    // (Shared registries are configured once at the registry level.)
    if (!config.modelRegistry) {
      config.configureModelRegistry?.(services.modelRegistry);
    }

    // Surface diagnostics from services creation.
    for (const diag of services.diagnostics) {
      const log = diag.type === "error" ? logger.error : logger.log;
      log.call(logger, `[agent] ${diag.type}: ${diag.message}`);
    }

    // Validate the configured default model resolves & has auth.
    if (config.defaultModelProvider && config.defaultModelId) {
      const model = services.modelRegistry.find(
        config.defaultModelProvider,
        config.defaultModelId,
      );
      if (!model) {
        logger.error(
          `[agent] default model not found: ${config.defaultModelProvider}/${config.defaultModelId}`,
        );
      } else if (!services.modelRegistry.hasConfiguredAuth(model)) {
        logger.error(
          `[agent] auth is not configured for default model ${model.provider}/${model.id}`,
        );
      } else {
        logger.log(`[agent] default model: ${model.provider}/${model.id}`);
      }
    }

    return new ProjectRuntime(
      {
        projectDir,
        sessionsDir,
        defaultModelProvider: config.defaultModelProvider,
        defaultModelId: config.defaultModelId,
        defaultThinkingLevel: config.defaultThinkingLevel,
        credentials: config.credentials,
        logger,
      },
      services,
    );
  }

  private constructor(
    fields: {
      projectDir: string;
      sessionsDir: string;
      defaultModelProvider: string | undefined;
      defaultModelId: string | undefined;
      defaultThinkingLevel: ThinkingLevel | undefined;
      credentials: AgentCredentialsService;
      logger: Pick<Console, "log" | "error">;
    },
    services: AgentSessionServices,
  ) {
    this.projectDir = fields.projectDir;
    this.sessionsDir = fields.sessionsDir;
    this.defaultModelProvider = fields.defaultModelProvider;
    this.defaultModelId = fields.defaultModelId;
    this.defaultThinkingLevel = fields.defaultThinkingLevel;
    this.credentials = fields.credentials;
    this.logger = fields.logger;
    this.services = services;
  }

  // ── Session collection management ─────────────────────────────────

  async createNewSession(): Promise<ProjectSession> {
    const { session } = await createAgentSessionFromServices({
      services: this.services,
      sessionManager: SessionManager.create(this.projectDir, this.sessionsDir),
      ...this.sessionModelDefaults(),
    });
    return this.adopt(session);
  }

  async getSession(id: string): Promise<ProjectSession | null> {
    const existing = this.sessions.get(id);
    if (existing) return existing;

    const sessions = await SessionManager.list(this.projectDir, this.sessionsDir);
    const info = sessions.find((s) => s.id === id);
    if (!info) return null;

    const { session } = await createAgentSessionFromServices({
      services: this.services,
      sessionManager: SessionManager.open(info.path),
      ...this.sessionModelDefaults(),
    });
    return this.adopt(session);
  }

  async listSessions(): Promise<SessionRow[]> {
    // unchanged from post-split version; only the dependency-bundle source changed
  }

  // ── New: explicit refresh hook ────────────────────────────────────

  /**
   * Reload project resources (skills, extensions, prompts, themes, etc.)
   * from disk. Existing live sessions keep their already-bound extensions;
   * only sessions created after this call see the new resources.
   *
   * If you need existing sessions to pick up new extensions too, you'll
   * have to dispose+recreate them — out of scope today.
   */
  async reload(): Promise<void> {
    await this.services.resourceLoader.reload();
  }

  // ── New: diagnostics accessor ─────────────────────────────────────

  /**
   * Non-fatal issues collected during services creation: extension load
   * errors, unknown extension flags, custom provider registration failures.
   * Surface these to operators / API consumers as appropriate.
   */
  diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
    return this.services.diagnostics;
  }

  // ── Private helpers ───────────────────────────────────────────────

  private adopt(session: AgentSession): ProjectSession {
    const ps = new ProjectSession(session, {
      credentials: this.credentials,
      modelRegistry: this.services.modelRegistry,
      logger: this.logger,
    });
    this.sessions.set(ps.sessionId, ps);
    return ps;
  }

  private sessionModelDefaults(): { model?: SessionModel; thinkingLevel?: ThinkingLevel } {
    const defaults: { model?: SessionModel; thinkingLevel?: ThinkingLevel } = {};
    if (this.defaultModelProvider && this.defaultModelId) {
      const model = this.services.modelRegistry.find(
        this.defaultModelProvider,
        this.defaultModelId,
      ) as SessionModel | undefined;
      if (model) {
        defaults.model = model;
        const thinkingLevel = this.credentials.defaultThinkingForModel(model);
        if (thinkingLevel) defaults.thinkingLevel = thinkingLevel;
      }
    }
    if (!defaults.thinkingLevel && this.defaultThinkingLevel) {
      defaults.thinkingLevel = this.defaultThinkingLevel;
    }
    return defaults;
  }
}

/**
 * Read pinned system prompt file if specified. Returns the prompt content
 * and resolved path. Throws on read failure (consistent with current behavior).
 */
function readPinnedSystemPrompt(
  config: ProjectRuntimeConfig,
  projectDir: string,
  logger: Pick<Console, "log" | "error">,
): { systemPrompt: string | undefined; agentsFilePath: string | undefined } {
  if (!config.agentsFile) return { systemPrompt: undefined, agentsFilePath: undefined };
  const path = isAbsolute(config.agentsFile)
    ? config.agentsFile
    : resolve(projectDir, config.agentsFile);
  try {
    const systemPrompt = readFileSync(path, "utf8");
    return { systemPrompt, agentsFilePath: path };
  } catch (err) {
    logger.error(`[agent] failed to read agentsFile ${path}: ${String(err)}`);
    throw err;
  }
}
```

**Removed**:
- `makeResourceLoader()` private method (services holds the loader).
- `agentDir` private field (services has it).
- Direct `authStorage` / `modelRegistry` private fields (services has them; expose via `services.authStorage` etc. if needed elsewhere).
- Per-session `SettingsManager.create()` call.
- Inline systemPrompt logic in constructor.

**Added**:
- Static `create(config)` async factory.
- `services: AgentSessionServices` readonly field.
- `reload()` method.
- `diagnostics()` accessor.
- Top-level `readPinnedSystemPrompt()` helper.

### 2. `src/runtimeRegistry.ts`

`forProject` becomes async. The registry itself becomes constructed via static async factory for symmetry — but the `defaultRuntime` story is the load-bearing change.

Today:
```typescript
class AgentRuntimeRegistry {
  readonly defaultRuntime: AgentRuntime;

  constructor(config: AgentRuntimeRegistryConfig) {
    // ... sync setup ...
    this.defaultRuntime = this.createRuntime({ id: "default", projectDir });
  }
}
```

After:
```typescript
class AgentRuntimeRegistry {
  readonly defaultRuntime: ProjectRuntime;

  static async create(config: AgentRuntimeRegistryConfig): Promise<AgentRuntimeRegistry> {
    const registry = new AgentRuntimeRegistry(config);
    registry.defaultRuntime = await registry.createRuntime({
      id: "default",
      projectDir: registry.config.projectDir,
    });
    return registry;
  }

  private constructor(config: AgentRuntimeRegistryConfig) {
    // sync field assignment only — no runtime creation
  }

  async forProject(context: ProjectRuntimeContext): Promise<ProjectRuntime> {
    // ... existing existence check ...
    const runtime = await this.createRuntime({ ...context, projectDir });
    this.runtimes.set(context.id, { projectDir, runtime });
    return runtime;
  }

  private async createRuntime(context: ProjectRuntimeContext): Promise<ProjectRuntime> {
    // ... existing config assembly ...
    return ProjectRuntime.create({
      ...this.config,
      projectDir,
      sessionsDir,
      credentials: this.credentials,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      configureModelRegistry: undefined,
      extensionPaths,
      agentsFile,
    });
  }
}
```

The `defaultRuntime` field is initialized only inside `create()`, after the async runtime is built. To satisfy `readonly` + TypeScript, we either:

- Use `definite assignment assertion` (`defaultRuntime!: ProjectRuntime`) and assign inside `create()` after instantiation, or
- Pass it into a private constructor that takes both config and the pre-built runtime.

The second is cleaner. Constructor signature becomes `(config, defaultRuntime)`.

### 3. `src/server.ts` (or wherever `AgentRuntimeRegistry` is instantiated)

Replace `new AgentRuntimeRegistry(config)` with `await AgentRuntimeRegistry.create(config)`. Already top-level-await-friendly in modern Node; if startup is in a function, that function becomes async (it almost certainly already is).

### 4. `src/index.ts`

Re-export newly-public types:

```typescript
export type {
  AgentSessionServices,
  AgentSessionRuntimeDiagnostic,
} from "@earendil-works/pi-coding-agent";
// (Re-exporting these from agent-server's surface is convenient for
// consumers that want to inspect ProjectRuntime.services / .diagnostics()
// without separately importing pi-coding-agent.)
```

`ProjectRuntime` and `ProjectRuntimeConfig` exports are unchanged from the post-split state.

### 5. `test/server.test.ts`

```typescript
// Before
const registry = new AgentRuntimeRegistry({ ... });

// After
const registry = await AgentRuntimeRegistry.create({ ... });
```

`AgentRuntime` direct-construction sites in tests (`new AgentRuntime({...})`) become `await ProjectRuntime.create({...})`.

Test bodies that drive the system through `fetch` against the real HTTP routes don't change at all — the HTTP surface is identical.

### 6. `test/projectSession.test.ts` (if it constructs `ProjectRuntime` directly)

Same `await ProjectRuntime.create(...)` change.

## Step-by-Step Implementation Order

Each step keeps `npm run check` and the existing test suite green.

1. **Add a `getServices(): AgentSessionServices` shim to `ProjectRuntime`.**
   Without changing structure, build a services object on demand from the existing fields (so we can add usages incrementally). This is throwaway code; deleted in step 4.

2. **Switch session creation to `createAgentSessionFromServices`.**
   In `createNewSession()` and `getSession()`, replace the `createAgentSession({ authStorage, modelRegistry, sessionManager, resourceLoader })` call with `createAgentSessionFromServices({ services: this.getServices(), sessionManager, ...defaults })`. Verify nothing changes behaviorally — `createAgentSessionFromServices` is a thin wrapper that does exactly the equivalent call. Tests should pass.

3. **Introduce `ProjectRuntime.create()` async factory.**
   Add the static factory that calls `createAgentSessionServices()`. Convert one usage site (e.g., the registry's default runtime) to use it. Keep the sync constructor temporarily for backward compatibility with other callers. Tests should pass.

4. **Convert `AgentRuntimeRegistry.forProject()` to async + add `AgentRuntimeRegistry.create()`.**
   Update `server.test.ts` and `server.ts` startup. Remove the temporary sync constructor on `ProjectRuntime`. Remove the `getServices()` shim — `services` is now a real readonly field assigned in the factory. Tests should pass.

5. **Remove `makeResourceLoader()` and per-session `SettingsManager` construction.**
   At this point sessions get their resources from `services`, so the per-session helper is dead code. Tests should pass.

6. **Add `reload()` and `diagnostics()` public API on `ProjectRuntime`.**
   No callers yet — these are net-new surface for future use. Add a unit test for `reload()` (calls `services.resourceLoader.reload()` exactly once).

7. **Surface diagnostics in startup logs.**
   When `ProjectRuntime.create()` finishes, log warnings/errors from `services.diagnostics`. (Already shown in the code sketch above.)

8. **Update docs.**
   - This file: mark Status as "Landed" with the relevant commit SHA.
   - `docs/architecture/pi-component-responsibilities.md`: update the agent-server mapping table to show `services: AgentSessionServices` ownership.
   - `docs/architecture/builder-container-architecture.md`: update the inner diagram if it references individual auth/registry holdings.

Steps 1–2 can land as a single "no-op refactor" commit. Step 3 is "introduce factory." Step 4 is the API breaking change. Step 5 is cleanup. Steps 6–8 are additive.

Realistically this might collapse into 2–3 commits in practice, but the granularity is here if we want it.

## Tests

### Unit tests for `ProjectRuntime` (new or updated)

- `ProjectRuntime.create()` resolves to a runtime with a populated `services` bundle.
- `services.resourceLoader` is the same instance across two `createNewSession()` calls (proves we're not recreating per session).
- `services.settingsManager` is the same instance across two `getSession()` calls.
- `diagnostics()` returns `services.diagnostics` (identity, not copy).
- `reload()` invokes `services.resourceLoader.reload()` exactly once and is idempotent.
- `ProjectRuntime.create()` propagates the read failure from `agentsFile` (if invalid path).

### Integration regression in `test/server.test.ts`

Add: a project with an extension that registers a custom model provider should register it **once** at project startup, not N times for N sessions. (Today's behavior re-registers per-session; Pi's `registerProvider` is idempotent so this is currently silent waste — the regression test ensures we don't accidentally re-introduce per-session registration after the refactor.)

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Snapshot semantics surprise: skill files added after project startup don't appear in new sessions | Medium | Low (single-admin builder use case) | Document explicitly in `ProjectRuntime` JSDoc; expose `reload()` API; consider auto-reload via fs watcher as a follow-up if it becomes a friction point |
| Async constructor cascade missed at some call site | Low | Low | TypeScript catches it: a `Promise<ProjectRuntime>` is structurally distinct from `ProjectRuntime`; if a caller forgets to await, type check fails |
| `services.diagnostics` populated with errors that should have been thrown | Low | Medium | At step 7, treat `error`-severity diagnostics as startup failures (throw) rather than just logs, matching Pi's existing patterns in `runtime.ts` (e.g., default-model auth check today logs error but doesn't throw — keep that consistent) |
| Pi's `AgentSessionServices` shape changes in a future Pi version | Low | Medium | Pin the Pi version; update intentionally on bumps; the bundle is small enough that breaks are easy to fix |
| `configureModelRegistry` hook semantics change (only fires when registry isn't shared) | Low | Low | Already only-fires-when-not-shared today (line 287 of `runtime.ts`). Behavior is preserved. |
| Memory profile: each project now permanently holds a `ResourceLoader` (vs today's per-session, GC'd between sessions) | Low | Low | Inverse trade-off: fewer reloads but longer-lived references. Net is roughly neutral; benchmark only if it becomes a concern with many idle projects. |

## Rollback Plan

If this refactor needs to be reverted post-merge:

1. Revert this commit.
2. `ProjectRuntime` returns to holding individual `authStorage` / `modelRegistry` / `agentDir` fields and a `makeResourceLoader()` helper.
3. `AgentRuntimeRegistry.create()` becomes the sync constructor again.
4. `server.ts` startup drops the `await`.
5. Tests: revert the `await ... .create()` changes.

The split refactor (`ProjectRuntime` / `ProjectSession` separation, routes' two-step lookup) is **not** affected by the rollback. `routes.ts`, `projectSession.ts`, and `extensionUi.ts` stay as-is. This is the whole point of keeping the two refactors as separate commits.

## Out of Scope

1. **File-watcher-driven auto-reload.** Useful for dev, but adds a runtime cost and a failure mode (dropped events, churn). Defer until there's a concrete use case.
2. **Disposing live sessions on `reload()` to pick up new extensions.** Sessions outlive resource refreshes intentionally — extensions that have already loaded into a session shouldn't be yanked out. If we want this, do it as an explicit per-session API.
3. **Exposing `GET /v1/projects/{id}/diagnostics` HTTP endpoint.** Easy follow-up once `diagnostics()` exists, but separate concern. Decide based on whether appx wants to surface them in its UI.
4. **Per-project (rather than registry-wide) `AuthStorage` or `ModelRegistry`.** Would lose the shared-credentials property the builder-container architecture relies on. Don't do this.
5. **Importing `AgentSessionRuntime`.** Still rejected for the reasons in `docs/architecture/adapter-pattern-explained.md`. Using `AgentSessionServices` is fully compatible with continuing to use `AgentSession` directly via `createAgentSessionFromServices`.

## Done When

1. `ProjectRuntime.services: AgentSessionServices` exists and is the source of truth for `authStorage`, `modelRegistry`, `settingsManager`, `resourceLoader`, `cwd`, `agentDir`.
2. `makeResourceLoader()` and per-session `SettingsManager.create()` are deleted from the codebase.
3. Session creation uses `createAgentSessionFromServices` everywhere.
4. `ProjectRuntime.create(config)` is the only construction path; no public sync constructor.
5. `AgentRuntimeRegistry.create(config)` is async; `forProject()` is async.
6. `ProjectRuntime.reload()` and `ProjectRuntime.diagnostics()` exist and are tested.
7. Diagnostics from project startup are logged.
8. `npm run check` is green; all tests (existing + new) pass.
9. Migration plan checked into the docs/architecture/ folder is updated to "Landed."
