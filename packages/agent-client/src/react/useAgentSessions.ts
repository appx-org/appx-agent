import { useCallback, useEffect, useState } from "react";
import { stripAttachmentNote } from "../core/attachments.js";
import type { AgentSessionInfo } from "../core/types.js";
import { useAgentChatContext } from "./context.js";

export interface AgentSessionsController {
	sessions: AgentSessionInfo[];
	loading: boolean;
	creating: boolean;
	deletingId: string | null;
	error: string;
	refresh: () => Promise<void>;
	createSession: () => Promise<string | null>;
	deleteSession: (sessionId: string) => Promise<boolean>;
}

export function sessionLabel(session: AgentSessionInfo): string {
	// `firstMessage` is the *stored* prompt, so it carries the attachment note the
	// server appended. Strip it, same as the transcript does.
	return stripAttachmentNote(session.firstMessage ?? "").text.trim() || "Untitled";
}

export interface UseAgentSessionsOptions {
	/** Bump to force a reload (for example after an external mutation). */
	refreshTick?: number;
	/** Disable all loading while the surrounding UI does not need session data. */
	enabled?: boolean;
}

/** Load and mutate a project's sessions without imposing any layout. */
export function useAgentSessions(
	projectId: string,
	{ refreshTick = 0, enabled = true }: UseAgentSessionsOptions = {},
): AgentSessionsController {
	const { store, client } = useAgentChatContext();
	const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [creating, setCreating] = useState(false);
	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [error, setError] = useState("");

	const refresh = useCallback(async () => {
		if (!enabled) return;
		setLoading(true);
		try {
			const response = await client.listSessions(projectId);
			setSessions(response.sessions);
			setError("");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load sessions");
		} finally {
			setLoading(false);
		}
	}, [client, projectId, enabled]);

	// biome-ignore lint/correctness/useExhaustiveDependencies(refreshTick): caller-owned counter intentionally forces a refetch.
	useEffect(() => {
		if (!enabled) {
			setLoading(false);
			return;
		}
		void refresh();
	}, [enabled, refresh, refreshTick]);

	const createSession = useCallback(async () => {
		setCreating(true);
		setError("");
		try {
			const session = await client.createSession(projectId);
			await refresh();
			return session.id;
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to create session");
			return null;
		} finally {
			setCreating(false);
		}
	}, [client, projectId, refresh]);

	const deleteSession = useCallback(
		async (sessionId: string) => {
			setDeletingId(sessionId);
			setError("");
			try {
				// The store owns live SSE and cached state, so deletion must pass
				// through it rather than only removing the server-side transcript.
				await store.deleteSession(projectId, sessionId);
				await refresh();
				return true;
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to delete session");
				return false;
			} finally {
				setDeletingId(null);
			}
		},
		[store, projectId, refresh],
	);

	return { sessions, loading, creating, deletingId, error, refresh, createSession, deleteSession };
}
