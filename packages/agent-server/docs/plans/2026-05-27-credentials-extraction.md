# Credentials Extraction + Thinking-Level Dedup Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract process-global auth/model/custom-provider/OAuth state from `AgentRuntime` into a new `AgentCredentialsService`, owned by `AgentRuntimeRegistry`. Delete duplicated thinking-level clamp/levels logic from `runtime.ts` and `litellm.ts`; replace with a single thin wrapper module backed by `@earendil-works/pi-ai`.

**Architecture:** Today `AgentRuntime` mixes two lifetimes: process-global credential state (auth storage, model registry, OAuth flows, `models.json` CRUD) and per-project session state (live sessions, prompt/abort, settings). In multi mode the credential routes are mounted only against `defaultRuntime`, so those methods are dead code on N–1 of N runtime instances. We move credential code into a new `AgentCredentialsService` that the registry constructs once and that handles `/v1/auth/*` and `/v1/custom/*`. `AgentRuntime` keeps a reference to the service for read-only projections (e.g. `listModels`, `modelRow` used in session settings). Session creation routes still go through `AgentRuntime`. Separately, the duplicated thinking-level helpers move into a new `src/thinking.ts` that delegates to Pi's `getSupportedThinkingLevels` / `clampThinkingLevel` from `@earendil-works/pi-ai`.

**Tech Stack:** TypeScript, Hono `@hono/zod-openapi`, Pi SDK (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`), Zod, Node test runner (`node --test` via `tsx`).

---

## File Structure

**New files:**
- `src/thinking.ts` — thin re-exports / wrappers around `@earendil-works/pi-ai`'s clamp + supported-levels helpers, plus the `THINKING_LEVELS` constant. One source of truth for the runtime + litellm.
- `src/credentialsService.ts` — `AgentCredentialsService` class. Owns `AuthStorage`, `ModelRegistry`, `models.json` CRUD, OAuth flow state machine, `listAuthProviders`, `listModels`, `modelRow`. Keeps the wire shape (`AgentAuthProviderRow`, `AgentCustomProviderRow`, `AgentOAuthFlowState`, `AgentModelRow`) verbatim so the OpenAPI contract is unchanged.
- `test/credentialsService.test.ts` — direct unit tests for the new class (no HTTP layer), exercising auth status merging, OAuth reuse, custom-provider CRUD, and `listModels` projection.

**Modified files:**
- `package.json` — add `@earendil-works/pi-ai` as a direct dependency at the same minor as our pinned coding-agent.
- `src/runtime.ts` — remove auth, OAuth flow, custom-provider, listModels/listAuthProviders, modelRow, and clamp/supported-levels code. Accept the credentials service via constructor. Keep session methods, extension UI bridge, agentsFile loader. Replace internal clamp calls with imports from `./thinking.js`.
- `src/litellm.ts` — replace the duplicated `supportedThinkingLevels` / `clampThinkingLevel` / `THINKING_LEVELS` with imports from `./thinking.js`.
- `src/runtimeRegistry.ts` — construct `AgentCredentialsService` once, pass it down to every `AgentRuntime`. Stop wiring `AuthStorage`/`ModelRegistry` directly into runtimes.
- `src/routes.ts` — split: keep session routes in `createSessionsApp(runtime, options)` but make `credentialRoutes` accept either an `AgentRuntime` (back-compat) or an `AgentCredentialsService`. Cleanest split: introduce `createCredentialsApp(credentials)` and have `createSessionsApp` shed the credential routes entirely. Update callers.
- `src/server.ts` — call `createCredentialsApp(registry.credentials)` for `/v1` and `createSessionsApp(...)` for the session-shaped routes (in single mode mount on `/v1`; in multi mode mount on `/v1/projects/:projectId`).
- `src/openapi.ts` — mirror the new mounting structure so the published `openapi.json` matches the live server.
- `src/index.ts` — re-export `AgentCredentialsService`, `createCredentialsApp`, and the new thinking helpers.
- `test/server.test.ts` — adjust the embedded multi-mode test setup to mount `createCredentialsApp` separately, matching the new server.ts.

---

## Task 1: Add pi-ai dependency

**Files:**
- Modify: `package.json:25-32`

- [ ] **Step 1: Inspect current dependency versions**

Run: `cat package.json`
Expected output (relevant block):
```json
"dependencies": {
  "@earendil-works/pi-coding-agent": "0.75.4",
  ...
}
```

- [ ] **Step 2: Add pi-ai pinned to the same patch level**

Edit `package.json` to add `"@earendil-works/pi-ai": "0.75.4"` to the `dependencies` block, alphabetically before `pi-coding-agent`:

```json
"dependencies": {
  "@earendil-works/pi-ai": "0.75.4",
  "@earendil-works/pi-coding-agent": "0.75.4",
  "@hono/node-server": "^1.13.7",
  "@hono/swagger-ui": "^0.5.1",
  "@hono/zod-openapi": "^0.19.2",
  "hono": "^4.6.14",
  "zod": "^3.24.1"
}
```

- [ ] **Step 3: Install**

Run: `npm install`
Expected: package-lock.json updated, no errors.

- [ ] **Step 4: Verify the import resolves**

Run: `node -e "import('@earendil-works/pi-ai').then(m => console.log(typeof m.clampThinkingLevel, typeof m.getSupportedThinkingLevels))"`
Expected output: `function function`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add @earendil-works/pi-ai for shared thinking-level helpers"
```

---

## Task 2: Introduce src/thinking.ts as the single source of truth

**Files:**
- Create: `src/thinking.ts`
- Test: `test/thinking.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/thinking.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/thinking.test.ts`
Expected: FAIL with module not found `../src/thinking.js`.

- [ ] **Step 3: Write src/thinking.ts**

Create `src/thinking.ts` with this exact content:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/thinking.test.ts`
Expected: 5 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/thinking.ts test/thinking.test.ts
git commit -m "feat(thinking): add src/thinking.ts wrapping Pi's clamp helpers"
```

---

## Task 3: Migrate runtime.ts and litellm.ts to use src/thinking.ts

**Files:**
- Modify: `src/runtime.ts:45-47, 368-396, 1180-1187`
- Modify: `src/litellm.ts:60, 72, 240-263, 302, 390, 393, 454`

- [ ] **Step 1: Run baseline tests**

Run: `npm test`
Expected: all tests pass (record count for next step).

- [ ] **Step 2: Replace duplicated helpers in runtime.ts**

In `src/runtime.ts`:

a) Update the imports near the top — find the existing `export type ThinkingLevel = …` line (around line 45) and the `THINKING_LEVELS` const (line 47). Replace both, plus the local helpers `supportedThinkingLevelsForModel` (line 368) and `clampThinkingLevelForModel` (line 378), with imports.

