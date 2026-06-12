# Refactor: Split `AgentRuntime` into `ProjectRuntime` + `ProjectSession`

## Status

**Landed** as of 2026-05-31.

Implementation matches the plan as written. Minor additions not in the plan:

- `AgentRuntimeResolver` was renamed to `ProjectRuntimeResolver` (in `routes.ts`) for consistency with the surrounding rename. Small cleanup that fell out of the rename.
- `ProjectSession.dispose()` is implemented but not yet called from production code; it exists as a future hook for idle eviction and is exercised by unit tests.

All 60 tests pass (was 41/41 before; +19 new ProjectSession unit tests including the cross-session ExtensionUI isolation regression).

## Goal

Eliminate the conflation in `src/runtime.ts` where `AgentRuntime` mixes **project-level concerns** (shared resources, session collection, project paths) with **session-level concerns** (extension UI plumbing, prompt dispatch, per-session lifecycle).

After this refactor:

- **`ProjectRuntime`** owns everything project-scoped: paths, resource loaders, the `Map<sessionId, ProjectSession>`, session creation/lookup/listing, and shared references to `AuthStorage` / `ModelRegistry` / `AgentCredentialsService` provided by the registry.
- **`ProjectSession`** owns everything session-scoped: the `AgentSession` instance, event subscription to the SSE broker, extension binding, the `pendingExtensionUi` map, the `ExtensionUIContext` implementation, and per-session operations (`sendPrompt`, `abort`, `setModel`, `setThinkingLevel`, model-settings reads).

Routes become a thin two-step adapter: look up the project session, then call a method on it.

## Why (Recap)

1. **Single Responsibility Principle.** Today `AgentRuntime` changes for two unrelated reasons: project-level changes (paths, resource sharing) and session-level changes (extension UI, prompt handling). Two responsibilities → two classes.
2. **Implicit context, not threaded sessionId.** `createExtensionUiContext(sessionId)`, `createDialogPromise(sessionId, ...)`, `pendingExtensionUiRequests(id)`, `resolveExtensionUiRequest(id, requestId, response)` all carry a `sessionId` parameter that's actually `this.sessionId` once the per-session class exists.
3. **Routes self-document.** `await runtime.sendPrompt(id, text)` hides a session lookup. `await (await project.getSession(id))?.sendPrompt(text)` makes the two-step nature explicit.
4. **Aligns with the architectural drawings.** `docs/architecture/builder-container-architecture.md` already describes "per-project AgentRuntime, per-session AgentSession" — this refactor makes the code shape match the diagram.
5. **Testability.** `ProjectSession` can be unit-tested with a mock `AgentSession` and a mock publish function; today you need a full `AgentRuntime` with project plumbing.

This refactor is **independent of and preferable to** swapping `AgentSession` for Pi's `AgentSessionRuntime`. See `docs/architecture/adapter-pattern-explained.md` for why we don't import `AgentSessionRuntime` even after this split.

## Target Architecture

```
HTTP routes (routes.ts)               ← thin adapter, no business logic
        │
        │ resolves project from c
        ▼
AgentRuntimeRegistry                  ← unchanged: Map<projectId, ProjectRuntime>
        │
        │ Map<projectId, ProjectRuntime>
        ▼
ProjectRuntime                        ← project-level (was AgentRuntime, partially)
  • projectDir, sessionsDir, agentsFile
  • shared AuthStorage / ModelRegistry / AgentCredentialsService
  • Map<sessionId, ProjectSession>
  • createNewSession()  → ProjectSession
  • getSession(id)      → ProjectSession | null   (was ensureSession)
  • listSessions()      → SessionRow[]
  • makeResourceLoader(), sessionModelDefaults()  (private helpers)
        │
        │ owns N
        ▼
ProjectSession                        ← session-level (NEW)
  • session: AgentSession
  • sessionId, boundAt, diagnostics
  • extensionsReady: Promise<void>
  • sendPrompt(text)
  • abort()
  • setModel(provider, modelId) / setThinkingLevel(level) / updateModelSettings(...)
  • getMessages(), getModelSettings()
  • pendingExtensionUiRequests()
  • resolveExtensionUiRequest(requestId, response)
  • dispose()
  • PRIVATE: createExtensionUiContext(), createDialogPromise(), commandActions()
        │
        │ wraps
        ▼
AgentSession (Pi)                     ← unchanged
```

## Current State

`src/runtime.ts` contains a single `AgentRuntime` class with:

