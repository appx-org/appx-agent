/**
 * Runtime classification of outgoing SSE events against the published wire
 * contract (`eventSchema.generated.json`, generated from pi's types via typia).
 *
 * This is a deliberately *shallow*, tolerant-reader check, not a deep validator.
 * Deep validation of streaming events would false-alarm on legitimately partial
 * messages (pi's `message_update` carries an in-progress `AssistantMessage`
 * whose required fields fill in over the turn), so deep/strict validation lives
 * in the test suite against curated complete fixtures instead. At runtime we
 * only need the forward-compatibility signal:
 *   - `valid`        — a `type` the published contract commits to.
 *   - `unknown-type` — a `type` not in the contract yet (pi added one): forward
 *                      it and emit a soft signal — forward-compatible by design.
 *   - `invalid`      — not an object / missing a string `type`.
 *
 * The known-type set is derived from the generated schema, so it can never drift
 * from the contract.
 */
import { readFileSync } from "node:fs";

type JsonSchema = {
	$ref?: string;
	oneOf?: JsonSchema[];
	anyOf?: JsonSchema[];
	allOf?: JsonSchema[];
	properties?: { type?: { const?: unknown } };
};

type GeneratedCollection = {
	components: { schemas: Record<string, JsonSchema> };
	schemas: Array<{ $ref: string }>;
};

const generated = JSON.parse(
	readFileSync(new URL("./eventSchema.generated.json", import.meta.url), "utf8"),
) as GeneratedCollection;

const componentName = (ref: string): string => ref.split("/").pop() ?? "";

/** Walk the schema graph collecting every committed `type` discriminator const. */
function collectTypeConsts(
	schema: JsonSchema | undefined,
	schemas: Record<string, JsonSchema>,
	acc: Set<string>,
	seen = new Set<string>(),
): void {
	if (!schema || typeof schema !== "object") return;
	if (schema.$ref) {
		const name = componentName(schema.$ref);
		if (seen.has(name)) return;
		seen.add(name);
		collectTypeConsts(schemas[name], schemas, acc, seen);
		return;
	}
	for (const key of ["oneOf", "anyOf", "allOf"] as const) {
		for (const member of schema[key] ?? []) collectTypeConsts(member, schemas, acc, seen);
	}
	const typeConst = schema.properties?.type?.const;
	if (typeof typeConst === "string") acc.add(typeConst);
}

const rootName = componentName(generated.schemas[0]?.$ref ?? "");
const knownTypes = new Set<string>();
collectTypeConsts(generated.components.schemas[rootName], generated.components.schemas, knownTypes);

/** Event `type`s the published wire contract commits to. Derived from the schema. */
export const KNOWN_AGENT_SESSION_EVENT_TYPES: ReadonlySet<string> = knownTypes;

export type EventValidationResult =
	| { status: "valid" }
	| { status: "unknown-type"; type: string }
	| { status: "invalid"; issues: string };

/**
 * Classify an outgoing SSE event. Never throws and never mutates — callers
 * forward the event regardless and use the result only for observability.
 */
export function validateAgentSessionEvent(event: unknown): EventValidationResult {
	if (!event || typeof event !== "object") {
		return { status: "invalid", issues: "event is not an object" };
	}
	const type = (event as { type?: unknown }).type;
	if (typeof type !== "string") {
		return { status: "invalid", issues: "event is missing a string `type`" };
	}
	if (!knownTypes.has(type)) return { status: "unknown-type", type };
	return { status: "valid" };
}