After: top of file additions/replacements:

```ts
import {
  THINKING_LEVELS,
  type ThinkingLevel,
  clampThinkingLevelForModel,
  supportedThinkingLevelsForModel,
} from "./thinking.js";
```

b) Delete the local `THINKING_LEVELS` constant (originally line 47).

c) Delete `supportedThinkingLevelsForModel` (lines 368–376) and `clampThinkingLevelForModel` (lines 378–391) — they are now imported.

d) Update both `private`-method call sites (`defaultThinkingForModel` at line 393 and `setSessionModelInternal` at line 1180) to call the imported free functions instead of `this.supportedThinkingLevelsForModel(...)` / `this.clampThinkingLevelForModel(...)`. Example:

Before:
```ts
const nextAvailableLevels = this.supportedThinkingLevelsForModel(model);
```
After:
```ts
const nextAvailableLevels = supportedThinkingLevelsForModel(model);
```

e) Re-export `ThinkingLevel` for back-compat: at the bottom of the existing exports near the top of the file, change `export type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;` to `export type { ThinkingLevel } from "./thinking.js";`. (We keep the same surface so consumers don't have to update imports.)

- [ ] **Step 3: Replace duplicated helpers in litellm.ts**

In `src/litellm.ts`:

a) Add the import at the top, after the existing imports:

```ts
import {
  THINKING_LEVELS as SHARED_THINKING_LEVELS,
  clampThinkingLevelForModel,
  supportedThinkingLevelsForModel,
  type ThinkingLevel,
} from "./thinking.js";
```

b) Delete the local `THINKING_LEVELS` const (line 72) and the `supportedThinkingLevels` (lines 240–248) and `clampThinkingLevel` (lines 250–263) functions.

c) Replace **all** call sites of the deleted local helpers in this file:
- `THINKING_LEVELS.indexOf(level)` → `SHARED_THINKING_LEVELS.indexOf(level)` (lines around 253, 258 and elsewhere)
- `THINKING_LEVELS.filter(...)` → `SHARED_THINKING_LEVELS.filter(...)` 
- Standalone calls `supportedThinkingLevels(entry)` → `supportedThinkingLevelsForModel(entry)`
- Standalone calls `clampThinkingLevel(model, level)` → `clampThinkingLevelForModel(model, level)`
- The previously-existing usage `THINKING_LEVELS.join(", ")` for error messages should also use `SHARED_THINKING_LEVELS.join(", ")`.

d) Delete the local `import type { ... ThinkingLevel ... } from "./runtime.js";` if present (around line 9). Replace with the import in step (a).

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: same count as baseline, all green. Specifically the LiteLLM "applies preset compat" test should still pass — it asserts `compat?.supportsReasoningEffort === true`.

- [ ] **Step 6: Commit**

```bash
git add src/runtime.ts src/litellm.ts
git commit -m "refactor(thinking): replace duplicated clamp helpers with src/thinking.ts"
```

---

## Task 4: Scaffold AgentCredentialsService (constructor only)

**Files:**
- Create: `src/credentialsService.ts`
- Test: `test/credentialsService.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/credentialsService.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { AgentCredentialsService } from "../src/credentialsService.js";

function makeAgentDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(resolve(tmpdir(), "agent-server-creds-"));
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("AgentCredentialsService", () => {
  let agent: { dir: string; cleanup: () => void };

  before(() => {
    agent = makeAgentDir();
  });

  after(() => {
    agent.cleanup();
  });

  test("constructor requires authStorage and modelRegistry references", () => {
    const authStorage = AuthStorage.create(resolve(agent.dir, "auth.json"));
    const modelRegistry = ModelRegistry.create(authStorage, resolve(agent.dir, "models.json"));
    const service = new AgentCredentialsService({
      authStorage,
      modelRegistry,
      modelsJsonPath: resolve(agent.dir, "models.json"),
      logger: { log: () => {}, error: () => {} },
    });
    assert.equal(typeof service.listAuthProviders, "function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/credentialsService.test.ts`
Expected: FAIL with module not found `../src/credentialsService.js`.

- [ ] **Step 3: Write the minimal credentialsService.ts**

Create `src/credentialsService.ts`:

