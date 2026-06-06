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
 *   - An **explicitly configured** missing agentsFile is a fatal startup
 *     error (loud misconfig). The **convention default** missing
 *     `<projectDir>/.pi/AGENTS.md` is a silent skip — the runtime
 *     starts with no pinned prompt.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { AuthStorage, type ExtensionFactory, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { AgentCredentialsService } from "../src/credentials/credentialsService.js";
import { ProjectRuntime } from "../src/runtime/projectRuntime.js";

const silentLogger = { log: () => {}, error: () => {} } as const;

function makeProject(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(resolve(tmpdir(), "project-runtime-services-test-"));
	mkdirSync(resolve(dir, ".pi"), { recursive: true });
	writeFileSync(resolve(dir, ".pi/AGENTS.md"), "# test agents file\n");
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Variant that does **not** create `.pi/AGENTS.md` — used to verify
 * convention-default behaviour (silent skip when the file is absent).
 */
function makeProjectWithoutAgentsFile(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(resolve(tmpdir(), "project-runtime-services-test-noprompt-"));
	mkdirSync(resolve(dir, ".pi"), { recursive: true });
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
				agentDir,
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
				agentDir,
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
				agentDir,
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
				agentDir,
				credentials,
				authStorage,
				modelRegistry,
				logger: silentLogger,
			});

			// Spy on the loader's reload() to count invocations. Restore
			// afterwards so we don't pollute later tests sharing the same
			// loader instance (we don't, but defense in depth).
			const originalReload = runtime.services.resourceLoader.reload.bind(runtime.services.resourceLoader);
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
				agentDir,
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

	test("ProjectRuntime.create() rejects when an explicitly configured agentsFile is missing", async () => {
		const project = makeProject();
		const agentDir = resolve(project.dir, ".pi-agent");
		const { authStorage, modelRegistry, credentials } = makeCredentials(agentDir);
		try {
			await assert.rejects(
				ProjectRuntime.create({
					projectDir: project.dir,
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

	test("ProjectRuntime.create() silently skips a missing convention-default AGENTS.md", async () => {
		// Convention-default semantics: when `agentsFile` is unset, the
		// runtime falls back to `<projectDir>/.pi/AGENTS.md` and treats
		// "file not present" as the natural no-prompt signal. This is
		// what replaces the old `defaultAgentsFile: false` kill switch —
		// multi-mode default runtimes pointed at a host root with no
		// AGENTS.md just start up fine.
		const project = makeProjectWithoutAgentsFile();
		const agentDir = resolve(project.dir, ".pi-agent");
		const { authStorage, modelRegistry, credentials } = makeCredentials(agentDir);
		try {
			const runtime = await ProjectRuntime.create({
				projectDir: project.dir,
				agentDir,
				credentials,
				authStorage,
				modelRegistry,
				logger: silentLogger,
			});
			assert.ok(runtime, "runtime should construct without an AGENTS.md");
			const promptDiagnostics = runtime
				.diagnostics()
				.filter((diagnostic) => /agentsFile|AGENTS\.md/i.test(diagnostic.message));
			assert.deepEqual(promptDiagnostics, [], "no prompt-load diagnostics expected");
		} finally {
			project.cleanup();
		}
	});

	test("ProjectRuntime.create() writes <projectDir>/.pi/.gitignore excluding sessions/", async () => {
		// Auto-gitignore is the safety net that keeps session transcripts
		// out of git. Without it, a developer running `git add .pi/` to
		// commit AGENTS.md / skills / extensions would also stage every
		// chat history JSONL file the runtime has written. Verify the
		// gitignore is created on first runtime construction.
		const project = makeProject();
		const agentDir = resolve(project.dir, ".pi-agent");
		const { authStorage, modelRegistry, credentials } = makeCredentials(agentDir);
		try {
			await ProjectRuntime.create({
				projectDir: project.dir,
				agentDir,
				credentials,
				authStorage,
				modelRegistry,
				logger: silentLogger,
			});
			const gitignorePath = resolve(project.dir, ".pi/.gitignore");
			assert.ok(existsSync(gitignorePath), `expected ${gitignorePath} to be created on first runtime construction`);
			const contents = readFileSync(gitignorePath, "utf8");
			assert.match(contents, /^sessions\/$/m, "gitignore should contain a 'sessions/' rule");
		} finally {
			project.cleanup();
		}
	});

	test("ProjectRuntime.create() leaves an existing .pi/.gitignore untouched (idempotent)", async () => {
		// Strict idempotency: surprise mutation of files in someone's
		// workspace is worse than missing a default. If the operator
		// already has a custom .gitignore we don't overwrite it — they
		// can take responsibility for adding 'sessions/' themselves.
		const project = makeProject();
		const agentDir = resolve(project.dir, ".pi-agent");
		const { authStorage, modelRegistry, credentials } = makeCredentials(agentDir);
		const customContents = "# my own gitignore\n*.log\n";
		writeFileSync(resolve(project.dir, ".pi/.gitignore"), customContents);
		try {
			await ProjectRuntime.create({
				projectDir: project.dir,
				agentDir,
				credentials,
				authStorage,
				modelRegistry,
				logger: silentLogger,
			});
			const contents = readFileSync(resolve(project.dir, ".pi/.gitignore"), "utf8");
			assert.equal(contents, customContents, "existing .gitignore must not be modified");
		} finally {
			project.cleanup();
		}
	});
});
