/**
 * Test double for the app container runtime CLI (`podman` / `docker`).
 *
 * Not a mock of our own code: it is a real executable on disk that the code
 * under test spawns exactly as it would spawn podman. That keeps the seam at the
 * process boundary — argv in, stdout/exit-code out — so tests assert the
 * commands actually issued rather than any internal call shape.
 *
 * Shared by appContainers.test.ts (the reaper's own contract) and
 * projectLifecycle.test.ts (that deleting a project invokes it at all).
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type StubRuntime = {
	/** Absolute path to the fake binary; pass as `appContainerRuntime`. */
	path: string;
	/** Every invocation's argv, in call order. */
	calls: () => string[][];
	cleanup: () => void;
};

/**
 * Create a fake runtime binary.
 *
 * `responses` and `exitCodes` are keyed by a **glob matched against the whole
 * argv** (e.g. `"ps -aq*"` vs `"ps -a --format*"`), because the reaper issues
 * several `ps` calls that must answer differently. First matching arm wins;
 * unmatched calls print nothing and exit 0.
 */
export function makeStubRuntime(options: {
	responses?: Record<string, string>;
	exitCodes?: Record<string, number>;
	/**
	 * Extra bash run on every invocation, before the response arms. Lets a test
	 * observe external state *at the moment the runtime is called* — e.g. whether
	 * the project's working dir still existed when the reap ran.
	 */
	probeScript?: string;
}): StubRuntime {
	const dir = mkdtempSync(resolve(tmpdir(), "agent-server-runtime-stub-"));
	const logPath = join(dir, "calls.log");
	const binPath = join(dir, "fake-runtime");
	writeFileSync(logPath, "");

	// Bash, not node: startup cost matters when a test makes several calls.
	const cases = Object.entries(options.responses ?? {})
		.map(([pattern, stdout]) => `  ${casePattern(pattern)}) printf '%s' ${shellQuote(stdout)} ;;`)
		.join("\n");
	const exits = Object.entries(options.exitCodes ?? {})
		.map(([pattern, code]) => `  ${casePattern(pattern)}) exit ${code} ;;`)
		.join("\n");

	writeFileSync(
		binPath,
		[
			"#!/usr/bin/env bash",
			// Record argv, tab-separated, one line per invocation.
			`printf '%s\\t' "$@" >> ${shellQuote(logPath)}`,
			`printf '\\n' >> ${shellQuote(logPath)}`,
			options.probeScript ?? "",
			'case "$*" in',
			cases,
			"esac",
			'case "$*" in',
			exits,
			"esac",
			"exit 0",
		].join("\n"),
		{ mode: 0o755 },
	);
	chmodSync(binPath, 0o755);

	return {
		path: binPath,
		calls: () =>
			readFileSync(logPath, "utf8")
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => line.split("\t").filter((arg) => arg.length > 0)),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/** Find the first call whose argv starts with the given words. */
export function callStartingWith(calls: string[][], ...prefix: string[]): string[] | undefined {
	return calls.find((argv) => prefix.every((word, index) => argv[index] === word));
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render a glob for a bash `case` arm. The literal text is single-quoted (it
 * contains spaces, which are syntax errors bare) while a trailing `*` stays
 * outside the quotes so it still globs.
 */
function casePattern(pattern: string): string {
	return pattern.endsWith("*") ? `${shellQuote(pattern.slice(0, -1))}*` : shellQuote(pattern);
}
