/**
 * Unit tests for the pure deployment helpers: prompt-section generation and
 * stable JSON serialisation. No runtime, no filesystem.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildDeploymentJson, buildDeploymentPromptSection, isDeploymentEmpty } from "../src/runtime/deployment.js";

describe("buildDeploymentPromptSection", () => {
	test("renders both dev and prod when present", () => {
		const section = buildDeploymentPromptSection(
			{
				dev: { port: 10006, url: "https://eventx-dev.example.com" },
				prod: { port: 10007, url: "https://eventx.example.com" },
			},
			"podman",
		);
		assert.ok(section);
		assert.match(section, /## Deployment/);
		assert.match(section, /DEV.*host port 10006 → https:\/\/eventx-dev\.example\.com.*<project>-app-dev/);
		assert.match(section, /PROD.*host port 10007 → https:\/\/eventx\.example\.com.*<project>-app-prod/);
		assert.match(section, /Container runtime: podman/);
		assert.match(section, /\.pi\/deployment\.json/);
		assert.match(section, /-p <reserved host port>:<container port>/);
	});

	test("dev-only metadata omits the PROD line", () => {
		const section = buildDeploymentPromptSection({ dev: { port: 10006, url: "https://d.example" } }, "docker");
		assert.ok(section);
		assert.match(section, /- DEV/);
		assert.doesNotMatch(section, /- PROD/);
		assert.match(section, /Container runtime: docker/);
	});

	test("prod-only metadata omits the DEV line", () => {
		const section = buildDeploymentPromptSection({ prod: { port: 10007 } }, "podman");
		assert.ok(section);
		assert.match(section, /PROD/);
		assert.doesNotMatch(section, /- DEV/);
		// URL absent → just the host port.
		assert.match(section, /host port 10007/);
	});

	test("absent / empty metadata yields no section", () => {
		assert.equal(buildDeploymentPromptSection(undefined, "podman"), undefined);
		assert.equal(buildDeploymentPromptSection({}, "podman"), undefined);
		assert.equal(buildDeploymentPromptSection({ dev: {}, prod: {} }, "podman"), undefined);
	});
});

describe("buildDeploymentJson", () => {
	test("stable key order regardless of input order", () => {
		const json = buildDeploymentJson({
			prod: { url: "https://eventx.example.com", port: 10007 },
			dev: { url: "https://eventx-dev.example.com", port: 10006 },
		});
		assert.equal(
			json,
			`${JSON.stringify(
				{
					dev: { port: 10006, url: "https://eventx-dev.example.com" },
					prod: { port: 10007, url: "https://eventx.example.com" },
				},
				null,
				2,
			)}\n`,
		);
	});

	test("omits empty environments and fields", () => {
		const json = buildDeploymentJson({ dev: { port: 10006 }, prod: {} });
		assert.equal(json, `${JSON.stringify({ dev: { port: 10006 } }, null, 2)}\n`);
	});
});

describe("isDeploymentEmpty", () => {
	test("true for undefined / empty, false when any field set", () => {
		assert.equal(isDeploymentEmpty(undefined), true);
		assert.equal(isDeploymentEmpty({}), true);
		assert.equal(isDeploymentEmpty({ dev: {}, prod: {} }), true);
		assert.equal(isDeploymentEmpty({ dev: { port: 10006 } }), false);
		assert.equal(isDeploymentEmpty({ prod: { url: "https://x" } }), false);
	});
});
