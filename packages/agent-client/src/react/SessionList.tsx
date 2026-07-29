import { useCallback, useEffect, useState } from 'react';
import type { AgentSessionInfo } from '../core/types';
import { useAgentChatContext } from './context';

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
  className?: string;
}

function labelFor(session: AgentSessionInfo): string {
  return session.firstMessage?.trim() || 'Untitled';
}

/** Sidebar listing a project's sessions with create + delete actions. */
export function SessionList({
  projectId,
  activeSessionId,
  refreshTick = 0,
  onSelectSession,
  onDeleteSession,
  className,
}: SessionListProps) {
  const { store, client, classNames, labels } = useAgentChatContext();
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const fetchSessions = useCallback(async () => {
    try {
      const res = await client.listSessions(projectId);
      setSessions(res.sessions);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions');
    }
  }, [client, projectId]);

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions, refreshTick]);

  const handleCreate = async () => {
    setCreating(true);
    setError('');
    try {
      const session = await client.createSession(projectId);
      await fetchSessions();
      onSelectSession(session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (sessionId: string) => {
    // Deletion is irreversible (transcripts are not recoverable), so confirm
    // before the destructive call. `window.confirm` keeps the SDK dependency-free;
    // hosts wanting a custom dialog can build their own list against the client.
    if (typeof window !== 'undefined' && !window.confirm(labels.confirmDeleteSession)) return;
    setDeletingId(sessionId);
    setError('');
    try {
      // Go through the store so the live SSE stream + cached state are torn down,
      // not just the server-side record.
      await store.deleteSession(projectId, sessionId);
      await fetchSessions();
      onDeleteSession?.(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete session');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className={['agent-chat-session-list', classNames.sessionList, className].filter(Boolean).join(' ')}>
      <div className="agent-chat-session-header">
        <span className="agent-chat-session-title">{labels.sessionsTitle}</span>
        <button className="agent-chat-session-create" onClick={() => void handleCreate()} disabled={creating}>
          {creating ? '...' : labels.newSession}
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
                  ? 'agent-chat-session-item agent-chat-session-item-active'
                  : 'agent-chat-session-item'
              }
            >
              <button
                className="agent-chat-session-item-select"
                onClick={() => onSelectSession(session.id)}
                title={labelFor(session)}
              >
                <span className="agent-chat-session-item-title">{labelFor(session)}</span>
                <span className="agent-chat-session-item-meta">
                  {session.id.slice(0, 8)} · {session.messageCount} msg
                </span>
              </button>
              <button
                className="agent-chat-session-item-delete"
                onClick={() => void handleDelete(session.id)}
                disabled={deletingId === session.id}
                aria-label={labels.deleteSession}
                title={labels.deleteSession}
              >
                {deletingId === session.id ? '...' : '×'}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