| Lines (approx) | Member | Belongs in |
|----------------|--------|------------|
| `projectDir`, `sessionsDir`, `agentDir`, `credentials`, `authStorage`, `modelRegistry`, `defaultModel*`, `extensionPaths`, `skillPaths`, `noExtensions`, `agentsFile`, `systemPrompt` | `ProjectRuntime` |
| `live: Map<string, LiveSession>` | `ProjectRuntime` (with element type `ProjectSession` instead of `LiveSession`) |
| `pendingExtensionUi: Map<string, PendingExtensionUiRequest>` | `ProjectSession` (split per-session, `sessionId` field becomes implicit) |
| `sessionModelSettings(session)` | `ProjectSession` (it operates on a single session) |
| `sessionModelDefaults()` | `ProjectRuntime` (project-level config feeding session creation) |
| `makeResourceLoader()` | `ProjectRuntime` |
| `publishExtensionUiRequest(sessionId, request)` | `ProjectSession` (becomes `publish(request)`) |
| `createDialogPromise<T>(sessionId, ...)` | `ProjectSession` (drops the `sessionId` arg) |
| `createExtensionUiContext(sessionId)` | `ProjectSession` (drops the `sessionId` arg) |
| `extensionCommandActions(session)` | `ProjectSession` (becomes `commandActions()`, uses `this.session`) |
| `bind(session)` | `ProjectSession` constructor |
| `ensureExtensionsReady(id)` | `ProjectSession` (becomes `await this.extensionsReady`) |
| `pendingExtensionUiRequests(id)` | `ProjectSession.pendingExtensionUiRequests()` |
| `resolveExtensionUiRequest(id, requestId, response)` | `ProjectSession.resolveExtensionUiRequest(requestId, response)` |
| `createNewSession()` | `ProjectRuntime` (returns `ProjectSession` now, not `{ id, createdAt }`) |
| `ensureSession(id)` | `ProjectRuntime.getSession(id)` (returns `ProjectSession | null`) |
| `listSessions()` | `ProjectRuntime` |
| `getSessionMessages(id)` | `ProjectSession.getMessages()` (route looks up session first) |
| `getSessionModelSettings(id)` | `ProjectSession.getModelSettings()` |
| `setSessionModel(id, ...)` / `setSessionThinkingLevel(id, ...)` / `updateSessionModelSettings(id, ...)` | `ProjectSession.setModel(...)` / `setThinkingLevel(...)` / `updateModelSettings(...)` |
| `sendPrompt(id, text)` | `ProjectSession.sendPrompt(text)` |
| `abortSession(id)` | `ProjectSession.abort()` |

Key observation: the `LiveSession` type and `PendingExtensionUiRequest` type both disappear — they're absorbed into `ProjectSession` as private fields.

## Target File Layout

```
src/
├── projectRuntime.ts        ← NEW. Renamed from runtime.ts, project-level only.
├── projectSession.ts        ← NEW. Per-session class.
├── extensionUi.ts           ← NEW. ExtensionUiRequest / ExtensionUiResponse types.
├── runtimeRegistry.ts       ← UPDATED. Imports ProjectRuntime instead of AgentRuntime.
├── routes.ts                ← UPDATED. Two-step lookup; method calls move to ProjectSession.
├── server.ts                ← UPDATED. Type imports.
├── credentialsService.ts    ← UNCHANGED.
├── sseBroker.ts             ← UNCHANGED.
├── thinking.ts              ← UNCHANGED.
├── schemas.ts               ← UNCHANGED.
├── litellm.ts               ← UNCHANGED.
├── openapi.ts               ← UNCHANGED.
└── index.ts                 ← UPDATED. Public exports.
```

`runtime.ts` is **removed**. Its contents are split into `projectRuntime.ts` and `projectSession.ts`.

We extract the `ExtensionUiRequest` / `ExtensionUiResponse` discriminated unions to `extensionUi.ts` because both `projectSession.ts` (emits) and `routes.ts` (receives via the response endpoint) reference them.

## File-by-File Plan

### 1. NEW `src/extensionUi.ts`

Move the two type unions out of `runtime.ts` (lines ~189–220) verbatim. Re-export from `index.ts`.

```typescript
/**
 * Extension UI request/response types for SSE transport.
 * Mirrors Pi's RpcExtensionUI* types from
 * @earendil-works/pi-coding-agent/modes/rpc, but kept locally because Pi
 * doesn't export them from its public API.
 */

import type { WidgetPlacement } from "@earendil-works/pi-coding-agent";

export type ExtensionUiRequest =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText: string | undefined }
  | { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines: string[] | undefined; widgetPlacement?: WidgetPlacement }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

export type ExtensionUiResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };
```

### 2. NEW `src/projectSession.ts`

The new per-session class. Roughly 350 lines, absorbed from `runtime.ts`.

