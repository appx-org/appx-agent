/**
 * Pure helpers for project deployment metadata.
 *
 * Two consumers share these: the registry materialises `.pi/deployment.json`
 * (machine-readable copy the agent can `cat`), and the runtime injects a short
 * "Deployment" section into the system prompt. Both are derived from the same
 * control-plane-authored record, so the agent's instructions can never drift
 * from the file. See docs/plans/builder-containers-plan.md D2 + D6.
 */
import type { Deployment, DeploymentTarget } from "./projectStore.js";

export type { Deployment, DeploymentTarget };

/** True when neither environment carries a port or URL (nothing to surface). */
export function isDeploymentEmpty(deployment: Deployment | undefined): boolean {
	if (!deployment) return true;
	return isTargetEmpty(deployment.dev) && isTargetEmpty(deployment.prod);
}

function isTargetEmpty(target: DeploymentTarget | undefined): boolean {
	return !target || (target.port === undefined && target.url === undefined);
}

/**
 * Serialise deployment metadata with a stable key order (dev before prod, port
 * before url) so the materialised `.pi/deployment.json` is diff-friendly and
 * reproducible regardless of the input object's property order.
 */
export function buildDeploymentJson(deployment: Deployment): string {
	const ordered: Deployment = {};
	if (!isTargetEmpty(deployment.dev)) ordered.dev = orderTarget(deployment.dev);
	if (!isTargetEmpty(deployment.prod)) ordered.prod = orderTarget(deployment.prod);
	return `${JSON.stringify(ordered, null, 2)}\n`;
}

function orderTarget(target: DeploymentTarget | undefined): DeploymentTarget {
	const ordered: DeploymentTarget = {};
	if (target?.port !== undefined) ordered.port = target.port;
	if (target?.url !== undefined) ordered.url = target.url;
	return ordered;
}

/**
 * Build the generated "Deployment" system-prompt section appended after the
 * project's `.pi/AGENTS.md`. Returns undefined when there is nothing to surface
 * so callers can skip injection entirely.
 *
 * Stack-agnostic: it states the two-container (DEV/PROD, same build) model, the
 * ports/URLs, the container-port mapping caveat, and points at the deploy skill
 * and the machine-readable copy. It encodes no framework assumptions.
 */
export function buildDeploymentPromptSection(
	deployment: Deployment | undefined,
	appContainerRuntime: string,
): string | undefined {
	if (isDeploymentEmpty(deployment)) return undefined;
	const dev = deployment?.dev;
	const prod = deployment?.prod;

	const lines: string[] = [
		"## Deployment",
		"This project runs as TWO containers from the SAME build (two instances, not two builds):",
	];
	if (!isTargetEmpty(dev)) {
		lines.push(`- DEV  (iterate here):   ${describeTarget(dev)}   (container <project>-app-dev)`);
	}
	if (!isTargetEmpty(prod)) {
		lines.push(`- PROD (stable, shared): ${describeTarget(prod)}   (container <project>-app-prod)`);
	}
	lines.push(
		'Refinements rebuild + redeploy DEV; PROD changes only when you "promote".',
		"The app listens on its container port; map it with -p <reserved host port>:<container port>.",
		`Container runtime: ${appContainerRuntime}. See the deploy-app skill for build/run/redeploy/promote conventions.`,
		"Machine-readable copy: .pi/deployment.json",
	);
	return lines.join("\n");
}

/** Render `host port <port> → <url>`, gracefully degrading when a field is absent. */
function describeTarget(target: DeploymentTarget | undefined): string {
	const port = target?.port !== undefined ? `host port ${target.port}` : "host port (unset)";
	return target?.url ? `${port} → ${target.url}` : port;
}
