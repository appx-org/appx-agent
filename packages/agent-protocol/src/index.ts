/**
 * @appx-org/agent-protocol — the published agent-server API contract.
 *
 * - `paths` / `components`: the raw openapi-typescript output, for use with
 *   `openapi-fetch` and other spec-driven tooling.
 * - Friendly aliases (`AgentProject`, `WireEvent`, `AgentMessage`, …): the
 *   ergonomic names consumers import directly.
 * - The JSON artifacts themselves ship in the tarball for non-TypeScript
 *   consumers: `@appx-org/agent-protocol/openapi.json` and
 *   `@appx-org/agent-protocol/eventSchema.generated.json`.
 */
export type { components, operations, paths } from "./schema.generated";
export type * from "./types";