```typescript
/**
 * ProjectSession — owns one AgentSession and all per-session concerns:
 * event publishing, extension binding, ExtensionUIContext implementation,
 * extension-UI request/response routing, and per-session operations
 * (prompt, abort, model/thinking changes, message reads).
 *
 * Lifecycle: created by ProjectRuntime when a session is first bound
 * (created or lazily reopened). The constructor immediately subscribes
 * to AgentSession events and kicks off bindExtensions(); callers can
 * await `extensionsReady` before issuing the first prompt to ensure
 * extension `session_start` handlers have run.
 *
 * Disposal: call `dispose()` to unsubscribe from events, cancel pending
 * extension UI requests, and tear the session down. Currently unused
 * outside of testing — production keeps sessions live for the lifetime
 * of the runtime — but kept for symmetry with Pi's AgentSessionRuntime
 * teardown discipline and to give us a clean hook if we add idle eviction
 * later.
 */

import { randomUUID } from "node:crypto";
import {
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionCommandContextActions,
  type ExtensionUIContext,
  type ExtensionUIDialogOptions,
  type ExtensionWidgetOptions,
} from "@earendil-works/pi-coding-agent";
import type { AgentCredentialsService, AgentModelRow } from "./credentialsService.js";
import type { ExtensionUiRequest, ExtensionUiResponse } from "./extensionUi.js";
import { publish } from "./sseBroker.js";
import {
  type ThinkingLevel,
  supportedThinkingLevelsForModel,
} from "./thinking.js";

type SessionModel = NonNullable<Parameters<AgentSession["setModel"]>[0]>;

export type SessionModelSettings = {
  model: AgentModelRow | null;
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: ThinkingLevel[];
  supportsThinking: boolean;
  isStreaming: boolean;
};

type PendingExtensionUiRequest = {
  request: ExtensionUiRequest;
  resolve: (response: ExtensionUiResponse) => void;
  timer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
};

export type ProjectSessionDeps = {
  credentials: AgentCredentialsService;
  modelRegistry: Pick<
    import("@earendil-works/pi-coding-agent").ModelRegistry,
    "find"
  >;
  logger: Pick<Console, "log" | "error">;
};

export class ProjectSession {
  readonly session: AgentSession;
  readonly sessionId: string;
  readonly boundAt: string;
  readonly extensionsReady: Promise<void>;

  private readonly deps: ProjectSessionDeps;
  private readonly pendingExtensionUi = new Map<string, PendingExtensionUiRequest>();
  private readonly unsubscribeEvents: () => void;
  private disposed = false;

  constructor(session: AgentSession, deps: ProjectSessionDeps) {
    this.session = session;
    this.sessionId = session.sessionId;
    this.deps = deps;
    this.boundAt = new Date().toISOString();

    // Per-session SSE bridge. publish() routes by sessionId on the broker.
    this.unsubscribeEvents = session.subscribe((event: AgentSessionEvent) => {
      publish(this.sessionId, event);
    });

    // Bind extensions with our session-scoped UI context. We hold the
    // promise so sendPrompt() can await it and so disposers can join.
    this.extensionsReady = session
      .bindExtensions({
        uiContext: this.createExtensionUiContext(),
        commandContextActions: this.commandActions(),
        onError: (err) => {
          publish(this.sessionId, {
            type: "extension_error",
            extensionPath: err.extensionPath,
            event: err.event,
            error: err.error,
            stack: err.stack,
          });
          this.deps.logger.error(
            `[agent] extension error in ${err.extensionPath}: ${err.error}`,
          );
        },
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        publish(this.sessionId, {
          type: "extension_error",
          extensionPath: "<bindExtensions>",
          event: "session_start",
          error: message,
        });
        this.deps.logger.error(
          `[agent] extension binding failed for ${this.sessionId}: ${message}`,
        );
      });
  }

  // ─────────────────────────────────────────────────────────────────
  // Session operations
  // ─────────────────────────────────────────────────────────────────

  getMessages(): unknown[] {
    return this.session.state.messages;
  }

  getModelSettings(): SessionModelSettings {
    return {
      model: this.session.model
        ? this.deps.credentials.modelRow(this.session.model as SessionModel)
        : null,
      thinkingLevel: this.session.thinkingLevel as ThinkingLevel,
      availableThinkingLevels: this.session.getAvailableThinkingLevels() as ThinkingLevel[],
      supportsThinking: this.session.supportsThinking(),
      isStreaming: this.session.isStreaming,
    };
  }

  async setModel(provider: string, modelId: string): Promise<SessionModelSettings> {
    if (this.session.isStreaming)
      throw new Error("Cannot change model while the agent is running");
    const model = this.deps.modelRegistry.find(provider, modelId) as
      | SessionModel
      | undefined;
    if (!model) throw new Error(`model ${provider}/${modelId} not found`);
    await this.applyModel(model);
    return this.getModelSettings();
  }

  setThinkingLevel(level: ThinkingLevel): SessionModelSettings {
    if (this.session.isStreaming)
      throw new Error("Cannot change thinking level while the agent is running");
    this.session.setThinkingLevel(level);
    return this.getModelSettings();
  }

  async updateModelSettings(settings: {
    provider?: string;
    modelId?: string;
    thinkingLevel?: ThinkingLevel;
  }): Promise<SessionModelSettings> {
    if (this.session.isStreaming)
      throw new Error("Cannot change model settings while the agent is running");
    if (settings.provider && settings.modelId) {
      const model = this.deps.modelRegistry.find(
        settings.provider,
        settings.modelId,
      ) as SessionModel | undefined;
      if (!model)
        throw new Error(`model ${settings.provider}/${settings.modelId} not found`);
      await this.applyModel(model);
    }
    if (settings.thinkingLevel) this.session.setThinkingLevel(settings.thinkingLevel);
    return this.getModelSettings();
  }

  async sendPrompt(text: string): Promise<void> {
    await this.extensionsReady;
    if (this.session.isStreaming) {
      // Steer interrupts the current turn after current tool calls finish,
      // rather than waiting for it to fully stop (which followUp does).
      await this.session.prompt(text, { streamingBehavior: "steer" });
      return;
    }
    await this.session.prompt(text);
  }

  async abort(): Promise<void> {
    if (!this.session.isStreaming) return;
    await this.session.abort();
  }

  // ─────────────────────────────────────────────────────────────────
  // Extension UI request routing
  // ─────────────────────────────────────────────────────────────────

  pendingExtensionUiRequests(): ExtensionUiRequest[] {
    return Array.from(this.pendingExtensionUi.values()).map((entry) => entry.request);
  }

  resolveExtensionUiRequest(
    requestId: string,
    response: ExtensionUiResponse,
  ): boolean {
    const pending = this.pendingExtensionUi.get(requestId);
    if (!pending) return false;
    pending.resolve(response);
    return true;
  }

  // ─────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeEvents();
    for (const pending of this.pendingExtensionUi.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.abort?.();
      pending.resolve({ cancelled: true });
    }
    this.pendingExtensionUi.clear();
    // session.dispose() may not exist on AgentSession — call whatever
    // teardown Pi exposes if/when we need it. For now, dropping our
    // references is sufficient.
  }

  // ─────────────────────────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────────────────────────

  private async applyModel(model: SessionModel): Promise<void> {
    const currentThinkingLevel = this.session.thinkingLevel as ThinkingLevel;
    const nextAvailableLevels = supportedThinkingLevelsForModel(model);
    const defaultThinkingLevel = this.deps.credentials.defaultThinkingForModel(model);
    const shouldUseModelDefault = Boolean(
      defaultThinkingLevel && !nextAvailableLevels.includes(currentThinkingLevel),
    );
    await this.session.setModel(model);
    if (shouldUseModelDefault && this.session.thinkingLevel !== defaultThinkingLevel) {
      this.session.setThinkingLevel(defaultThinkingLevel!);
    }
  }

  private commandActions(): ExtensionCommandContextActions {
    return {
      waitForIdle: () => this.session.agent.waitForIdle(),
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }),
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {
        await this.session.reload();
      },
    };
  }

  /**
   * Create a session-scoped ExtensionUIContext. All pending UI requests
   * route back to this ProjectSession; the SSE broker fans them out to
   * subscribers of this sessionId.
   */
  private createExtensionUiContext(): ExtensionUIContext {
    return {
      select: (title, options, opts) =>
        this.dialog(opts, undefined, { method: "select", title, options, timeout: opts?.timeout },
          (r) => ("cancelled" in r ? undefined : "value" in r ? r.value : undefined)),
      confirm: (title, message, opts) =>
        this.dialog(opts, false, { method: "confirm", title, message, timeout: opts?.timeout },
          (r) => ("cancelled" in r ? false : "confirmed" in r ? r.confirmed : false)),
      input: (title, placeholder, opts) =>
        this.dialog(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout },
          (r) => ("cancelled" in r ? undefined : "value" in r ? r.value : undefined)),
      editor: (title, prefill) =>
        this.dialog(undefined, undefined, { method: "editor", title, prefill },
          (r) => ("cancelled" in r ? undefined : "value" in r ? r.value : undefined)),
      notify: (message, type) =>
        this.publishRequest({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          message,
          notifyType: type,
        }),
      onTerminalInput: () => () => {},
      setStatus: (key, text) =>
        this.publishRequest({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setStatus",
          statusKey: key,
          statusText: text,
        }),
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: ((key: string, content: string[] | ((...args: unknown[]) => unknown) | undefined, options?: ExtensionWidgetOptions) => {
        if (content !== undefined && !Array.isArray(content)) return;
        this.publishRequest({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        });
      }) as ExtensionUIContext["setWidget"],
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) =>
        this.publishRequest({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setTitle",
          title,
        }),
      custom: async () => undefined as never,
      pasteToEditor: (text) =>
        this.publishRequest({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        }),
      setEditorText: (text) =>
        this.publishRequest({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        }),
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() {
        return undefined as never;
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({
        success: false,
        error: "UI theme switching is not available in agent-server",
      }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  private dialog<T>(
    opts: ExtensionUIDialogOptions | undefined,
    fallback: T,
    request: Record<string, unknown>,
    mapResponse: (response: ExtensionUiResponse) => T,
  ): Promise<T> {
    const id = randomUUID();
    const event = { type: "extension_ui_request" as const, id, ...request } as ExtensionUiRequest;

    return new Promise<T>((resolve) => {
      const finish = (response: ExtensionUiResponse) => {
        const pending = this.pendingExtensionUi.get(id);
        if (!pending) return;
        if (pending.timer) clearTimeout(pending.timer);
        pending.abort?.();
        this.pendingExtensionUi.delete(id);
        resolve(mapResponse(response));
      };

      const pending: PendingExtensionUiRequest = {
        request: event,
        resolve: finish,
      };

      if (opts?.timeout && opts.timeout > 0) {
        pending.timer = setTimeout(() => finish({ cancelled: true }), opts.timeout);
      }

      if (opts?.signal) {
        const onAbort = () => finish({ cancelled: true });
        opts.signal.addEventListener("abort", onAbort, { once: true });
        pending.abort = () => opts.signal?.removeEventListener("abort", onAbort);
      }

      this.pendingExtensionUi.set(id, pending);
      this.publishRequest(event);
    });
  }

  private publishRequest(request: ExtensionUiRequest): void {
    publish(this.sessionId, request);
  }
}
```

