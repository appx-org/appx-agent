/**
 * Drift guard between the deploy-app skill's prose and the reaper's code.
 *
 * The label convention is the only link between resources the *agent* creates
 * and the cleanup *server code* performs on delete (issue #10). One side lives
 * in a markdown file read by an LLM, the other in TypeScript — prose cannot
 * import a constant, so this test asserts they still agree.
 *
 * Seam: the skill file's published text. Deliberately not asserting on exact
 * command lines (they are the agent's to adapt) — only on the facts the reaper
 * depends on.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { PROJECT_LABEL_KEY } from "../src/runtime/appContainers.js";

const SKILL_PATH = join(import.meta.dirname, "..", "builder-agent", "skills", "deploy-app", "SKILL.md");

describe("deploy-app skill", () => {
	test("instructs the agent to use the label key the reaper matches on", () => {
		const skill = readFileSync(SKILL_PATH, "utf8");
		assert.ok(
			skill.includes(`--label ${PROJECT_LABEL_KEY}=`),
			`SKILL.md must tell the agent to apply --label ${PROJECT_LABEL_KEY}=… ; ` +
				"without it, deleting a project cannot find the resources to reap",
		);
	});

	test("reads the project id from deployment.json rather than guessing it", () => {
		// The label value must be the canonical id. `node -p` (not jq — the outer
		// image has Node but no jq) extracts it from the materialised file.
		const skill = readFileSync(SKILL_PATH, "utf8");
		assert.match(skill, /deployment\.json/);
		assert.ok(!/\bjq\b/.test(skill), "jq is not installed in the outer container image");
	});

	test("documents the container names the reaper falls back to", () => {
		const skill = readFileSync(SKILL_PATH, "utf8");
		assert.match(skill, /<project>-app-dev/);
		assert.match(skill, /<project>-app-prod/);
	});

	test("steers multi-container apps to networks and away from pods", () => {
		// Pods are podman-only and outlive the containers in them, so one would leak
		// on podman and break the skill outright on docker.
		const skill = readFileSync(SKILL_PATH, "utf8");
		assert.match(skill, /networks, not pods/i);
		assert.match(skill, /network create --label appx\.project=/);
	});
});
