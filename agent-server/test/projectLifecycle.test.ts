/**
 * Unit tests for the project lifecycle layer: slug derivation, the durable
 * ProjectStore, and the ProjectRegistry's create/idempotency/rehydration and
 * removal behaviour. No HTTP, no LLM calls.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { ProjectRegistry } from "../src/runtime/projectRegistry.js";
import { ProjectStore } from "../src/runtime/projectStore.js";
import { isValidProjectSlug, RESERVED_PROJECT_SLUGS, slugify, withCollisionSuffix } from "../src/utils/slug.js";

const silentLogger = { log: () => {}, error: () => {} };

function makeWorkspace(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(resolve(tmpdir(), "agent-server-lifecycle-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("slugify", () => {
	test("lowercases, hyphenates, and trims", () => {
		assert.equal(slugify("My Cool App"), "my-cool-app");
		assert.equal(slugify("  Trim__me!! "), "trim-me");
		assert.equal(slugify("Already-A-Slug"), "already-a-slug");
	});

	test("strips diacritics", () => {
		assert.equal(slugify("Café Münchén"), "cafe-munchen");
	});

	test("yields empty string for unusable names", () => {
		assert.equal(slugify("   "), "");
		assert.equal(slugify("!!!"), "");
	});

	test("isValidProjectSlug rejects empty and reserved slugs", () => {
		assert.equal(isValidProjectSlug("my-app"), true);
		assert.equal(isValidProjectSlug(""), false);
		for (const reserved of RESERVED_PROJECT_SLUGS) {
			assert.equal(isValidProjectSlug(reserved), false);
		}
	});

	test("withCollisionSuffix keeps the base and appends 4 hex chars", () => {
		const suffixed = withCollisionSuffix("my-app");
		assert.match(suffixed, /^my-app-[0-9a-f]{4}$/);
	});
});

describe("ProjectStore", () => {
	test("persists atomically and reloads from disk", () => {
		const ws = makeWorkspace();
		const filePath = join(ws.dir, "projects.json");
		try {
			const store = ProjectStore.load(filePath);
			store.add({ id: "a", name: "A", createdAt: "2026-01-01T00:00:00.000Z" });
			store.add({ id: "b", name: "B", createdAt: "2026-01-02T00:00:00.000Z" });

			const reopened = ProjectStore.load(filePath);
			assert.equal(reopened.has("a"), true);
			assert.equal(reopened.get("b")?.name, "B");
			// Newest first.
			assert.deepEqual(
				reopened.list().map((r) => r.id),
				["b", "a"],
			);
		} finally {
			ws.cleanup();
		}
	});

	test("rejects a duplicate id and removes cleanly", () => {
		const ws = makeWorkspace();
		const filePath = join(ws.dir, "projects.json");
		try {
			const store = ProjectStore.load(filePath);
			store.add({ id: "a", name: "A", createdAt: "2026-01-01T00:00:00.000Z" });
			assert.throws(() => store.add({ id: "a", name: "dup", createdAt: "2026-01-03T00:00:00.000Z" }));
			store.remove("a");
			assert.equal(ProjectStore.load(filePath).has("a"), false);
		} finally {
			ws.cleanup();
		}
	});

	test("a corrupt registry file is a loud failure", () => {
		const ws = makeWorkspace();
		const filePath = join(ws.dir, "projects.json");
		try {
			writeFileSync(filePath, "{not json");
			assert.throws(() => ProjectStore.load(filePath), /corrupt projects registry/);
		} finally {
			ws.cleanup();
		}
	});
});

describe("ProjectRegistry lifecycle", () => {
	test("createProject assigns slug id, makes the dir, and persists", async () => {
		const ws = makeWorkspace();
		try {
			const registry = await ProjectRegistry.create({
				workspaceDir: ws.dir,
				logger: silentLogger,
			});
			const project = registry.createProject({ name: "My Cool App" });

			assert.equal(project.id, "my-cool-app");
			assert.equal(project.name, "My Cool App");
			assert.equal(project.projectDir, join(ws.dir, "my-cool-app"));
			assert.ok(existsSync(project.projectDir), "project dir created");
			assert.ok(existsSync(join(ws.dir, ".pi-global", "projects.json")), "registry persisted under .pi-global");
		} finally {
			ws.cleanup();
		}
	});

	test("is idempotent on name and rehydrates on a fresh registry", async () => {
		const ws = makeWorkspace();
		try {
			const registry = await ProjectRegistry.create({
				workspaceDir: ws.dir,
				logger: silentLogger,
			});
			const first = registry.createProject({ name: "my-app" });
			const again = registry.createProject({ name: "my-app" });
			assert.equal(again.id, first.id);
			assert.equal(again.createdAt, first.createdAt);
			assert.equal(registry.listProjects().length, 1);

			const reopened = await ProjectRegistry.create({
				workspaceDir: ws.dir,
				logger: silentLogger,
			});
			assert.equal(reopened.getProject("my-app")?.name, "my-app");
			assert.equal(reopened.listProjects().length, 1);
		} finally {
			ws.cleanup();
		}
	});

	test("different names that slugify the same coexist via a suffix", async () => {
		const ws = makeWorkspace();
		try {
			const registry = await ProjectRegistry.create({
				workspaceDir: ws.dir,
				logger: silentLogger,
			});
			const first = registry.createProject({ name: "My App" }); // -> my-app
			const second = registry.createProject({ name: "my-app" }); // collision
			assert.equal(first.id, "my-app");
			assert.notEqual(second.id, first.id);
			assert.match(second.id, /^my-app-[0-9a-f]{4}$/);
			assert.equal(registry.listProjects().length, 2);
		} finally {
			ws.cleanup();
		}
	});

	test("rejects names that yield no valid slug", async () => {
		const ws = makeWorkspace();
		try {
			const registry = await ProjectRegistry.create({
				workspaceDir: ws.dir,
				logger: silentLogger,
			});
			assert.throws(() => registry.createProject({ name: "   " }));
			assert.throws(() => registry.createProject({ name: "!!!" }));
		} finally {
			ws.cleanup();
		}
	});

	test("getRuntime returns null for unknown projects, a runtime once created", async () => {
		const ws = makeWorkspace();
		try {
			const registry = await ProjectRegistry.create({
				workspaceDir: ws.dir,
				logger: silentLogger,
			});
			assert.equal(await registry.getRuntime("nope"), null);

			const project = registry.createProject({ name: "game" });
			const runtime = await registry.getRuntime(project.id);
			assert.ok(runtime, "runtime built for a registered project");
			// Transcripts are centralised under .pi-global/sessions/{id}.
			assert.ok(
				existsSync(join(ws.dir, ".pi-global", "sessions", project.id)),
				"sessions dir created under .pi-global",
			);
		} finally {
			ws.cleanup();
		}
	});

	test("removeProject deletes metadata, working dir, and transcripts", async () => {
		const ws = makeWorkspace();
		try {
			const registry = await ProjectRegistry.create({
				workspaceDir: ws.dir,
				logger: silentLogger,
			});
			const project = registry.createProject({ name: "ephemeral" });
			await registry.getRuntime(project.id); // materialise sessions dir
			writeFileSync(join(project.projectDir, "marker.txt"), "x");

			assert.equal(registry.removeProject(project.id), true);
			assert.equal(registry.getProject(project.id), null);
			assert.equal(existsSync(project.projectDir), false);
			assert.equal(existsSync(join(ws.dir, ".pi-global", "sessions", project.id)), false);
			// Removing an unknown project is a no-op false.
			assert.equal(registry.removeProject("nope"), false);

			// Persisted registry reflects the removal.
			const registryFile = readFileSync(join(ws.dir, ".pi-global", "projects.json"), "utf8");
			assert.equal(registryFile.includes("ephemeral"), false);
		} finally {
			ws.cleanup();
		}
	});
});