Notes on this file:
- All `sessionId` parameter threading from `runtime.ts` is removed. `this.sessionId` does the routing.
- `ensureExtensionsReady` becomes `await this.extensionsReady` directly in `sendPrompt`.
- `dispose()` is added now (currently we have no equivalent — sessions live forever). It's a small addition that gives us a clean hook for future idle eviction and helps tests not leak event listeners.
- `commandActions()` is private because nothing outside the class needs it.

### 3. NEW `src/projectRuntime.ts` (replaces `src/runtime.ts`)

Project-level only. Roughly 250 lines, down from 777.

```typescript
/**
 * ProjectRuntime — pi SDK orchestrator scoped to one project.
 *
 * Each project gets one ProjectRuntime that:
 *   - Holds project-level config (projectDir, sessionsDir, agentsFile, …)
 *   - Holds shared references to AuthStorage, ModelRegistry, and
 *     AgentCredentialsService (provided by AgentRuntimeRegistry — these
 *     are process-global, not project-global)
 *   - Owns Map<sessionId, ProjectSession> and is responsible for session
 *     creation, lazy reopen, and listing
 *   - Builds a fresh DefaultResourceLoader per session bind
 *
 * Per-session operations (prompt, abort, model changes, extension-UI
 * routing) live on ProjectSession, not here. Routes look up the
 * ProjectSession via getSession(id) and call methods on it directly.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  AuthStorage,
  type CreateAgentSessionOptions,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  getAgentDir,
  ModelRegistry,
  type ModelRegistry as ModelRegistryType,
  SessionManager,
  type SessionInfo,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AgentCredentialsService } from "./credentialsService.js";
import { ProjectSession } from "./projectSession.js";
import { type ThinkingLevel } from "./thinking.js";

type SessionModel = NonNullable<CreateAgentSessionOptions["model"]>;

export type {
  AgentAuthPrompt,
  AgentAuthProviderRow,
  AgentCustomProviderApi,
  AgentCustomProviderModel,
  AgentCustomProviderRow,
  AgentModelRow,
  AgentOAuthFlowState,
  UpsertCustomProviderRequest,
} from "./credentialsService.js";
export type { ExtensionUiRequest, ExtensionUiResponse } from "./extensionUi.js";
export type { SessionModelSettings } from "./projectSession.js";
export type { ThinkingLevel } from "./thinking.js";

export type ProjectRuntimeConfig = {
  projectDir: string;
  sessionsDir: string;
  agentDir?: string;
  credentials: AgentCredentialsService;
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistryType;
  anthropicApiKey?: string;
  configureModelRegistry?: (modelRegistry: ModelRegistryType) => void;
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

export type SessionRow = {
  id: string;
  createdAt: string;
  firstMessage: string;
  messageCount: number;
};

export class ProjectRuntime {
  readonly credentials: AgentCredentialsService;
  private readonly projectDir: string;
  private readonly sessionsDir: string;
  private readonly agentDir: string;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly logger: Pick<Console, "log" | "error">;
  private readonly defaultModelProvider: string | undefined;
  private readonly defaultModelId: string | undefined;
  private readonly defaultThinkingLevel: ThinkingLevel | undefined;
  private readonly extensionPaths: string[];
  private readonly skillPaths: string[];
  private readonly promptTemplatePaths: string[];
  private readonly themePaths: string[];
  private readonly extensionFactories: ExtensionFactory[];
  private readonly noExtensions: boolean;
  private readonly noSkills: boolean;
  private readonly noPromptTemplates: boolean;
  private readonly noThemes: boolean;
  private readonly agentsFile: string | undefined;
  private readonly systemPrompt: string | undefined;
  private readonly sessions = new Map<string, ProjectSession>();

  constructor(config: ProjectRuntimeConfig) {
    // … same body as the current AgentRuntime constructor, with one
    // change: ProjectSession-related fields (`live`, `pendingExtensionUi`)
    // are gone. `sessions` replaces `live`.
    // … (full code identical to current constructor; omitted here for brevity)
  }

  // ── Session collection management ─────────────────────────────────

  async createNewSession(): Promise<ProjectSession> {
    const { session } = await createAgentSession({
      ...this.sessionModelDefaults(),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager: SessionManager.create(this.projectDir, this.sessionsDir),
      resourceLoader: await this.makeResourceLoader(),
    });
    return this.adopt(session);
  }

  /**
   * Get a live ProjectSession, lazily reopening from disk if needed.
   * Returns null if no session file exists with the given id.
   */
  async getSession(id: string): Promise<ProjectSession | null> {
    const existing = this.sessions.get(id);
    if (existing) return existing;

    const sessions = await SessionManager.list(this.projectDir, this.sessionsDir);
    const info = sessions.find((s) => s.id === id);
    if (!info) return null;

    const { session } = await createAgentSession({
      ...this.sessionModelDefaults(),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager: SessionManager.open(info.path),
      resourceLoader: await this.makeResourceLoader(),
    });
    return this.adopt(session);
  }

  async listSessions(): Promise<SessionRow[]> {
    const list: SessionInfo[] = await SessionManager.list(
      this.projectDir,
      this.sessionsDir,
    );
    const onDisk = new Set(list.map((s) => s.id));

    const rows: SessionRow[] = list.map((info) => ({
      id: info.id,
      createdAt: info.created.toISOString(),
      firstMessage: info.firstMessage ?? "",
      messageCount: info.messageCount,
    }));

    for (const [id, ps] of this.sessions) {
      if (onDisk.has(id)) continue;
      const messages = ps.session.state.messages as Array<{
        role: string;
        content: Array<{ type: string; text?: string }>;
      }>;
      const firstUser = messages.find((m) => m.role === "user");
      const firstText =
        firstUser?.content.find((c) => c.type === "text")?.text ?? "";
      rows.push({
        id,
        createdAt: ps.boundAt,
        firstMessage: firstText,
        messageCount: messages.length,
      });
    }

    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ── Private helpers ───────────────────────────────────────────────

  private adopt(session: import("@earendil-works/pi-coding-agent").AgentSession): ProjectSession {
    const ps = new ProjectSession(session, {
      credentials: this.credentials,
      modelRegistry: this.modelRegistry,
      logger: this.logger,
    });
    this.sessions.set(ps.sessionId, ps);
    return ps;
  }

  private sessionModelDefaults(): Pick<CreateAgentSessionOptions, "model" | "thinkingLevel"> {
    // … unchanged from current AgentRuntime.sessionModelDefaults()
  }

  private async makeResourceLoader(): Promise<DefaultResourceLoader> {
    // … unchanged from current AgentRuntime.makeResourceLoader()
  }
}
```

