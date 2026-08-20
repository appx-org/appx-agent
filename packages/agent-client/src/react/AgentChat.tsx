import { type ReactNode, useCallback, useId, useState } from "react";
import type { UiMessage } from "../core/types.js";
import { ChatPanel } from "./ChatPanel.js";
import { useAgentChatContext } from "./context.js";
import { SessionList } from "./SessionList.js";
import { sessionLabel, useAgentSessions } from "./useAgentSessions.js";

export interface AgentChatProps {
	/** The agent-server project to scope sessions to. */
	projectId: string;
	/** Hide the session sidebar (single-session embedding). Default: false. */
	hideSessionList?: boolean;
	/** Controlled active session id. Use `null` for no selection. */
	activeSessionId?: string | null;
	/** Initial active session id when selection is uncontrolled. */
	defaultActiveSessionId?: string | null;
	/** Called whenever the active session changes. */
	onActiveSessionChange?: (id: string | null) => void;
	/** Allow the built-in session list to be folded. Default: true. */
	collapsibleSessionList?: boolean;
	/** Controlled session-list visibility. */
	sessionListOpen?: boolean;
	/** Initial visibility when session-list state is uncontrolled. Default: true. */
	defaultSessionListOpen?: boolean;
	/** Called whenever session-list visibility changes. */
	onSessionListOpenChange?: (open: boolean) => void;
	/** Called once each time a streaming turn settles back to idle. */
	onTurnComplete?: () => void;
	showModelControls?: boolean;
	showHeader?: boolean;
	renderMessage?: (message: UiMessage, index: number, defaultNode: ReactNode) => ReactNode;
	renderEmpty?: () => ReactNode;
	/** Placeholder shown when no session is selected (and the list is visible). */
	noSelectionPlaceholder?: ReactNode;
	className?: string;
}

/**
 * Batteries-included two-pane chat: a session sidebar plus the active session's
 * `ChatPanel`. For bespoke layouts, compose `SessionList` + `ChatPanel` (or the
 * `useAgentSession` hook) directly instead.
 */
export function AgentChat({
	projectId,
	hideSessionList = false,
	activeSessionId: controlledActiveSessionId,
	defaultActiveSessionId = null,
	onActiveSessionChange,
	collapsibleSessionList = true,
	sessionListOpen: controlledSessionListOpen,
	defaultSessionListOpen = true,
	onSessionListOpenChange,
	onTurnComplete,
	showModelControls,
	showHeader,
	renderMessage,
	renderEmpty,
	noSelectionPlaceholder,
	className,
}: AgentChatProps) {
	const { classNames, labels } = useAgentChatContext();
	const [uncontrolledActiveSessionId, setUncontrolledActiveSessionId] = useState<string | null>(
		defaultActiveSessionId,
	);
	const [uncontrolledSessionListOpen, setUncontrolledSessionListOpen] = useState(defaultSessionListOpen);
	const activeSessionId =
		controlledActiveSessionId !== undefined ? controlledActiveSessionId : uncontrolledActiveSessionId;
	const sessionListOpen =
		controlledSessionListOpen !== undefined ? controlledSessionListOpen : uncontrolledSessionListOpen;
	const sessions = useAgentSessions(projectId, { enabled: !hideSessionList });
	const sessionListId = useId();
	const activeSession = sessions.sessions.find((session) => session.id === activeSessionId);
	const activeSessionLabel = activeSession
		? sessionLabel(activeSession)
		: activeSessionId
			? labels.selectedSession
			: labels.noSession;
	const canUseBuiltInCollapse = collapsibleSessionList && showHeader !== false;
	const hostControlsVisibility = controlledSessionListOpen !== undefined;
	const showSessions = !hideSessionList && (!(canUseBuiltInCollapse || hostControlsVisibility) || sessionListOpen);

	const setActiveSessionId = useCallback(
		(next: string | null) => {
			if (next === activeSessionId) return;
			if (controlledActiveSessionId === undefined) setUncontrolledActiveSessionId(next);
			onActiveSessionChange?.(next);
		},
		[activeSessionId, controlledActiveSessionId, onActiveSessionChange],
	);

	const setSessionListOpen = useCallback(
		(next: boolean) => {
			if (controlledSessionListOpen === undefined) setUncontrolledSessionListOpen(next);
			onSessionListOpenChange?.(next);
		},
		[controlledSessionListOpen, onSessionListOpenChange],
	);

	const sessionListControl = canUseBuiltInCollapse ? (
		<button
			type="button"
			className={["agent-chat-session-toggle", classNames.sessionToggle].filter(Boolean).join(" ")}
			onClick={() => setSessionListOpen(!sessionListOpen)}
			aria-expanded={sessionListOpen}
			aria-controls={sessionListId}
			title={sessionListOpen ? labels.hideSessions : labels.showSessions}
		>
			<span className="agent-chat-session-toggle-action">
				{sessionListOpen ? labels.hideSessions : labels.showSessions}
			</span>
			<span className="agent-chat-session-toggle-current">{activeSessionLabel}</span>
		</button>
	) : undefined;

	const handleTurnComplete = useCallback(() => {
		if (!hideSessionList) void sessions.refresh();
		onTurnComplete?.();
	}, [hideSessionList, sessions.refresh, onTurnComplete]);

	return (
		<div className={["agent-client-root", "agent-chat-layout", classNames.root, className].filter(Boolean).join(" ")}>
			{showSessions && (
				<SessionList
					id={sessionListId}
					projectId={projectId}
					activeSessionId={activeSessionId}
					controller={sessions}
					onSelectSession={setActiveSessionId}
					onDeleteSession={(id) => {
						if (activeSessionId === id) setActiveSessionId(null);
					}}
				/>
			)}
			{activeSessionId ? (
				<ChatPanel
					projectId={projectId}
					sessionId={activeSessionId}
					onTurnComplete={handleTurnComplete}
					headerStart={sessionListControl}
					showModelControls={showModelControls}
					showHeader={showHeader}
					renderMessage={renderMessage}
					renderEmpty={renderEmpty}
				/>
			) : (
				<div className="agent-chat-no-selection">
					{sessionListControl}
					{noSelectionPlaceholder ?? (
						<span className="agent-chat-no-selection-text">Select or create a session</span>
					)}
				</div>
			)}
		</div>
	);
}
