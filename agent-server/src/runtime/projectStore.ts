/**
 * ProjectStore — durable, on-disk registry of project *metadata*.
 *
 * This is the **source of truth** for "which projects exist" and survives
 * agent-server / container restarts (the file lives on the mounted workspace
 * volume at `WORKSPACE_DIR/.pi-global/projects.json`). On boot the
 * ProjectRegistry rehydrates from it; runtimes themselves are rebuilt lazily.
 *
 * Scope boundary: this stores only agent-server-owned identity/metadata
 * (`id`, `name`, `createdAt`). It is *not* a Pi SDK file — `AuthStorage` /
 * `ModelRegistry` do not read it. App/agent domain state (game inventories,
 * etc.) belongs to the consuming app's own database, not here.
 *
 * Concurrency: agent-server is a single process, so there is one writer. Writes
 * are nonetheless atomic (temp file + `rename`) so a crash mid-write can never
 * leave a half-written, unparseable registry.
 *
 * See docs/architecture/project-lifecycle-and-workspace-layout.md.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Persisted, agent-server-owned metadata for one project. */
export type ProjectRecord = {
	/** Immutable slug; registry key, route param, and on-disk directory name. */
	id: string;
	/** Mutable, human-facing display label. Never used to build paths. */
	name: string;
	/** ISO-8601 creation timestamp. */
	createdAt: string;
};

/** On-disk envelope. Versioned so the schema can evolve without ambiguity. */
type ProjectStoreFile = {
	version: 1;
	projects: ProjectRecord[];
};

const STORE_VERSION = 1 as const;

/**
 * File-backed map of `id -> ProjectRecord`. Construct via `ProjectStore.load`,
 * which reads (or initialises) the JSON file. All mutations persist
 * synchronously and atomically.
 */
export class ProjectStore {
	private readonly filePath: string;
	private readonly records = new Map<string, ProjectRecord>();

	private constructor(filePath: string, records: ProjectRecord[]) {
		this.filePath = filePath;
		for (const record of records) this.records.set(record.id, record);
	}

	/**
	 * Load the store from `filePath`, creating an empty registry if the file is
	 * absent. A present-but-corrupt file is a fatal error rather than silently
	 * discarded — losing the project registry should be loud, not implicit.
	 */
	static load(filePath: string): ProjectStore {
		if (!existsSync(filePath)) {
			mkdirSync(dirname(filePath), { recursive: true });
			return new ProjectStore(filePath, []);
		}
		const raw = readFileSync(filePath, "utf8");
		let parsed: ProjectStoreFile;
		try {
			parsed = JSON.parse(raw) as ProjectStoreFile;
		} catch (err) {
			throw new Error(`corrupt projects registry at ${filePath}: ${String(err)}`);
		}
		if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.projects)) {
			throw new Error(`unsupported projects registry shape at ${filePath}`);
		}
		return new ProjectStore(filePath, parsed.projects);
	}

	/** True if a project with this id is registered. */
	has(id: string): boolean {
		return this.records.has(id);
	}

	/** Return one record, or undefined if unknown. */
	get(id: string): ProjectRecord | undefined {
		return this.records.get(id);
	}

	/** All records, newest first. */
	list(): ProjectRecord[] {
		return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	/**
	 * Insert a new record and persist. Throws if the id already exists — callers
	 * implementing idempotent upsert should check `has()` first and return the
	 * existing record rather than calling this.
	 */
	add(record: ProjectRecord): ProjectRecord {
		if (this.records.has(record.id)) {
			throw new Error(`project already exists: ${record.id}`);
		}
		this.records.set(record.id, record);
		this.persist();
		return record;
	}

	/** Remove a record and persist. No-op if the id is unknown. */
	remove(id: string): void {
		if (this.records.delete(id)) this.persist();
	}

	/** Atomically write the registry to disk (temp file + rename). */
	private persist(): void {
		const payload: ProjectStoreFile = {
			version: STORE_VERSION,
			projects: this.list(),
		};
		const tmpPath = join(dirname(this.filePath), `.projects.${process.pid}.${Date.now()}.tmp`);
		writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
			mode: 0o644,
		});
		renameSync(tmpPath, this.filePath);
	}
}