Notes:
- `sendPrompt`, `abortSession`, `setSessionModel`, `setSessionThinkingLevel`, `updateSessionModelSettings`, `getSessionMessages`, `getSessionModelSettings`, `pendingExtensionUiRequests`, `resolveExtensionUiRequest`, `ensureSession`, `ensureExtensionsReady`, `bind`, `createDialogPromise`, `createExtensionUiContext`, `extensionCommandActions`, `publishExtensionUiRequest` are all **gone** from `ProjectRuntime`. Either moved to `ProjectSession` or replaced by the routes calling `await pr.getSession(id)` then a method on the returned `ProjectSession`.
- `LiveSession` and `PendingExtensionUiRequest` types are gone (absorbed).
- `ExtensionUiRequest` / `ExtensionUiResponse` types are re-exported from `extensionUi.ts` for backwards-compat with anything that was importing from `runtime.js`.

### 4. UPDATED `src/runtimeRegistry.ts`

Mechanical rename only. ~5 line diff.

```typescript
// Change all imports of AgentRuntime / AgentRuntimeConfig to
// ProjectRuntime / ProjectRuntimeConfig from "./projectRuntime.js".
//
// Rename:
//   class AgentRuntimeRegistry → unchanged (the registry stays this name)
//   type AgentRuntimeRegistryConfig → unchanged (registry config name stays)
//   type RuntimeEntry's runtime: AgentRuntime → runtime: ProjectRuntime
//   defaultRuntime: AgentRuntime → defaultRuntime: ProjectRuntime
//   forProject(...) return type → ProjectRuntime
//   private createRuntime(...) return type → ProjectRuntime
//   new AgentRuntime(...) → new ProjectRuntime(...)
```

