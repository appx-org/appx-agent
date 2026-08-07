/**
 * Unit tests for the app-resource reaper — the cleanup that runs when a project
 * is deleted so the containers the deploy-app skill created cannot outlive it
 * (issue #10: orphans keep their published ports bound, and the control plane
 * re-allocates those ports to the next project).
 *
 * Seam: `reapProjectResources`'s contract with the container runtime CLI. Tests
 * point `runtime` at a stub executable that records every argv it receives and
 * replays canned stdout, so the real `spawn` plumbing is exercised and the
 * assertions are about the commands actually issued — not about internals.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PROJECT_LABEL_KEY, reapProjectResources } from "../src/runtime/appContainers.js";
import { callStartingWith, makeStubRuntime } from "./stubRuntime.js";

const silentLogger = { log: () => {}, error: () => {} };

describe("reapProjectResources", () => {
	test("removes the containers carrying the project's label", async () => {
		// Two labelled containers exist: the app and a sibling db.
		const stub = makeStubRuntime({ responses: { "ps -aq*": "abc123\ndef456\n" } });
		try {
			await reapProjectResources({
				runtime: stub.path,
				projectId: "my-app",
				logger: silentLogger,
			});

			const calls = stub.calls();

			// Discovery is by label, so siblings (db, cache) are covered too.
			const listCall = callStartingWith(calls, "ps");
			assert.deepEqual(listCall, ["ps", "-aq", "--filter", `label=${PROJECT_LABEL_KEY}=my-app`]);

			// `-v` also drops anonymous volumes, which carry no label and would
			// otherwise be unreachable by any later cleanup.
			const removeCall = callStartingWith(calls, "rm");
			assert.deepEqual(removeCall, ["rm", "-f", "-v", "abc123", "def456"]);
		} finally {
			stub.cleanup();
		}
	});

	test("removes labelled networks, volumes and images too", async () => {
		const stub = makeStubRuntime({
			responses: {
				"ps -aq*": "container1\n",
				"network ls*": "net1\n",
				"volume ls*": "vol1\n",
				"images*": "img1\nimg2\n",
			},
		});
		try {
			await reapProjectResources({
				runtime: stub.path,
				projectId: "my-app",
				logger: silentLogger,
			});

			const calls = stub.calls();
			const selector = `label=${PROJECT_LABEL_KEY}=my-app`;

			assert.deepEqual(callStartingWith(calls, "network", "ls"), ["network", "ls", "-q", "--filter", selector]);
			assert.deepEqual(callStartingWith(calls, "network", "rm"), ["network", "rm", "-f", "net1"]);
			assert.deepEqual(callStartingWith(calls, "volume", "ls"), ["volume", "ls", "-q", "--filter", selector]);
			assert.deepEqual(callStartingWith(calls, "volume", "rm"), ["volume", "rm", "-f", "vol1"]);
			assert.deepEqual(callStartingWith(calls, "images"), ["images", "-q", "--filter", selector]);
			assert.deepEqual(callStartingWith(calls, "rmi"), ["rmi", "-f", "img1", "img2"]);
		} finally {
			stub.cleanup();
		}
	});

	test("reaps in dependency order: containers, then networks, then volumes, then images", async () => {
		// An attached network refuses to be removed, and so does an in-use volume,
		// so containers must go first. Images last: a container holds a reference
		// to the image it was created from.
		const stub = makeStubRuntime({
			responses: { "ps -aq*": "c1\n", "network ls*": "n1\n", "volume ls*": "v1\n", "images*": "i1\n" },
		});
		try {
			await reapProjectResources({
				runtime: stub.path,
				projectId: "my-app",
				logger: silentLogger,
			});

			// Keep only the destructive calls, in the order they were issued.
			const removals = stub
				.calls()
				.map((argv) => argv.slice(0, 2).join(" "))
				.filter((call) => call.startsWith("rm ") || call.endsWith(" rm") || call.startsWith("rmi "));

			assert.deepEqual(removals, ["rm -f", "network rm", "volume rm", "rmi -f"]);
		} finally {
			stub.cleanup();
		}
	});

	test("a project that was never deployed issues no removals and does not throw", async () => {
		// Every listing comes back empty — the normal case for a project the agent
		// never deployed. Absence must not be an error.
		const stub = makeStubRuntime({ responses: {} });
		try {
			await reapProjectResources({
				runtime: stub.path,
				projectId: "never-deployed",
				logger: silentLogger,
			});

			const destructive = stub
				.calls()
				.filter((argv) => argv.includes("rm") || argv.includes("rmi") || argv.includes("-f"));
			assert.deepEqual(destructive, [], "nothing to remove ⇒ no removal calls");
		} finally {
			stub.cleanup();
		}
	});

	test("falls back to the naming convention for containers deployed before the label existed", async () => {
		// Label discovery finds nothing (these predate the label, or the agent
		// forgot it), but the deploy-app skill's `<project>-app-{dev,prod}` names
		// still identify them. This floor is what keeps issue #10's port collision
		// fixed even when labelling is skipped.
		const stub = makeStubRuntime({
			responses: {
				// Label discovery finds nothing; the name listing returns everything on
				// the host, including another project's container and an unlabelled
				// sibling db.
				"ps -a --format*": "my-app-app-dev\nmy-app-app-prod\nunrelated-app-dev\nmy-app-db\n",
			},
		});
		try {
			await reapProjectResources({
				runtime: stub.path,
				projectId: "my-app",
				logger: silentLogger,
			});

			const nameListing = stub.calls().find((argv) => argv[0] === "ps" && argv.includes("--format"));
			assert.ok(nameListing, "names are listed for the fallback");
			// Deliberately NOT `--filter name=…`: podman treats that as a regex and
			// docker as a substring match, so the same argv would behave differently
			// across the two runtimes. Filtering happens in TypeScript instead.
			assert.ok(!nameListing.includes("--filter"), "no runtime-specific name filter");

			const removeCall = callStartingWith(stub.calls(), "rm");
			assert.ok(removeCall);
			const removed = removeCall.slice(3);
			// Only this project's two app containers — anchored, so a project whose
			// id merely shares a prefix is untouched, and the unlabelled sibling db
			// is out of scope for the fallback (it binds no host port).
			assert.deepEqual(removed.sort(), ["my-app-app-dev", "my-app-app-prod"]);
		} finally {
			stub.cleanup();
		}
	});

	test("a failing removal is logged and does not stop the remaining resource types", async () => {
		// Container removal fails (runtime hiccup, permissions). The reaper must
		// still attempt networks/volumes/images rather than abandoning the sweep.
		const stub = makeStubRuntime({
			responses: { "ps -aq*": "c1\n", "network ls*": "n1\n", "volume ls*": "v1\n", "images*": "i1\n" },
			exitCodes: { "rm -f*": 1 },
		});
		const errors: string[] = [];
		try {
			await reapProjectResources({
				runtime: stub.path,
				projectId: "my-app",
				logger: { log: () => {}, error: (message: string) => errors.push(message) },
			});

			const calls = stub.calls();
			assert.ok(callStartingWith(calls, "network", "rm"), "networks still reaped after a container failure");
			assert.ok(callStartingWith(calls, "volume", "rm"), "volumes still reaped after a container failure");
			assert.ok(callStartingWith(calls, "rmi"), "images still reaped after a container failure");
			assert.equal(errors.length, 1, "the failure is surfaced exactly once");
			assert.match(errors[0] ?? "", /exited 1/);
		} finally {
			stub.cleanup();
		}
	});
});
