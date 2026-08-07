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

	test("publishes with a bare host:container port pair everywhere", () => {
		// An address-prefixed publish (`-p 127.0.0.1:<host>:<container>`) binds the
		// builder container's OWN loopback, while requests arrive on its bridge
		// address — so the app is unreachable for every real user while looking
		// healthy from inside. The skill used to invite exactly that by saying
		// "Loopback only. Do not publish on 0.0.0.0". Every publish example must be
		// two numbers and nothing else.
		const skill = readFileSync(SKILL_PATH, "utf8");
		for (const [index, line] of skill.split("\n").entries()) {
			// `-p` as a publish flag: its value contains a colon. Skips `node -p`,
			// which the skill uses to read deployment.json.
			const publish = line.match(/-p\s+(\S*:\S*)/);
			if (!publish) continue;
			// Strip trailing markdown/shell punctuation so prose and echo strings
			// are compared as the bare argument.
			const value = publish[1]!.replace(/[`,.'"]+$/, "");
			assert.match(
				value,
				/^<?\w+>?:<?\w+>?$/,
				`SKILL.md line ${index + 1} publishes something other than <hostPort>:<containerPort>: ${line.trim()}`,
			);
		}
		assert.match(skill, /-p <devPort>:<containerPort>/);
		assert.match(skill, /-p <prodPort>:<containerPort>/);
	});

	test("states the publish rule positively, with its reason", () => {
		// Whitespace-insensitive: the prose is hard-wrapped, so a phrase can
		// straddle a newline.
		const prose = readFileSync(SKILL_PATH, "utf8").replace(/\s+/g, " ");
		assert.match(prose, /exactly two numbers/i);
		// Enough reason that an agent does not "harden" this back to loopback,
		// without turning the skill into a design doc.
		assert.match(prose, /reachable on every interface of this container/i);
		assert.match(prose, /restricts it to loopback on the host/i);
	});

	test("health check asserts the binding, not just a 200", () => {
		// curl from inside the builder container reaches the app through the same
		// loopback a wrongly-bound publish uses, so it returns 200 for an app no
		// user can load. The binding needs its own assertion, expressed as the
		// expected good state.
		const skill = readFileSync(SKILL_PATH, "utf8");
		assert.match(skill, /port <project>-app-dev/);
		assert.match(skill, /0\\\.0\\\.0\\\.0:/);
	});
});