We **keep** `AgentRuntimeRegistry` named as-is — it's the registry of project runtimes, and renaming it would ripple into appx's Go proxy code. The mental model is "registry of runtimes", which stays accurate.

### 5. UPDATED `src/routes.ts`

The pattern in every session-scoped handler changes from one-step to two-step lookup. Roughly 30 line diff total across the file.

**Before** (current pattern):
```typescript
app.openapi(getMessagesRoute, async (c) => {
  const runtime = await getRuntime(c);
  const id = c.req.param("id");
  const messages = await runtime.getSessionMessages(id);
  if (messages === null) return c.json({ error: "session not found" }, 404);
  return c.json({ messages }, 200);
});
```

**After**:
```typescript
app.openapi(getMessagesRoute, async (c) => {
  const runtime = await getRuntime(c);
  const id = c.req.param("id");
  const session = await runtime.getSession(id);
  if (!session) return c.json({ error: "session not found" }, 404);
  return c.json({ messages: session.getMessages() }, 200);
});
```

Specific call-site rewrites:

| Current | New |
|---------|-----|
| `await runtime.listSessions()` | unchanged |
| `await runtime.createNewSession()` returns `{ id, createdAt }` | `const session = await runtime.createNewSession();` then build `{ id: session.sessionId, createdAt: session.boundAt }` |
| `await runtime.getSessionModelSettings(id)` | `const s = await runtime.getSession(id); if (!s) 404; return s.getModelSettings();` |
| `await runtime.updateSessionModelSettings(id, body)` | `const s = await runtime.getSession(id); if (!s) 404; return await s.updateModelSettings(body);` |
| `await runtime.getSessionMessages(id)` | `const s = await runtime.getSession(id); if (!s) 404; return s.getMessages();` |
| `await runtime.ensureSession(id)` then `runtime.pendingExtensionUiRequests(id)` | `const s = await runtime.getSession(id); if (!s) 404; return s.pendingExtensionUiRequests();` |
| `runtime.resolveExtensionUiRequest(id, requestId, body)` | `const s = await runtime.getSession(id); if (!s) 404; const ok = s.resolveExtensionUiRequest(requestId, body);` |
| `await runtime.ensureSession(id)` then `runtime.sendPrompt(id, text)` | `const s = await runtime.getSession(id); if (!s) 404; void s.sendPrompt(text).catch(...);` |
| `await runtime.abortSession(id)` | `const s = await runtime.getSession(id); if (!s) 404; await s.abort();` |
| SSE `for (const request of runtime.pendingExtensionUiRequests(id))` | `for (const request of session.pendingExtensionUiRequests())` (variable already in scope from existing `runtime.ensureSession(id)` call, which becomes `runtime.getSession(id)`) |

