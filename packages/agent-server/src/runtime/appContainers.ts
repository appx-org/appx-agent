/**
 * App-resource reaping for project deletion.
 *
 * The builder agent — not server code — creates a project's app containers, by
 * running `$APP_CONTAINER_RUNTIME` commands from the deploy-app skill. Nothing
 * in the server therefore knows they exist, so deleting a project used to leave
 * them running with their published ports still bound (issue #10). Because the
 * control plane gap-fills freed ports, the next project could be allocated a
 * port an orphan already held, and its deploy failed with an opaque error in a
 * different project than the delete that caused it.
 *
 * This module is the single owner of the convention that ties a running resource
 * back to its project: the `appx.project=<id>` label. The deploy-app skill
 * applies it to everything it creates; the reaper removes everything carrying
 * it. Both sides reference `PROJECT_LABEL_KEY` (the skill via its documented
 * text, guarded by a test) so the convention cannot drift.
 */
import { spawn } from "node:child_process";

/**
 * Label key stamped on every resource the deploy-app skill creates, with the
 * project's canonical id as its value. This is the join key between a project
 * and its runtime resources — see builder-agent/skills/deploy-app/SKILL.md.
 */
export const PROJECT_LABEL_KEY = "appx.project";

/**
 * Fallback container runtime when `APP_CONTAINER_RUNTIME` is unset. Matches the
 * default in config.ts — the outer builder container always has podman.
 */
export const DEFAULT_APP_CONTAINER_RUNTIME = "podman";

/** Ceiling on a single runtime CLI call. `rm -f` SIGTERMs and waits, so this is
 * generous — but a wedged runtime must not hang the DELETE forever. */
const RUNTIME_CALL_TIMEOUT_MS = 30_000;

/** The two app-container environments the deploy-app skill deploys. */
const APP_ENVIRONMENTS = ["dev", "prod"] as const;

/**
 * Container name for one of a project's app instances, matching the deploy-app
 * skill's `<project>-app-{dev,prod}` convention.
 */
export function appContainerName(projectId: string, environment: (typeof APP_ENVIRONMENTS)[number]): string {
	return `${projectId}-app-${environment}`;
}

type Logger = Pick<Console, "log" | "error">;

/**
 * Remove every runtime resource belonging to a project.
 *
 * Best-effort by design: a project may never have been deployed, so finding
 * nothing is the normal case and not an error. Failures are logged and
 * swallowed — leaving a project undeletable is worse than leaking a resource,
 * and the caller has already committed to removing the project.
 */
export async function reapProjectResources({
	runtime,
	projectId,
	logger,
}: {
	runtime: string;
	projectId: string;
	logger: Logger;
}): Promise<void> {
	const selector = `label=${PROJECT_LABEL_KEY}=${projectId}`;

	// Order is forced by dependency: a network with an attached container refuses
	// to be removed, as does an in-use volume, and an image is still referenced by
	// any container created from it. Containers must go first regardless — one may
	// hold a bind mount into the working dir the caller is about to delete.
	const labelled = await listIds(runtime, ["ps", "-aq", "--filter", selector], logger);
	const byName = await appContainersByName(runtime, projectId, logger);
	const containerIds = [...new Set([...labelled, ...byName])];
	if (containerIds.length > 0) {
		// `-v` also removes *anonymous* volumes, which an image's VOLUME directive
		// can create without the agent asking. They carry no label, so nothing
		// else would ever find them.
		await run(runtime, ["rm", "-f", "-v", ...containerIds], logger);
	}

	const networkIds = await listIds(runtime, ["network", "ls", "-q", "--filter", selector], logger);
	if (networkIds.length > 0) {
		await run(runtime, ["network", "rm", "-f", ...networkIds], logger);
	}

	const volumeIds = await listIds(runtime, ["volume", "ls", "-q", "--filter", selector], logger);
	if (volumeIds.length > 0) {
		await run(runtime, ["volume", "rm", "-f", ...volumeIds], logger);
	}

	// Images are reclaimable storage, not a correctness issue: a deleted project's
	// `<id>-app:*` images will never be rebuilt. Shared base layers stay cached
	// either way, so this does not slow down other projects' builds.
	const imageIds = await listIds(runtime, ["images", "-q", "--filter", selector], logger);
	if (imageIds.length > 0) {
		await run(runtime, ["rmi", "-f", ...imageIds], logger);
	}
}

/**
 * Fallback discovery by the skill's naming convention, for containers created
 * before the label existed — or when the agent simply forgot to pass `--label`.
 * Labelling is prose instruction to an LLM, not an enforceable invariant, so
 * this floor is what keeps the reported port collision fixed regardless.
 *
 * Names are listed unfiltered and matched here rather than with `--filter
 * name=`: podman treats that filter as a regex while docker treats it as a
 * substring match, so one argv would mean two different things. Exact equality
 * in TypeScript behaves identically on both, and cannot over-match a project
 * whose id shares a prefix with another's.
 */
async function appContainersByName(runtime: string, projectId: string, logger: Logger): Promise<string[]> {
	const names = await listIds(runtime, ["ps", "-a", "--format", "{{.Names}}"], logger);
	const wanted = new Set(APP_ENVIRONMENTS.map((environment) => appContainerName(projectId, environment)));
	return names.filter((name) => wanted.has(name));
}

/** Run a listing command and split its stdout into non-empty lines. */
async function listIds(runtime: string, args: string[], logger: Logger): Promise<string[]> {
	const result = await run(runtime, args, logger);
	if (!result.ok) return [];
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

type RunResult = { ok: boolean; stdout: string };

/**
 * Spawn one runtime CLI call. Async (never `spawnSync`) because `rm -f` on a
 * running container sends SIGTERM and waits for it to exit — blocking the event
 * loop there would stall every other in-flight request for seconds.
 */
function run(runtime: string, args: string[], logger: Logger): Promise<RunResult> {
	return new Promise((resolvePromise) => {
		const child = spawn(runtime, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, RUNTIME_CALL_TIMEOUT_MS);

		const settle = (result: RunResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise(result);
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		child.on("error", (err) => {
			logger.error(`[agent-server] ${runtime} ${args.join(" ")} failed to spawn: ${err.message}`);
			settle({ ok: false, stdout: "" });
		});

		child.on("close", (code) => {
			if (code === 0) {
				settle({ ok: true, stdout });
				return;
			}
			// Any non-zero exit is a genuine failure: resources are discovered
			// before removal, so "no such resource" never reaches this path.
			logger.error(
				`[agent-server] ${runtime} ${args.join(" ")} exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
			);
			settle({ ok: false, stdout });
		});
	});
}
