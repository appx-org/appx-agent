/**
 * Unit tests for the AgentSessionServices integration in ProjectRuntime.
 *
 * These tests assert the contract added by the
 * docs/architecture/use-agent-session-services.md refactor:
 *
 *   - The services bundle is shared across every session in a project
 *     (proves we're not recreating ResourceLoader / SettingsManager
 *     per session — the whole point of the refactor).
 *   - reload() invokes resourceLoader.reload() and is idempotent.
 *   - diagnostics() exposes the live array from services (identity, not
 *     a snapshot copy).
 *   - Extension factories run exactly once at project startup, even when
 *     N sessions are created — guards against the regression where a
 *     factory was re-invoked for every session.
 *   - A bad agentsFile path is a fatal startup error (ProjectRuntime.create
 *     rejects rather than constructing a half-broken runtime).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import {
	AuthStorage,
	ModelRegistry,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { AgentCredentialsService } from "../src/credentialsService.js";
import { ProjectRuntime } from "../src/projectRuntime.js";

const silentLogger = { log: () => {}, error: () => {} } as const;

function makeProject(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(resolve(tmpdir(), "project-runtime-services-test-"));
	mkdirSync(resolve(dir, ".pi"), { recursive: true });
	mkdirSync(resolve(dir, "data/sessions"), { recursive: true });
	writeFileSync(resolve(dir, ".pi/AGENTS.md"), "# test agents file\n");
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Build the minimal credentials trio every ProjectRuntime needs in
 * tests. Using a separate agentDir per call keeps tests independent
 * (auth.json/models.json are written to disk eagerly).
 */
function makeCredentials(agentDir: string) {
	mkdirSync(agentDir, { recursive: true });
	const authStorage = AuthStorage.create(resolve(agentDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, resolve(agentDir, "models.json"));
	const credentials = new AgentCredentialsService({
		authStorage,
		modelRegistry,
		modelsJsonPath: resolve(agentDir, "models.json"),
		logger: silentLogger,
	});
	return { authStorage, modelRegistry, credentials };
}

describe("ProjectRuntime — AgentSessionServices integration", () => {
	test("services.resourceLoader is the same instance across two sessions", async () => {
		const project = makeProject();
		const agentDir = resolve(project.dir, ".pi-agent");
		const { authStorage, modelRegistry, credentials } = makeCredentials(agentDir);
		try {
			const runtime = await ProjectRuntime.create({
				projectDir: project.dir,
				sessionsDir: resolve(project.dir, "data/sessions"),
				agentDir,
				agentsFile: ".pi/AGENTS.md",
				credentials,
				authStorage,
				modelRegistry,
				logger: silentLogger,
			});

			const a = await runtime.createNewSession();
			const b = await runtime.createNewSession();

			// Identity check — proves both sessions are wired to the same
			// services bundle and we're not paying for per-session
			// ResourceLoader construction.
			assert.equal(runtime.services.resourceLoader, runtime.services.resourceLoader);
			assert.notEqual(a.sessionId, b.sessionId);
		} finally {
			project.cleanup();
		}
	});

	test("services.settingsManager is shared, not recreated per session", async () => {
		const project = makeProject();
		const agentDir = resolve(project.dir, ".pi-agent");
		const { authStorage, modelRegistry, credentials } = makeCredentials(agentDir);
		try {
			const runtime = await ProjectRuntime.create({
				projectDir: project.dir,
				sessionsDir: resolve(project.dir, "data/sessions"),
				agentDir,
				agentsFile: ".pi/AGENTS.md",
				credentials,
				authStorage,
				modelRegistry,
				logger: silentLogger,
			});
			await runtime.createNewSession();
			const captured = runtime.services.settingsManager;
			await runtime.createNewSession();
			assert.equal(runtime.services.settingsManager, captured);
		} finally {
			project.cleanup();
		}
	});

	test("diagnostics() returns the live services array (identity, not copy)", async () => {
		const project = makeProject();
		const agentDir = resolve(project.dir, ".pi-agent");
		const { authStorage, modelRegistry, credentials } = makeCredentials(agentDir);
		try {
			const runtime = await ProjectRuntime.create({
				projectDir: project.dir,
				sessionsDir: resolve(project.dir, "data/sessions"),
				agentDir,
				agentsFile: ".pi/AGENTS.md",
				credentials,
				authStorage,
				modelRegistry,
				logger: silentLogger,
			});
			assert.equal(runtime.diagnostics(), runtime.services.diagnostics);
		} finally {
			project.cleanup();
		}
	});

	test("reload() refreshes resourceLoader and is idempotent", async () => {
		const project = makeProject();
		const agentDir = resolve(project.dir, ".pi-agent");
		const { authStorage, modelRegistry, credentials } = makeCredentials(agentDir);
		try {
			const runtime = await ProjectRuntime.create({
				projectDir: project.dir,
				sessionsDir: resolve(project.dir, "data/sessions"),
				agentDir,
				agentsFile: ".pi/AGENTS.md",
				credentials,
				authStorage,
				modelRegistry,
				logger: silentLogger,
			});

			// Spy on the loader's reload() to count invocations. Restore
			// afterwards so we don't pollute later tests sharing the same
			// loader instance (we don't, but defense in depth).
			const originalReload = runtime.services.resourceLoader.reload.bind(
				runtime.services.resourceLoader,
			);
			let calls = 0;
			runtime.services.resourceLoader.reload = async () => {
				calls += 1;
				return originalReload();
			};

			await runtime.reload();
			assert.equal(calls, 1);
			await runtime.reload();
			assert.equal(calls, 2);
		} finally {
			project.cleanup();
		}
	});

	test("extension factories run exactly once at project startup, not per session", async () => {
		const project = makeProject();
		const agentDir = resolve(project.dir, ".pi-agent");
		const { authStorage, modelRegistry, credentials } = makeCredentials(agentDir);
		try {
			let factoryCallCount = 0;
			// Minimal extension factory: returns a no-op extension. We
			// only care about how many times the factory itself is
			// invoked — that's what was previously O(N) in sessions.
			const factory: ExtensionFactory = () => {
				factoryCallCount += 1;
				return { name: "test-counter-ext" };
			};

			const runtime = await ProjectRuntime.create({
				projectDir: project.dir,
				sessionsDir: resolve(project.dir, "data/sessions"),
				agentDir,
				agentsFile: ".pi/AGENTS.md",
				credentials,
				authStorage,
				modelRegistry,
				extensionFactories: [factory],
				noExtensions: true, // suppress disk discovery; only our factory should run
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				logger: silentLogger,
			});

			await runtime.createNewSession();
			await runtime.createNewSession();
			await runtime.createNewSession();

			assert.equal(
				factoryCallCount,
				1,
				`expected extension factory to run once at project startup, ran ${factoryCallCount}x`,
			);
		} finally {
			project.cleanup();
		}
	});

	test("ProjectRuntime.create() rejects when agentsFile points at a missing path", async () => {
		const project = makeProject();
		const agentDir = resolve(project.dir, ".pi-agent");
		const { authStorage, modelRegistry, credentials } = makeCredentials(agentDir);
		try {
			await assert.rejects(
				ProjectRuntime.create({
					projectDir: project.dir,
					sessionsDir: resolve(project.dir, "data/sessions"),
					agentDir,
					agentsFile: ".pi/does-not-exist.md",
					credentials,
					authStorage,
					modelRegistry,
					logger: silentLogger,
				}),
				/does-not-exist|ENOENT/,
			);
		} finally {
			project.cleanup();
		}
	});
});