The SSE handler is the most interesting case — `getSession` returning `ProjectSession` instead of `AgentSession` means the existing `session.pendingExtensionUiRequests()` call works directly. No extra plumbing.

### 6. UPDATED `src/server.ts`

Mechanical: rename type imports `AgentRuntime` → `ProjectRuntime` and update the resolver type. ~5 line diff.

### 7. UPDATED `src/index.ts`

Public API rename. Whatever consumers are importing (`AgentRuntime`, `AgentRuntimeConfig`) either needs aliasing or a deprecation cycle.

**Recommended approach** (since this is an internal-to-appx package): direct rename, no compatibility shim. Update appx in the same commit if it imports from agent-server's types (it doesn't appear to — it talks via HTTP).

```typescript
export { ProjectRuntime, type ProjectRuntimeConfig, type SessionRow } from "./projectRuntime.js";
export { ProjectSession, type SessionModelSettings } from "./projectSession.js";
export type { ExtensionUiRequest, ExtensionUiResponse } from "./extensionUi.js";
export { AgentRuntimeRegistry, type AgentRuntimeRegistryConfig } from "./runtimeRegistry.js";
// … existing credentials / litellm / openapi exports unchanged
```

### 8. UPDATED `test/server.test.ts`

The integration tests construct `AgentRuntimeRegistry` and `AgentRuntime` directly. Two name changes:

```typescript
// Before
import { AgentRuntime } from "../src/runtime.js";
new AgentRuntime({ ... })

// After
import { ProjectRuntime } from "../src/projectRuntime.js";
new ProjectRuntime({ ... })
```

Test bodies don't care which methods are on which class because they drive everything through `fetch` against the real HTTP routes. Signature changes are transparent at the HTTP level.

## Step-by-Step Implementation Order

Designed so `npm run check` passes after each step.

1. **Create `src/extensionUi.ts`** with the two type unions.
   - Re-export them from `src/runtime.ts` so nothing breaks yet.
   - Verify: `npm run check` passes.

2. **Create `src/projectSession.ts`** with the `ProjectSession` class.
   - Don't wire it up yet. Just compile it.
   - Adapt the existing `bind`, `createExtensionUiContext`, `createDialogPromise`, `extensionCommandActions`, `pendingExtensionUiRequests`, `resolveExtensionUiRequest`, `sessionModelSettings`, `setSessionModelInternal`, `sendPrompt`, `abortSession`, `setSessionModel`, `setSessionThinkingLevel`, `updateSessionModelSettings`, `getSessionMessages`, `getSessionModelSettings` logic into class methods that drop the `id`/`sessionId` parameter and use `this`.
   - Verify: `npm run check` passes (file compiles even though nothing uses it yet).

3. **Wire `ProjectRuntime` (still named `AgentRuntime`) to use `ProjectSession`.**
   - Inside `runtime.ts`, replace `live: Map<string, LiveSession>` with `sessions: Map<string, ProjectSession>`.
   - Replace `bind(session)` with `adopt(session)` that constructs a `ProjectSession`.
   - Make `AgentRuntime`'s session-operation methods delegate to the matching `ProjectSession` method (transitional; the methods stay on `AgentRuntime` for now).
   - Delete the now-unused private fields (`pendingExtensionUi`) and helpers (`createDialogPromise`, `createExtensionUiContext`, `publishExtensionUiRequest`, `extensionCommandActions`, `ensureExtensionsReady`, `bind`).
   - Verify: existing tests pass. SSE traffic still flows.

4. **Push session-operation methods off `AgentRuntime` into routes.**
   - In `routes.ts`, replace each `await runtime.x(id, ...)` with `const s = await runtime.getSession(id); if (!s) 404; await s.x(...)`. Add `getSession` as an alias of `ensureSession` returning the new type.
   - Remove the corresponding methods from `AgentRuntime` once routes stop calling them.
   - Verify: existing tests pass.

5. **Rename `AgentRuntime` → `ProjectRuntime`, file `runtime.ts` → `projectRuntime.ts`.**
   - Update imports in `runtimeRegistry.ts`, `server.ts`, `index.ts`, `test/server.test.ts`.
   - Drop the temporary re-exports from step 1.
   - Verify: `npm run check` passes, all tests green.

