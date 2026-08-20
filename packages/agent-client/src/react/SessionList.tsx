import { useAgentChatContext } from "./context.js";
import { type AgentSessionsController, sessionLabel, useAgentSessions } from "./useAgentSessions.js";

export interface SessionListProps {
	projectId: string;
	activeSessionId: string | null;
	/** Bump this value to force a reload (e.g. after a turn completes). */
	refreshTick?: number;
	onSelectSession: (id: string) => void;
	/**
	 * Notified after a session is deleted. Lets the host react — e.g. clear the
	 * active session or switch to another one when the deleted session was open.
	 */
	onDeleteSession?: (id: string) => void;
	/** Reuse a controller owned by a parent layout to avoid duplicate requests. */
	controller?: AgentSessionsController;
	id?: string;
	className?: string;
}

/** Sidebar listing a project's sessions with create + delete actions. */
export function SessionList({ controller, refreshTick, ...props }: SessionListProps) {
	return controller ? (
		<SessionListView {...props} controller={controller} />
	) : (
		<ManagedSessionList {...props} refreshTick={refreshTick} />
	);
}

function ManagedSessionList(props: Omit<SessionListProps, "controller">) {
	const controller = useAgentSessions(props.projectId, { refreshTick: props.refreshTick });
	return <SessionListView {...props} controller={controller} />;
}

function SessionListView({
	activeSessionId,
	onSelectSession,
	onDeleteSession,
	controller,
	id,
	className,
}: Omit<SessionListProps, "refreshTick"> & { controller: AgentSessionsController }) {
	const { classNames, labels } = useAgentChatContext();
	const { sessions, creating, deletingId, error, createSession, deleteSession } = controller;

	const handleCreate = async () => {
		const sessionId = await createSession();
		if (sessionId) onSelectSession(sessionId);
	};

	const handleDelete = async (sessionId: string) => {
		// Deletion is irreversible (transcripts are not recoverable), so confirm
		// before the destructive call. `window.confirm` keeps the SDK dependency-free;
		// hosts wanting a custom dialog can build their own list against the client.
		if (typeof window !== "undefined" && !window.confirm(labels.confirmDeleteSession)) return;
		if (await deleteSession(sessionId)) onDeleteSession?.(sessionId);
	};

	return (
		<div id={id} className={["agent-chat-session-list", classNames.sessionList, className].filter(Boolean).join(" ")}>
			<div className="agent-chat-session-header">
				<span className="agent-chat-session-title">{labels.sessionsTitle}</span>
				<button
					type="button"
					className="agent-chat-session-create"
					onClick={() => void handleCreate()}
					disabled={creating}
				>
					{creating ? "..." : labels.newSession}
				</button>
			</div>
			{error && <div className="agent-chat-session-error">{error}</div>}
			<div className="agent-chat-session-items">
				{sessions.length === 0 ? (
					<span className="agent-chat-session-empty">{labels.emptySessions}</span>
				) : (
					sessions.map((session) => (
						<div
							key={session.id}
							className={
								session.id === activeSessionId
									? "agent-chat-session-item agent-chat-session-item-active"
									: "agent-chat-session-item"
							}
						>
							<button
								type="button"
								className="agent-chat-session-item-select"
								onClick={() => onSelectSession(session.id)}
								title={sessionLabel(session)}
							>
								<span className="agent-chat-session-item-title">{sessionLabel(session)}</span>
								<span className="agent-chat-session-item-meta">
									{session.id.slice(0, 8)} · {session.messageCount} msg
								</span>
							</button>
							<button
								type="button"
								className="agent-chat-session-item-delete"
								onClick={() => void handleDelete(session.id)}
								disabled={deletingId === session.id}
								aria-label={labels.deleteSession}
								title={labels.deleteSession}
							>
								{deletingId === session.id ? "..." : "×"}
							</button>
						</div>
					))
				)}
			</div>
		</div>
	);
}