```ts
/**
 * AgentCredentialsService — process-global credential state.
 *
 * Owns AuthStorage, ModelRegistry, models.json CRUD, and the in-memory
 * OAuth subscription flow state machine. AgentRuntime instances hold a
 * reference for read-only projections (listModels, modelRow used in
 * session settings). Routes for /v1/auth/* and /v1/custom/* call this
 * directly via createCredentialsApp.
 */
import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

export type AgentCredentialsServiceConfig = {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  modelsJsonPath: string;
  logger?: Pick<Console, "log" | "error">;
};

export class AgentCredentialsService {
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly modelsJsonPath: string;
  private readonly logger: Pick<Console, "log" | "error">;

  constructor(config: AgentCredentialsServiceConfig) {
    this.authStorage = config.authStorage;
    this.modelRegistry = config.modelRegistry;
    this.modelsJsonPath = config.modelsJsonPath;
    this.logger = config.logger ?? console;
  }

  listAuthProviders(): never {
    throw new Error("not yet implemented");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/credentialsService.test.ts`
Expected: 1 passing test ("constructor requires authStorage and modelRegistry references").

- [ ] **Step 5: Commit**

```bash
git add src/credentialsService.ts test/credentialsService.test.ts
git commit -m "feat(credentials): scaffold AgentCredentialsService class"
```

---

## Task 5: Move listModels and modelRow into the credentials service

**Files:**
- Modify: `src/credentialsService.ts`
- Modify: `test/credentialsService.test.ts`

- [ ] **Step 1: Write a failing test**

Append to `test/credentialsService.test.ts` inside the `describe` block:

```ts
test("listModels returns Pi-shaped rows with availability flag", () => {
  const authStorage = AuthStorage.create(resolve(agent.dir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, resolve(agent.dir, "models.json"));
  authStorage.set("anthropic", { type: "api_key", key: "sk-ant-test" });
  modelRegistry.refresh();
  const service = new AgentCredentialsService({
    authStorage,
    modelRegistry,
    modelsJsonPath: resolve(agent.dir, "models.json"),
    logger: { log: () => {}, error: () => {} },
  });

  const models = service.listModels();
  const anthropic = models.find((m) => m.provider === "anthropic");
  assert.ok(anthropic, "expected at least one anthropic model");
  assert.equal(anthropic!.available, true);
  assert.equal(typeof anthropic!.contextWindow, "number");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/credentialsService.test.ts`
Expected: FAIL with `service.listModels is not a function`.

- [ ] **Step 3: Move types and methods from runtime.ts into credentialsService.ts**

In `src/credentialsService.ts`:

a) Add imports + helper types at the top:

```ts
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import {
  type ThinkingLevel,
  clampThinkingLevelForModel,
} from "./thinking.js";

type SessionModel = NonNullable<CreateAgentSessionOptions["model"]>;

export type AgentModelRow = {
  provider: string;
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  available: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  defaultThinkingLevel?: ThinkingLevel;
};
```

b) Extend `AgentCredentialsServiceConfig` to accept the optional thinking defaults that were previously on `AgentRuntimeConfig` (these are needed by the credentials-side `modelRow` projection):

```ts
export type AgentCredentialsServiceConfig = {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  modelsJsonPath: string;
  defaultModelProvider?: string;
  defaultModelId?: string;
  defaultThinkingLevel?: ThinkingLevel;
  modelThinkingDefaults?: Record<string, ThinkingLevel>;
  logger?: Pick<Console, "log" | "error">;
};
```

c) Store them as private fields in the constructor body (mirror the existing assignment pattern).

d) Add the methods. Replace the placeholder `listAuthProviders` with this body of methods:

```ts
private modelKey(model: Pick<SessionModel, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

defaultThinkingForModel(model: SessionModel): ThinkingLevel | undefined {
  const configured = this.modelThinkingDefaults[this.modelKey(model)] ?? this.defaultThinkingLevel;
  return configured ? clampThinkingLevelForModel(model, configured) : undefined;
}

modelRow(model: SessionModel): AgentModelRow {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    available: this.modelRegistry.hasConfiguredAuth(model),
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    defaultThinkingLevel: this.defaultThinkingForModel(model),
  };
}

listModels(): AgentModelRow[] {
  return this.modelRegistry
    .getAll()
    .map((model) => this.modelRow(model as SessionModel))
    .sort(
      (a, b) =>
        Number(b.available) - Number(a.available) ||
        a.provider.localeCompare(b.provider) ||
        a.name.localeCompare(b.name),
    );
}
```

(Keep `listAuthProviders` as a stub `throw new Error("not yet implemented")` — Task 6 fills it in.)

e) Initialise the new fields in the constructor:

```ts
private readonly defaultModelProvider: string | undefined;
private readonly defaultModelId: string | undefined;
private readonly defaultThinkingLevel: ThinkingLevel | undefined;
private readonly modelThinkingDefaults: Record<string, ThinkingLevel>;

constructor(config: AgentCredentialsServiceConfig) {
  this.authStorage = config.authStorage;
  this.modelRegistry = config.modelRegistry;
  this.modelsJsonPath = config.modelsJsonPath;
  this.logger = config.logger ?? console;
  this.defaultModelProvider = config.defaultModelProvider;
  this.defaultModelId = config.defaultModelId;
  this.defaultThinkingLevel = config.defaultThinkingLevel;
  this.modelThinkingDefaults = config.modelThinkingDefaults ?? {};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test test/credentialsService.test.ts`
