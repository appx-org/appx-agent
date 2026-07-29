/**
 * Sanity checks on the committed contract artifacts. Deep contract testing
 * lives in agent-server (which generates these); this only guards the
 * invariants this package's consumers rely on: the JSON parses, the shapes
 * are the expected collections, and the event schema's root ref is WireEvent
 * (position 0 is load-bearing — see agent-server's genEventSchema script).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));

test("openapi.json is a parseable OpenAPI 3.1 document with paths and schemas", () => {
	const doc = read("../openapi.json");
	assert.equal(doc.openapi, "3.1.0");
	assert.ok(Object.keys(doc.paths).length > 0, "has at least one path");
	assert.ok(doc.components?.schemas?.WireEvent, "WireEvent component is published");
});

test("eventSchema.generated.json roots at WireEvent", () => {
	const collection = read("../eventSchema.generated.json");
	assert.equal(collection.schemas?.[0]?.$ref, "#/components/schemas/WireEvent");
	assert.ok(Object.keys(collection.components.schemas).length > 0);
});
