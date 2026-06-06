/**
 * Tests for the generated SSE wire-event contract.
 *
 * Two layers:
 *  - The runtime classifier (`validateAgentSessionEvent`) — shallow, tolerant.
 *  - Deep validation against the generated JSON Schema with ajv, over curated
 *    *complete* fixtures. This is the drift guard: if a regeneration changes a
 *    committed shape, these fail. (Runtime stays shallow on purpose; deep checks
 *    here avoid false alarms on streaming partial messages.)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
	KNOWN_AGENT_SESSION_EVENT_TYPES,
	validateAgentSessionEvent,
} from "../src/http/eventValidation.js";

const generated = JSON.parse(
	readFileSync(new URL("../src/http/eventSchema.generated.json", import.meta.url), "utf8"),
);

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(generated, "wire");
const validateWire = ajv.getSchema("wire#/components/schemas/WireEvent");

describe("runtime classifier (validateAgentSessionEvent)", () => {
	test("a committed event type is valid", () => {
		assert.deepEqual(validateAgentSessionEvent({ type: "agent_start" }), { status: "valid" });
		assert.deepEqual(validateAgentSessionEvent({ type: "extension_ui_request", id: "r1" }), {
			status: "valid",
		});
	});

	test("an unmodeled type is unknown-type (forward-compatible), not invalid", () => {
		assert.deepEqual(validateAgentSessionEvent({ type: "some_future_event" }), {
			status: "unknown-type",
			type: "some_future_event",
		});
	});

	test("never throws on malformed input", () => {
		assert.equal(validateAgentSessionEvent(null).status, "invalid");
		assert.equal(validateAgentSessionEvent("nope").status, "invalid");
		assert.equal(validateAgentSessionEvent({}).status, "invalid");
		assert.equal(validateAgentSessionEvent({ type: 9 }).status, "invalid");
	});
});

describe("known-type set is derived from the generated schema", () => {
	test("covers every documented event type", () => {
		for (const expected of [
			"agent_start",
			"agent_end",
			"turn_start",
			"turn_end",
			"message_start",
			"message_update",
			"message_end",
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
			"queue_update",
			"compaction_start",
			"compaction_end",
			"session_info_changed",
			"thinking_level_changed",
			"auto_retry_start",
			"auto_retry_end",
			"extension_ui_request",
			"extension_error",
		]) {
			assert.ok(
				KNOWN_AGENT_SESSION_EVENT_TYPES.has(expected),
				`expected wire contract to cover '${expected}'`,
			);
		}
	});
});

describe("generated JSON Schema (ajv deep validation)", () => {
	test("the schema compiles (no dangling $refs)", () => {
		assert.equal(typeof validateWire, "function");
	});

	const validEvents: Array<{ name: string; event: unknown }> = [
		{ name: "agent_start", event: { type: "agent_start" } },
		{ name: "turn_start", event: { type: "turn_start" } },
		{ name: "agent_end", event: { type: "agent_end", messages: [], willRetry: false } },
		{ name: "queue_update", event: { type: "queue_update", steering: [], followUp: [] } },
		{ name: "thinking_level_changed", event: { type: "thinking_level_changed", level: "high" } },
		{
			name: "tool_execution_start",
			event: { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
		},
		{
			name: "tool_execution_end",
			event: {
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "bash",
				result: { ok: true },
				isError: false,
			},
		},
		{
			name: "extension_ui_request/confirm",
			event: { type: "extension_ui_request", id: "r1", method: "confirm", title: "Proceed?", message: "..." },
		},
		{
			name: "extension_error",
			event: { type: "extension_error", extensionPath: "ext.js", error: "boom" },
		},
	];

	for (const { name, event } of validEvents) {
		test(`accepts a complete ${name}`, () => {
			const ok = validateWire!(event);
			assert.ok(ok, `expected ${name} to validate; errors: ${JSON.stringify(validateWire!.errors)}`);
		});
	}

	const invalidEvents: Array<{ name: string; event: unknown }> = [
		{
			name: "tool_execution_end missing isError",
			event: { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {} },
		},
		{
			name: "extension_ui_request/confirm missing message",
			event: { type: "extension_ui_request", id: "r1", method: "confirm", title: "Proceed?" },
		},
		{ name: "unknown event type", event: { type: "some_future_event" } },
	];

	for (const { name, event } of invalidEvents) {
		test(`rejects ${name}`, () => {
			assert.equal(validateWire!(event), false);
		});
	}
});