Expected: 2 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/credentialsService.ts test/credentialsService.test.ts
git commit -m "feat(credentials): add listModels + modelRow projection"
```

---

## Task 6: Move listAuthProviders, setProviderApiKey, removeProviderCredential

**Files:**
- Modify: `src/credentialsService.ts`
- Modify: `test/credentialsService.test.ts`

- [ ] **Step 1: Write a failing test**

Append to the `describe` block in `test/credentialsService.test.ts`:

```ts
test("setProviderApiKey persists, listAuthProviders shows configured, removeProviderCredential clears", () => {
  const authStorage = AuthStorage.create(resolve(agent.dir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, resolve(agent.dir, "models.json"));
  const service = new AgentCredentialsService({
    authStorage,
    modelRegistry,
    modelsJsonPath: resolve(agent.dir, "models.json"),
    logger: { log: () => {}, error: () => {} },
  });

  service.setProviderApiKey("anthropic", "sk-ant-test");
  let providers = service.listAuthProviders();
  let anthropic = providers.find((p) => p.provider === "anthropic");
  assert.equal(anthropic?.configured, true);
  assert.equal(anthropic?.source, "stored");

  service.removeProviderCredential("anthropic");
  providers = service.listAuthProviders();
  anthropic = providers.find((p) => p.provider === "anthropic");
  // remaining anthropic row reflects no stored credential
  assert.notEqual(anthropic?.source, "stored");
});

test("setProviderApiKey rejects malformed provider id", () => {
  const authStorage = AuthStorage.create(resolve(agent.dir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, resolve(agent.dir, "models.json"));
  const service = new AgentCredentialsService({
    authStorage,
    modelRegistry,
    modelsJsonPath: resolve(agent.dir, "models.json"),
    logger: { log: () => {}, error: () => {} },
  });
  assert.throws(() => service.setProviderApiKey("bad provider!", "k"), /invalid provider id/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/credentialsService.test.ts`
Expected: FAIL with `service.setProviderApiKey is not a function`.

- [ ] **Step 3: Move methods from runtime.ts to credentialsService.ts**

In `src/credentialsService.ts`, add the new types and methods:

```ts
export type AgentAuthProviderRow = {
  provider: string;
  name: string;
  configured: boolean;
  credentialType?: "api_key" | "oauth";
  source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
  label?: string;
  supportsApiKey: boolean;
  supportsSubscription: boolean;
  modelCount: number;
  availableModelCount: number;
};

private assertProviderId(provider: string): void {
  if (!/^[a-zA-Z0-9_.:-]+$/.test(provider)) {
    throw new Error("invalid provider id");
  }
}

listAuthProviders(): AgentAuthProviderRow[] {
  const byProvider = new Map<string, { modelCount: number; availableModelCount: number }>();
  for (const model of this.listModels()) {
    const current = byProvider.get(model.provider) ?? { modelCount: 0, availableModelCount: 0 };
    current.modelCount += 1;
    if (model.available) current.availableModelCount += 1;
    byProvider.set(model.provider, current);
  }
  const oauthProviderIds = new Set(this.authStorage.getOAuthProviders().map((provider) => provider.id));
  for (const provider of oauthProviderIds) {
    if (!byProvider.has(provider)) {
      byProvider.set(provider, { modelCount: 0, availableModelCount: 0 });
    }
  }
  return [...byProvider.entries()]
    .map(([provider, counts]) => {
      const status = this.modelRegistry.getProviderAuthStatus(provider);
      const credential = this.authStorage.get(provider);
      return {
        provider,
        name: this.modelRegistry.getProviderDisplayName(provider),
        configured: status.configured || status.source !== undefined,
        credentialType: credential?.type,
        source: status.source,
        label: status.label,
        supportsApiKey: counts.modelCount > 0,
        supportsSubscription: oauthProviderIds.has(provider),
        ...counts,
      };
    })
    .sort(
      (a, b) =>
        Number(b.configured) - Number(a.configured) ||
        b.availableModelCount - a.availableModelCount ||
        a.provider.localeCompare(b.provider),
    );
}

setProviderApiKey(provider: string, key: string): void {
  this.assertProviderId(provider);
  const trimmed = key.trim();
  if (!trimmed) throw new Error("key is required");
  this.authStorage.set(provider, { type: "api_key", key: trimmed });
  this.modelRegistry.refresh();
}

removeProviderCredential(provider: string): void {
  this.assertProviderId(provider);
  this.authStorage.remove(provider);
  this.modelRegistry.refresh();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test test/credentialsService.test.ts`
Expected: 4 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/credentialsService.ts test/credentialsService.test.ts
git commit -m "feat(credentials): move listAuthProviders + provider key CRUD"
```

---

## Task 7: Move OAuth subscription flow state machine

**Files:**
- Modify: `src/credentialsService.ts`
- Modify: `test/credentialsService.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe` block in `test/credentialsService.test.ts`:

```ts
test("startProviderSubscriptionLogin reuses an active flow", async () => {
  let loginCalls = 0;
  const authStorage = AuthStorage.create(resolve(agent.dir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, resolve(agent.dir, "models.json"));
  modelRegistry.registerProvider("test-reuse", {
    name: "Test Reuse",
    baseUrl: "https://example.test/v1",
    api: "openai-completions",
    oauth: {
      name: "Test Reuse",
      login: async (callbacks: any) => {
        loginCalls += 1;
        callbacks.onAuth?.({ url: "https://login.example.test/", instructions: "x" });
        await callbacks.onManualCodeInput?.();
        return { access: "tok", refresh: "rfr", expires: Date.now() + 60_000 };
      },
      refreshToken: async (c: any) => c,
      getApiKey: (c: any) => c.access,
    },
    models: [
      { id: "m", name: "M", api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024 },
    ],
  });

  const service = new AgentCredentialsService({
    authStorage,
    modelRegistry,
    modelsJsonPath: resolve(agent.dir, "models.json"),
    logger: { log: () => {}, error: () => {} },
  });

  const first = await service.startProviderSubscriptionLogin("test-reuse");
  const second = await service.startProviderSubscriptionLogin("test-reuse");
  assert.equal(second.id, first.id);
  assert.equal(loginCalls, 1);

  const cancelled = service.cancelProviderSubscriptionLogin(first.id);
  assert.equal(cancelled?.status, "cancelled");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/credentialsService.test.ts`
Expected: FAIL with `service.startProviderSubscriptionLogin is not a function`.

- [ ] **Step 3: Move OAuth flow code from runtime.ts to credentialsService.ts**

a) Add the OAuth-related types (these are *unchanged* from `runtime.ts`):

```ts
export type AgentAuthPrompt = {
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
};

export type AgentOAuthFlowState = {
  id: string;
  provider: string;
  providerName: string;
  status: "starting" | "prompt" | "auth" | "waiting" | "complete" | "error" | "cancelled";
  authUrl?: string;
  instructions?: string;
  prompt?: AgentAuthPrompt;
  progress: string[];
  error?: string;
  expiresAt: string;
};

type PendingOAuthFlow = AgentOAuthFlowState & {
  version: number;
  abortController: AbortController;
  promptResolve?: (value: string) => void;
  promptReject?: (error: Error) => void;
  manualResolve?: (value: string) => void;
  manualReject?: (error: Error) => void;
  waiters: Array<(state: AgentOAuthFlowState) => void>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};
```

b) Add `import { randomUUID } from "node:crypto";` to the file imports.

c) Add the private map field:

```ts
private readonly pendingOAuthFlows = new Map<string, PendingOAuthFlow>();
```

d) Move these methods verbatim from `src/runtime.ts:869–1062` (with `private` access kept where they were private):
- `oauthFlowState`
- `updateOAuthFlow`
- `scheduleOAuthFlowCleanup`
- `activeOAuthFlowForProvider`
- `oauthLoginErrorMessage`
- `waitForOAuthFlowUpdate`
- `startProviderSubscriptionLogin`
- `continueProviderSubscriptionLogin`
- `getProviderSubscriptionLogin`
- `cancelProviderSubscriptionLogin`

These bodies are unchanged. Public methods stay public; helpers stay private. (The plan requires the engineer to literally cut from one file and paste; do not edit logic.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test test/credentialsService.test.ts`
Expected: 5 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/credentialsService.ts test/credentialsService.test.ts
git commit -m "feat(credentials): move OAuth subscription flow state machine"
```

---

## Task 8: Move custom-provider models.json CRUD

**Files:**
- Modify: `src/credentialsService.ts`
- Modify: `test/credentialsService.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe` block in `test/credentialsService.test.ts`:

```ts
test("upsertCustomProvider writes models.json with 0600 perms and registers in ModelRegistry", () => {
  const authStorage = AuthStorage.create(resolve(agent.dir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, resolve(agent.dir, "models.json"));
  const service = new AgentCredentialsService({
    authStorage,
    modelRegistry,
    modelsJsonPath: resolve(agent.dir, "models.json"),
    logger: { log: () => {}, error: () => {} },
  });

  const row = service.upsertCustomProvider({
    provider: "litellm-test",
    name: "LiteLLM Test",
    baseUrl: "http://litellm.test/v1",
    api: "openai-completions",
    apiKey: "test-secret",
    models: [
      { id: "test-model", name: "Test", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 1024 },
    ],
  });
  assert.equal(row.provider, "litellm-test");
  assert.equal(row.apiKeyConfigured, true);
  assert.equal(row.modelCount, 1);

  const listed = service.listCustomProviders();
  assert.ok(listed.some((p) => p.provider === "litellm-test"));

  service.removeCustomProvider("litellm-test");
  assert.equal(service.listCustomProviders().some((p) => p.provider === "litellm-test"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/credentialsService.test.ts`
Expected: FAIL with `service.upsertCustomProvider is not a function`.

- [ ] **Step 3: Move custom-provider code into credentialsService.ts**

a) Add the types (unchanged from `runtime.ts`):

```ts
const CUSTOM_PROVIDER_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type AgentCustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number];

export type AgentCustomProviderModel = {
  id: string;
  name?: string;
  api?: AgentCustomProviderApi;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
};

export type AgentCustomProviderRow = {
  provider: string;
  name?: string;
  baseUrl?: string;
  api?: AgentCustomProviderApi;
  apiKeyConfigured: boolean;
  modelCount: number;
  models: AgentCustomProviderModel[];
};

export type UpsertCustomProviderRequest = {
  provider: string;
  name?: string;
  baseUrl: string;
  api: AgentCustomProviderApi;
  apiKey?: string;
  models: AgentCustomProviderModel[];
};
```

b) Add `chmodSync, existsSync, readFileSync, writeFileSync` to the existing `node:fs` import (currently has none — add the import).

c) Move these methods *verbatim* from `runtime.ts:1064–1170`:
- `customProviderApi` (private)
- `readModelsJson` (private)
- `writeModelsJson` (private)
- `listCustomProviders` (public)
- `upsertCustomProvider` (public)
- `removeCustomProvider` (public)

