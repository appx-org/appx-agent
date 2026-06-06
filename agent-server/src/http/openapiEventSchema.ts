/**
 * Merges the generated SSE wire-event schema (`eventSchema.generated.json`) into
 * an OpenAPI document, and points the SSE endpoint's `text/event-stream`
 * response at it.
 *
 * The REST surface is described by `@hono/zod-openapi` as usual; this adds the
 * one schema that is generated from pi's TypeScript types (via typia) rather
 * than authored as zod. Used by both the static `openapi` dump and the live
 * `/openapi.json` handler so they stay identical.
 */
import { readFileSync } from "node:fs";

type GeneratedCollection = {
	components?: { schemas?: Record<string, unknown> };
	schemas?: Array<{ $ref: string }>;
};

const generated = JSON.parse(
	readFileSync(new URL("./eventSchema.generated.json", import.meta.url), "utf8"),
) as GeneratedCollection;

/** Component schemas generated from `WireEvent` (keyed by sanitized type name). */
export const eventSchemaComponents: Record<string, unknown> = generated.components?.schemas ?? {};

/** `$ref` of the root wire-event schema, e.g. `#/components/schemas/WireEvent`. */
export const wireEventRef: string =
	generated.schemas?.[0]?.$ref ?? "#/components/schemas/WireEvent";

type OpenApiDoc = {
	components?: { schemas?: Record<string, unknown> };
	paths?: Record<string, Record<string, unknown>>;
};

/**
 * Inject the generated wire-event components into `doc` and set every SSE
 * (`text/event-stream`) 200-response schema to reference the root wire event.
 * Mutates and returns `doc`.
 */
export function mergeEventSchema<T>(doc: T): T {
	const target = doc as OpenApiDoc;
	target.components ??= {};
	target.components.schemas = { ...(target.components.schemas ?? {}), ...eventSchemaComponents };

	for (const pathItem of Object.values(target.paths ?? {})) {
		for (const operation of Object.values(pathItem ?? {})) {
			const content = (
				operation as {
					responses?: { "200"?: { content?: Record<string, { schema?: unknown }> } };
				}
			)?.responses?.["200"]?.content?.["text/event-stream"];
			if (content) content.schema = { $ref: wireEventRef };
		}
	}
	return doc;
}