6. **Add new tests for `ProjectSession`** (see "Tests" below).
   - Verify: full suite green.

7. **Update internal docs** (`docs/architecture/pi-component-responsibilities.md`, `docs/architecture/extension-ui-implementation-comparison.md`, `docs/architecture/builder-container-architecture.md`) so the class names match the new code.

Each step is independently shippable and reviewable. If we have to stop midway, the system stays working.

## Tests

### New unit tests for `ProjectSession`

`test/projectSession.test.ts` (new file) — exercises the new class in isolation with a fake `AgentSession` and a spy `publish` function.

Coverage targets:
- Constructor subscribes to events and forwards them to `publish` with the correct sessionId.
- Constructor calls `bindExtensions`; `extensionsReady` resolves on success and on bind error (with `extension_error` published).
- `sendPrompt` awaits `extensionsReady` before delegating, and uses `streamingBehavior: "steer"` when already streaming.
- `abort` is a no-op when not streaming, calls `session.abort()` otherwise.
- `setModel` rejects while streaming; rejects unknown model; calls `setModel` and applies thinking-level default when current level isn't supported by the new model.
- `setThinkingLevel` rejects while streaming.
- `updateModelSettings` applies model and thinking changes atomically; rejects while streaming.
- ExtensionUI dialog flow: `select` returns the value on response; returns `undefined` on `cancelled: true`; honors `timeout`; honors abort signal.
- `pendingExtensionUiRequests()` returns currently-open dialogs.
- `resolveExtensionUiRequest(requestId, response)` returns false for unknown id, true on success, removes the entry.
- `dispose()` cancels pending dialogs (resolving them with `cancelled: true`) and unsubscribes events.

### Updated integration tests in `test/server.test.ts`

- Two import name changes (`AgentRuntime` → `ProjectRuntime`).
- One semantic check to add: a regression that **confirms two concurrent sessions in the same project don't cross-pollinate ExtensionUI requests** (i.e., resolving session A's request shouldn't affect session B's pending). This was implicit before; with separate `pendingExtensionUi` maps per `ProjectSession`, the property is now structural.

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| Breaking external consumers of `AgentRuntime` exports | Low | appx talks via HTTP, not via type imports. Confirmed by grepping `appx/internal/server/agent_proxy.go` — no Node imports. |
| Subtle behavior change in extension binding ordering | Low | Constructor calls `bindExtensions` synchronously, same as current `bind()`. The `extensionsReady` promise has identical semantics to today's `extensionsReady`. |
| SSE event ordering changes | Very low | The subscribe call moves from `bind()` to `ProjectSession` constructor, but happens at the same point in the lifecycle (immediately on session creation/reopen). No reordering. |
| New `dispose()` method introduces a way to leak / double-dispose | Low | Guarded by `disposed` flag. Currently unused outside tests. |
| Type churn breaks `npm run check` mid-refactor | Medium | The step-by-step plan above is explicitly designed so each step compiles before moving on. Re-export shims in step 1 cover the transition. |
| Test instability from the new ProjectSession unit tests | Medium | Use a hand-written fake `AgentSession`, not real Pi internals. Keep tests deterministic with explicit timing controls. |

## Out of Scope

These are deliberately **not** part of this refactor and should be separate proposals:

1. Importing Pi's `AgentSessionRuntime`. We considered and rejected this in `docs/architecture/adapter-pattern-explained.md`. Don't combine with this refactor.
2. Adding a separate "http-mode" file/concept. `routes.ts` already plays that structural role.
3. Idle session eviction. The new `dispose()` enables it cleanly, but the policy decision is separate.
4. Multi-user authorization on session ids. Currently any caller with a project's auth header can resolve any session id in that project; that's an appx-side concern.
5. Renaming `AgentRuntimeRegistry`. The name is still accurate ("registry of project runtimes") and renaming touches more files than the win is worth.

## Estimated Size

- New code: ~400 lines (`projectSession.ts` + `extensionUi.ts`).
- Removed code: ~450 lines (carved out of `runtime.ts`).
- Modified code: ~50 lines (`routes.ts`, `runtimeRegistry.ts`, `server.ts`, `index.ts`, `test/server.test.ts`).
- New tests: ~250 lines (`test/projectSession.test.ts`).

Net: roughly +150 lines, but with the existing 777-line `runtime.ts` replaced by a ~250-line `projectRuntime.ts` plus a focused ~400-line `projectSession.ts`. Both new files are easier to read in isolation than the current monolith.

## Done When

1. `src/runtime.ts` no longer exists.
2. `ProjectRuntime` exposes only project-level methods (`createNewSession`, `getSession`, `listSessions`); no method takes a `sessionId` argument.
3. `ProjectSession` exposes only session-level methods; no method takes a `sessionId` argument (it's `this.sessionId`).
4. `routes.ts` follows the two-step `getSession` → method-on-session pattern uniformly.
5. `npm run check` is green; all existing tests pass; new `ProjectSession` unit tests are added and green.
6. Updated docs reference the new class names.
