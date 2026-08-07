/**
 * Pure helpers for project deployment metadata.
 *
 * Two consumers share these: the registry materialises `.pi/deployment.json`
 * (machine-readable copy the agent can `cat`), and the runtime injects a short
 * "Deployment" section into the system prompt. Both are derived from the same
 * control-plane-authored record, so the agent's instructions can never drift
 * from the file. See docs/plans/builder-containers-plan.md D2 + D6.
 */
import { PROJECT_LABEL_KEY } from "./appContainers.js";
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
 * Serialise deployment metadata with a stable key order (project first, then dev
 * before prod, port before url) so the materialised `.pi/deployment.json` is
 * diff-friendly and reproducible regardless of the input object's property
 * order.
 *
 * `projectId` is server-derived rather than control-plane-authored: it is the
 * project's canonical id, which the deploy-app skill reads to label every
 * resource it creates so deletion can reap them (issue #10). It is deliberately
 * absent from the `Deployment` type and the OpenAPI contract — this file is the
 * only consumer.
 */
export function buildDeploymentJson(deployment: Deployment | undefined, projectId: string): string {
	const ordered: Deployment & { project: string } = { project: projectId };
	if (!isTargetEmpty(deployment?.dev)) ordered.dev = orderTarget(deployment?.dev);
	if (!isTargetEmpty(deployment?.prod)) ordered.prod = orderTarget(deployment?.prod);
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
 * project's `.pi/AGENTS.md`. Returns undefined only when there is nothing at all
 * to surface (no project id and no metadata), so callers can skip injection.
 *
 * The project id is stated whenever it is known, independently of the
 * ports/URLs: it is the label value that makes a project's containers reapable
 * on delete (issue #10), and a project without deployment metadata can still be
 * deployed if the user asks.
 *
 * Stack-agnostic: it states the two-container (DEV/PROD, same build) model, the
 * ports/URLs, the container-port mapping caveat, and points at the deploy skill
 * and the machine-readable copy. It encodes no framework assumptions.
 */
export function buildDeploymentPromptSection(
	deployment: Deployment | undefined,
	appContainerRuntime: string,
	projectId: string | undefined,
): string | undefined {
	const hasTargets = !isDeploymentEmpty(deployment);
	if (!hasTargets && !projectId) return undefined;
	const dev = deployment?.dev;
	const prod = deployment?.prod;

	const lines: string[] = ["## Deployment"];
	if (projectId) {
		lines.push(
			`Project id: ${projectId}`,
			`Label EVERY container, network and volume you create with \`--label ${PROJECT_LABEL_KEY}=${projectId}\`,`,
			"so deleting this project reaps them. Unlabelled resources leak and keep their ports bound.",
		);
	}
	if (hasTargets) {
		lines.push("This project runs as TWO containers from the SAME build (two instances, not two builds):");
	}
	if (!isTargetEmpty(dev)) {
		lines.push(`- DEV  (iterate here):   ${describeTarget(dev)}   (container <project>-app-dev)`);
	}
	if (!isTargetEmpty(prod)) {
		lines.push(`- PROD (stable, shared): ${describeTarget(prod)}   (container <project>-app-prod)`);
	}
	if (hasTargets) {
		lines.push(
			'Refinements rebuild + redeploy DEV; PROD changes only when you "promote".',
			"The app listens on its container port; map it with -p <reserved host port>:<container port>.",
		);
	}
	lines.push(
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