The bodies are unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test test/credentialsService.test.ts`
Expected: 6 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/credentialsService.ts test/credentialsService.test.ts
git commit -m "feat(credentials): move custom-provider models.json CRUD"
```

---

## Task 9: Update AgentRuntimeRegistry to construct + share AgentCredentialsService

**Files:**
- Modify: `src/runtimeRegistry.ts:1-121`
- Modify: `src/runtime.ts` (constructor signature)

- [ ] **Step 1: Run baseline**

Run: `npm test`
Expected: passes (record any deltas).

- [ ] **Step 2: Add credentials field to AgentRuntimeRegistry**

In `src/runtimeRegistry.ts`:

a) Update imports:

```ts
import { AgentCredentialsService } from "./credentialsService.js";
```

b) Add a public field `readonly credentials: AgentCredentialsService;` next to `readonly defaultRuntime: AgentRuntime;`.

c) After constructing `this.modelRegistry` in the constructor, add:

```ts
this.credentials = new AgentCredentialsService({
  authStorage: this.authStorage,
  modelRegistry: this.modelRegistry,
  modelsJsonPath: agentDir
    ? join(agentDir, "models.json")
    : join(this.config.projectDir, "models.json"),
  defaultModelProvider: this.config.defaultModelProvider,
  defaultModelId: this.config.defaultModelId,
  defaultThinkingLevel: this.config.defaultThinkingLevel,
  modelThinkingDefaults: this.config.modelThinkingDefaults,
  logger: this.config.logger,
});
```

