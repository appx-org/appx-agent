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

	test("never instructs a loopback-bound publish", () => {
		// The skill previously said "Loopback only. Do not publish on 0.0.0.0",
		// which reads as `-p 127.0.0.1:<host>:<container>`. Inside the builder
		// container that binds ITS loopback, while requests arrive on its bridge
		// address — so the app is unreachable for every real user while looking
		// healthy from inside. Any example that publishes with an address prefix
		// would reintroduce that.
		const skill = readFileSync(SKILL_PATH, "utf8");
		const lines = skill.split("\n");
		// A mention is only safe when it is marked as wrong nearby — the prose is
		// hard-wrapped, so the marker can sit on an adjacent line. Anything else
		// reads as an instruction to the agent.
		const marksItWrong = /❌|unreachable|never|FAILED|do not/i;
		for (const [index, line] of lines.entries()) {
			if (!/-p\s+\d{1,3}(?:\.\d{1,3}){3}:/.test(line)) continue;
			const window = lines.slice(Math.max(0, index - 1), index + 2).join(" ");
			assert.ok(
				marksItWrong.test(window),
				`SKILL.md line ${index + 1} shows an address-prefixed publish without marking it as wrong: ${line.trim()}`,
			);
		}
		// And the correct form must appear as a runnable example.
		assert.match(skill, /-p <devPort>:<containerPort>/);
		assert.match(skill, /-p <prodPort>:<containerPort>/);
	});

	test("tells the agent to publish without an address prefix", () => {
		// Whitespace-insensitive: the prose is hard-wrapped, so the phrase can
		// straddle a newline.
		const prose = readFileSync(SKILL_PATH, "utf8").replace(/\s+/g, " ");
		assert.match(prose, /never prefix it with an address/i);
		// The rule needs enough justification that an agent does not "harden" it
		// back to loopback, without turning the skill into a design doc.
		assert.match(prose, /a bare `-p` exposes nothing/i);
	});

	test("health check verifies the binding, not just a 200", () => {
		// curl from inside the builder container reaches the app through the same
		// loopback a wrongly-bound publish uses, so it returns 200 for an app no
		// user can load. The binding needs its own assertion.
		const skill = readFileSync(SKILL_PATH, "utf8");
		assert.match(skill, /port <project>-app-dev/);
		assert.match(skill, /FAILED: published on 127\.0\.0\.1/);
	});
});
