/**
 * Project id (slug) derivation.
 *
 * A project's `id` is the canonical, URL-safe, filesystem-safe identifier
 * derived from its human-facing `name`. It is immutable once created and is
 * used simultaneously as the registry key, the route path parameter, and the
 * on-disk directory name under `WORKSPACE_DIR/`. See
 * docs/architecture/project-lifecycle-and-workspace-layout.md.
 *
 * Security note (OWASP path traversal): because the only filesystem-bound input
 * is a slugified name, callers cannot smuggle `..` or absolute paths to escape
 * the workspace root — `slugify` only ever emits `[a-z0-9-]`.
 */

/** Directory name reserved for agent-server's org-global state; never a project id. */
export const RESERVED_PROJECT_SLUGS: ReadonlySet<string> = new Set([".pi-global"]);

/** Max slug length, mirroring the appx project-name grammar so ids stay aligned. */
const MAX_SLUG_LENGTH = 63;

/**
 * Convert a human project name into a slug.
 *
 * Lowercases, replaces any run of non-alphanumeric characters with a single
 * hyphen, and trims leading/trailing hyphens. Returns an empty string when the
 * name has no usable characters — callers must treat that as invalid.
 */
export function slugify(name: string): string {
	return name
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "") // strip diacritics
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG_LENGTH)
		.replace(/-+$/g, ""); // re-trim if the slice landed on a hyphen
}

/** A slug is usable if it is non-empty and not a reserved directory name. */
export function isValidProjectSlug(slug: string): boolean {
	return slug.length > 0 && !RESERVED_PROJECT_SLUGS.has(slug);
}

/**
 * Append a short random suffix to disambiguate a colliding slug, e.g.
 * `my-app` -> `my-app-7f3a`. Kept short (4 hex chars) for readable directory
 * names; collisions on the suffix itself are handled by the caller retrying.
 */
export function withCollisionSuffix(slug: string): string {
	const suffix = Math.floor(Math.random() * 0xffff)
		.toString(16)
		.padStart(4, "0");
	return `${slug.slice(0, MAX_SLUG_LENGTH - 5)}-${suffix}`;
}