(`join` from `node:path` is already imported.)

d) Pass the service into every `AgentRuntime` via the existing `createRuntime` factory. In `createRuntime`, add `credentials: this.credentials,` to the `new AgentRuntime({ … })` call.

- [ ] **Step 3: Update AgentRuntime constructor**

In `src/runtime.ts`:

a) Extend `AgentRuntimeConfig` with a required field:

```ts
/** Process-global credentials service shared with sibling runtimes. */
credentials: AgentCredentialsService;
```

b) Add the import: `import { AgentCredentialsService } from "./credentialsService.js";`

c) Store in a private field: `private readonly credentials: AgentCredentialsService;`. Assign in constructor.

d) **Do not yet remove** the in-runtime credential code in this task. We'll do that in Task 10 once the routes also point at the service.

- [ ] **Step 4: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: same baseline pass count.

- [ ] **Step 6: Commit**

```bash
git add src/runtimeRegistry.ts src/runtime.ts
git commit -m "feat(registry): construct shared AgentCredentialsService and inject into runtimes"
```

---

## Task 10: Add createCredentialsApp; route credentials through it; deprecate credentialRoutes flag

**Files:**
- Modify: `src/routes.ts`
- Modify: `src/schemas.ts` (no change expected — re-confirm)
- Modify: `src/server.ts`
- Modify: `src/openapi.ts`
- Modify: `test/server.test.ts`

- [ ] **Step 1: Add createCredentialsApp factory**

In `src/routes.ts`, add a new export *after* `createSessionsApp`:

```ts
export type AgentCredentialsResolver = (c: Context) => AgentCredentialsService | Promise<AgentCredentialsService>;

export type CreateCredentialsAppOptions = {
  healthRoute?: boolean;
};

export function createCredentialsApp(
  credentials: AgentCredentialsService | AgentCredentialsResolver,
  options: CreateCredentialsAppOptions = {},
): OpenAPIHono {
  const app = new OpenAPIHono();
  const healthRoute = options.healthRoute ?? true;
  const getCredentials = (c: Context) =>
    typeof credentials === "function" ? credentials(c) : credentials;

  // Move every existing /auth/* and /custom/* route here, replacing
  // `runtime.foo(...)` calls with `(await getCredentials(c)).foo(...)`.
  // Move the GET /sessions/models route here too — it returns shared models.
  // Move GET /healthz here when healthRoute=true.

  // ... full route bodies copied 1:1 from createSessionsApp ...

  return app;
}
```

a) Move every credential route from `createSessionsApp` (`routes.ts:165–467` plus `/healthz` and `/sessions/models`) into `createCredentialsApp`. Adjust handlers from `runtime.listAuthProviders()` to `(await getCredentials(c)).listAuthProviders()`, etc.

b) **Important:** `/sessions/models` belongs to credentials (it's a projection of the shared registry), so move it too. The path stays `/sessions/models` for back-compat in single mode. In multi mode it remains under `/v1` (mounted via `createCredentialsApp`).

c) Delete the moved routes from `createSessionsApp`. Remove the `credentialRoutes` and `healthRoute` flags from `CreateSessionsAppOptions` (now session-only). Keep `sessionRoutes` *only if* `createSessionsApp` is still used for cases where session routes need to be off — otherwise remove it entirely. (For cleanup: in this codebase `sessionRoutes: false` was only used to suppress the credential routes that are now in a different app, so it's safe to remove.)

d) Update `createSessionsApp` signature to no longer take options:

```ts
export function createSessionsApp(runtime: AgentRuntime | AgentRuntimeResolver): OpenAPIHono {
  const app = new OpenAPIHono();
  // ... (existing session routes only)
  return app;
}
```

- [ ] **Step 2: Update server.ts to mount credentials and sessions independently**

In `src/server.ts`:

a) Import `createCredentialsApp` from `./routes.js`.

b) Replace the `if (mode === "single") { ... } else { ... }` block (lines 179–190) with:

