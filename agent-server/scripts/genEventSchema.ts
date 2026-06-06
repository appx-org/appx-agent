/**
 * Build-time generator for the SSE wire-event JSON Schema.
 *
 * Runs typia over the `WireEvent` TypeScript type and emits an OpenAPI 3.1
 * schema collection to `src/contract/eventSchema.generated.json` (committed). The
 * normal `tsc` build, the `openapi` dump, and the server runtime all read that
 * committed JSON, so typia/ts-patch are only needed here, when regenerating
 * (e.g. after a pi upgrade).
 *
 * typia is a compile-time transformer, so this file must be compiled with the
 * typia transform applied (via `tsconfig.gen.json` + ts-patch's `tspc`); run it
 * with `npm run gen:event-schema`.
 *
 * typia names component schemas after their instantiated type, which yields a
 * few names containing characters that are awkward for downstream codegen (e.g.
 * `ToolResultMessageany.o1`). We sanitize those to safe identifiers and rewrite
 * every `$ref` accordingly before writing.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import typia from "typia";
import type { WireEvent } from "../src/contract/wireEvents.js";
import type { ExtensionUiRequest } from "../src/shared/extensionUi.js";

type JsonSchemaCollection = {
	version: string;
	components: { schemas: Record<string, unknown> };
	schemas: Array<{ $ref: string }>;
};

/** Map a typia component name to a safe OpenAPI/TS-friendly identifier. */
function safeName(name: string): string {
	return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * Rename component schemas with unsafe characters and rewrite every `$ref` to
 * match. Longer names are replaced first so a renamed name that is a prefix of
 * another (e.g. `Foo` vs `Foo.o1`) can't partially clobber it.
 */
function sanitize(collection: JsonSchemaCollection): JsonSchemaCollection {
	const rename = new Map<string, string>();
	for (const key of Object.keys(collection.components.schemas)) {
		const safe = safeName(key);
		if (safe !== key) rename.set(key, safe);
	}

	let serialized = JSON.stringify(collection);
	for (const [from, to] of [...rename].sort((a, b) => b[0].length - a[0].length)) {
		serialized = serialized.split(`#/components/schemas/${from}`).join(`#/components/schemas/${to}`);
	}

	const out = JSON.parse(serialized) as JsonSchemaCollection;
	const renamedSchemas: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(out.components.schemas)) {
		renamedSchemas[rename.get(key) ?? key] = value;
	}
	out.components.schemas = renamedSchemas;
	return out;
}

// `WireEvent` MUST stay first: `openapiEventSchema.ts` treats `schemas[0]` as the
// root wire-event ref. The extra entries force typia to emit named components
// (`ExtensionUiRequest`, and `AgentMessage` transitively) so the REST responses
// that forward these shapes can `$ref` them instead of being typed `unknown[]`.
const collection = typia.json.schemas<
	[WireEvent, ExtensionUiRequest],
	"3.1"
>() as unknown as JsonSchemaCollection;
const sanitized = sanitize(collection);

const outPath = resolve(process.cwd(), "src/contract/eventSchema.generated.json");
writeFileSync(outPath, `${JSON.stringify(sanitized, null, 2)}\n`);
console.log(
	`[gen:event-schema] wrote ${outPath} (${Object.keys(sanitized.components.schemas).length} components)`,
);
