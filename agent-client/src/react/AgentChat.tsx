import { useCallback, useState, type ReactNode } from "react";
import type { UiMessage } from "../core/types";
import { useAgentChatContext } from "./context";
import { SessionList } from "./SessionList";
import { ChatPanel } from "./ChatPanel";

export interface AgentChatProps {
  /** The agent-server project to scope sessions to. */
  projectId: string;
  /** Hide the session sidebar (single-session embedding). Default: false. */
  hideSessionList?: boolean;
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
  showModelControls,
  showHeader,
  renderMessage,
  renderEmpty,
  noSelectionPlaceholder,
  className,
}: AgentChatProps) {
  const { classNames } = useAgentChatContext();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const refreshSessions = useCallback(() => setRefreshTick((value) => value + 1), []);

  return (
    <div
      className={["agent-chat-root", "agent-chat-layout", classNames.root, className]
        .filter(Boolean)
        .join(" ")}
    >
      {!hideSessionList && (
        <SessionList
          projectId={projectId}
          activeSessionId={activeSessionId}
          refreshTick={refreshTick}
          onSelectSession={setActiveSessionId}
          onDeleteSession={(id) =>
            setActiveSessionId((current) => (current === id ? null : current))
          }
        />
      )}
      {activeSessionId ? (
        <ChatPanel
          projectId={projectId}
          sessionId={activeSessionId}
          onTurnComplete={refreshSessions}
          showModelControls={showModelControls}
          showHeader={showHeader}
          renderMessage={renderMessage}
          renderEmpty={renderEmpty}
        />
      ) : (
        <div className="agent-chat-no-selection">
          {noSelectionPlaceholder ?? (
            <span className="agent-chat-no-selection-text">Select or create a session</span>
          )}
        </div>
      )}
    </div>
  );
}