```ts
root.route("/v1", createCredentialsApp(runtimeRegistry.credentials));
if (mode === "single") {
  root.route("/v1", createSessionsApp(runtimeRegistry.defaultRuntime));
} else {
  root.route("/v1/projects/:projectId", createSessionsApp(projectRuntimeFromRequest));
}
```

- [ ] **Step 3: Update openapi.ts to mirror server.ts**

In `src/openapi.ts`, replace the mounting block (lines 33–44) with the same structure as `server.ts`. The stub uses a fresh `AgentRuntimeRegistry` to obtain `credentials`:

```ts
import { AgentRuntimeRegistry } from "./runtimeRegistry.js";

const stubProjectDir = resolve(process.cwd());
const registry = new AgentRuntimeRegistry({
  projectDir: stubProjectDir,
  sessionsDir: resolve(stubProjectDir, ".tmp-openapi-sessions"),
  defaultAgentsFile: false,
  logger: { log: () => {}, error: () => {} },
});

const root = new OpenAPIHono();
root.route("/v1", createCredentialsApp(registry.credentials));
if (mode === "single") {
  root.route("/v1", createSessionsApp(registry.defaultRuntime));
} else {
  root.route("/v1/projects/:projectId", createSessionsApp(registry.defaultRuntime));
}
```

- [ ] **Step 4: Update server.test.ts multi-mode test setup**

In `test/server.test.ts`, update the two project-scoped describe-block tests so they mount the new app structure. The single-mode `startServer` helper changes:

```ts
const root = new OpenAPIHono();
if (opts.token) {
  root.use("/v1/*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (presented !== opts.token) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
}
const registry = new AgentRuntimeRegistry({
  projectDir: opts.projectDir,
  sessionsDir: resolve(opts.projectDir, "data/sessions"),
  agentDir: resolve(opts.projectDir, ".pi-agent"),
  agentsFile: ".pi/AGENTS.md",
  logger: { log: () => {}, error: () => {} },
  ...(opts.runtimeConfig ?? {}),
});
root.route("/v1", createCredentialsApp(registry.credentials));
root.route("/v1", createSessionsApp(registry.defaultRuntime));
```

(Drop the direct `new AgentRuntime` construction — the registry covers it. The optional `runtimeConfig` field still flows through if present, since `AgentRuntimeRegistryConfig` extends `AgentRuntimeConfig`.)

The "project-scoped runtimes" describe block updates similarly: replace any explicit `{ sessionRoutes: false }` / `{ credentialRoutes: false }` toggles with the new mount structure.

- [ ] **Step 5: Run tests to verify routes still answer correctly**

Run: `npm test`
Expected: existing assertions in `server.test.ts` continue to pass — `GET /v1/auth/providers`, `PUT /v1/auth/providers/anthropic/api-key`, etc., all still work because we only changed where the routes are *mounted from*, not the URL paths.

- [ ] **Step 6: Commit**

```bash
git add src/routes.ts src/server.ts src/openapi.ts test/server.test.ts
git commit -m "refactor(routes): split credentials routes into createCredentialsApp"
```

---

## Task 11: Delete duplicated credential code from AgentRuntime; route session settings through credentials.modelRow

**Files:**
- Modify: `src/runtime.ts`

- [ ] **Step 1: Delete moved code from runtime.ts**

In `src/runtime.ts`, delete the now-redundant code:

a) Types: delete `AgentModelRow`, `AgentAuthProviderRow`, `AgentAuthPrompt`, `AgentOAuthFlowState`, `AgentCustomProviderApi`, `AgentCustomProviderModel`, `AgentCustomProviderRow`, `UpsertCustomProviderRequest`, the `CUSTOM_PROVIDER_APIS` constant, and the `PendingOAuthFlow` type. Re-export them from `./credentialsService.js` at the bottom of the file for back-compat:

```ts
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
```

b) Methods: delete `modelKey` (private), `defaultThinkingForModel` (private), `modelRow` (private), `listModels`, `listAuthProviders`, `setProviderApiKey`, `removeProviderCredential`, `assertProviderId`, `customProviderApi`, `oauthFlowState`, `updateOAuthFlow`, `scheduleOAuthFlowCleanup`, `activeOAuthFlowForProvider`, `oauthLoginErrorMessage`, `waitForOAuthFlowUpdate`, `startProviderSubscriptionLogin`, `continueProviderSubscriptionLogin`, `getProviderSubscriptionLogin`, `cancelProviderSubscriptionLogin`, `readModelsJson`, `writeModelsJson`, `listCustomProviders`, `upsertCustomProvider`, `removeCustomProvider`. Also delete the `pendingOAuthFlows` field.

c) Update `sessionModelSettings` (around line 414) to delegate to credentials:

```ts
private sessionModelSettings(session: AgentSession): SessionModelSettings {
  return {
    model: session.model ? this.credentials.modelRow(session.model as SessionModel) : null,
    thinkingLevel: session.thinkingLevel as ThinkingLevel,
    availableThinkingLevels: session.getAvailableThinkingLevels() as ThinkingLevel[],
    supportsThinking: session.supportsThinking(),
    isStreaming: session.isStreaming,
  };
}
```

d) Update `sessionModelDefaults` to use `this.credentials.defaultThinkingForModel(model)` instead of the local helper.

e) Remove unused imports: `chmodSync`, `existsSync`, `readFileSync`, `writeFileSync`, `randomUUID` (verify with the lint step that they're truly unused).

- [ ] **Step 2: TypeScript compile**

Run: `npx tsc --noEmit`
Expected: no errors. If there are unused-import warnings, remove them.

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/runtime.ts
git commit -m "refactor(runtime): drop credential code now provided by AgentCredentialsService"
```

---

## Task 12: Update src/index.ts public exports

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update re-exports**

In `src/index.ts`:

a) Add credentials service exports:

```ts
export { AgentCredentialsService } from "./credentialsService.js";
export type {
  AgentCredentialsServiceConfig,
} from "./credentialsService.js";
export { createCredentialsApp } from "./routes.js";
export type { AgentCredentialsResolver, CreateCredentialsAppOptions } from "./routes.js";
```

b) Add thinking helper exports:

```ts
export { THINKING_LEVELS, clampThinkingLevelForModel, supportedThinkingLevelsForModel } from "./thinking.js";
```

c) The runtime type re-exports remain valid because `runtime.ts` re-exports them from `credentialsService.ts` (Task 11 step 1a).

- [ ] **Step 2: TypeScript compile**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: all green.

- [ ] **Step 4: Regenerate openapi.json and confirm it matches expected**

Run: `npm run openapi`
Expected: `openapi.json` rewritten. Eyeball that:
- `/v1/auth/providers`, `/v1/sessions/models`, `/v1/healthz` are still present (single mode default).
- `/v1/sessions` and `/v1/sessions/{id}/...` still present.
- `/v1/projects/...` paths only when `AGENT_SERVER_MODE=multi` is set.

Run: `git diff openapi.json`
Expected: ideally empty diff. If there are differences, they should be limited to: routes that moved between `tags` (e.g., the `models` tag now living under credentials) — *not* path changes. If a path is missing, that's a bug to fix in routes.ts.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts openapi.json
git commit -m "chore(exports): re-export credentials service and thinking helpers"
```

---

## Task 13: Sweep dead code, run full smoke

**Files:**
- Sweep: `src/`

- [ ] **Step 1: Confirm there are no unused exports/types**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: all suites green; `agent-server: REST surface`, `agent-server: project-scoped runtimes`, `agent-server: bearer auth seam`, `agent-server: SSE`, `agent-server: LiteLLM config`, plus the new `AgentCredentialsService` and `thinking helpers` blocks all pass.

- [ ] **Step 3: Manual smoke — start the server in single mode**

Run (in a separate terminal): `PROJECT_DIR=$(pwd) npm run dev`
Then in this terminal:
```bash
curl -s http://127.0.0.1:4001/v1/healthz | head -c 200
curl -s http://127.0.0.1:4001/v1/auth/providers | head -c 400
curl -s http://127.0.0.1:4001/v1/sessions/models | head -c 400
curl -s -X POST http://127.0.0.1:4001/v1/sessions | head -c 200
```
Expected: `200` for each, no 5xx, JSON shapes match the OpenAPI doc.

- [ ] **Step 4: Manual smoke — start the server in multi mode**

Stop the previous dev server, then:
```bash
AGENT_SERVER_MODE=multi PROJECT_DIR=$(pwd) npm run dev
```
In this terminal:
```bash
curl -s http://127.0.0.1:4001/v1/healthz
curl -s http://127.0.0.1:4001/v1/auth/providers
curl -s http://127.0.0.1:4001/v1/sessions  # expect 404 — sessions not mounted
curl -s -X POST -H "X-Appx-Project-Dir: $(pwd)" http://127.0.0.1:4001/v1/projects/test/sessions
curl -s -H "X-Appx-Project-Dir: $(pwd)" http://127.0.0.1:4001/v1/projects/test/sessions
```
Expected: credentials respond on `/v1`; bare `/v1/sessions` returns 404; project-scoped `/v1/projects/test/sessions` works.

Stop the dev server.

- [ ] **Step 5: Commit (if anything moved during the sweep)**

```bash
# only if files changed during sweep
git status
git add -p
git commit -m "chore: post-refactor cleanup"
```

If the working tree is clean, skip the commit.

---

## Self-Review Notes

- **Spec coverage:** Every item from the discussed scope is mapped to a task — pi-ai dep (1), thinking dedup (2–3), credentials scaffold (4), listModels/modelRow (5), auth-providers + key CRUD (6), OAuth flow (7), custom providers (8), registry wiring (9), route split (10), runtime cleanup (11), exports (12), sweep (13). The OpenAPI surface is preserved by keeping all paths under the same URL prefixes.
- **Placeholder scan:** No "TBD" / "implement later" instructions; every "move method X" step lists the source line range to copy from.
- **Type consistency:** `AgentModelRow`, `AgentAuthProviderRow`, `AgentOAuthFlowState`, etc. retain their wire shapes; the only new types are `AgentCredentialsServiceConfig`, `AgentCredentialsResolver`, `CreateCredentialsAppOptions`. Pi types (`Model`, `Api`, `AuthStorage`, `ModelRegistry`) come straight from `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai`.
- **Risk callouts:**
  - Task 7 ("move OAuth flow code verbatim") is the largest cut/paste step. The bodies are unchanged — verify by running the existing OAuth tests in `server.test.ts` plus the new reuse test in `credentialsService.test.ts`.
  - Task 10 (route split) changes which app handles each path but keeps URLs. The `npm run openapi` step in Task 12 is the smoke check that the contract didn't drift.
  - Task 11 deletes ~700 lines from `runtime.ts`. If anything was missed, TypeScript will scream because the deleted method names are no longer reachable. Trust `tsc --noEmit`.
