import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  initialSessionState,
  type ExtensionUiResponse,
  type SessionState,
  type ThinkingLevel,
} from '../core/types';
import { useAgentChatContext } from './context';

export interface UseAgentSessionResult {
  state: SessionState;
  sendPrompt: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  respondExtensionRequest: (requestId: string, response: ExtensionUiResponse) => Promise<void>;
  /** Load the model catalogue + active settings into the shared session state. */
  loadModelSettings: (options?: { force?: boolean }) => Promise<void>;
  /** Update the session's model/thinking settings (result reflected in `state`). */
  updateModelSettings: (body: {
    provider?: string;
    modelId?: string;
    thinkingLevel?: ThinkingLevel;
  }) => Promise<void>;
}

/**
 * Subscribes a component to a single agent session's live state via the shared
 * `SessionStore`. Returns the current `SessionState` plus bound action helpers.
 * Passing `null` for `sessionId` yields the inert initial state (no connection).
 */
export function useAgentSession(projectId: string, sessionId: string | null): UseAgentSessionResult {
  const { store } = useAgentChatContext();

  useEffect(() => {
    if (!sessionId) return;
    store.attach(projectId, sessionId);
  }, [store, projectId, sessionId]);

  const state = useSyncExternalStore(
    useCallback(
      (listener) => (sessionId ? store.subscribe(projectId, sessionId, listener) : () => {}),
      [store, projectId, sessionId],
    ),
    useCallback(
      () => (sessionId ? store.getSnapshot(projectId, sessionId) : initialSessionState),
      [store, projectId, sessionId],
    ),
    // Server snapshot: SSR/hydration has no live store, so use the inert initial
    // state. Required by React for server-rendered consumers (e.g. Next.js).
    () => initialSessionState,
  );

  const sendPrompt = useCallback(
    async (text: string) => {
      if (!sessionId) return;
      await store.sendPrompt(projectId, sessionId, text);
    },
    [store, projectId, sessionId],
  );

  const abort = useCallback(async () => {
    if (!sessionId) return;
    await store.abort(projectId, sessionId);
  }, [store, projectId, sessionId]);

  const respondExtensionRequest = useCallback(
    async (requestId: string, response: ExtensionUiResponse) => {
      if (!sessionId) return;
      await store.respondExtensionRequest(projectId, sessionId, requestId, response);
    },
    [store, projectId, sessionId],
  );

  const loadModelSettings = useCallback(
    async (options?: { force?: boolean }) => {
      if (!sessionId) return;
      await store.loadModelSettings(projectId, sessionId, options);
    },
    [store, projectId, sessionId],
  );

  const updateModelSettings = useCallback(
    async (body: { provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel }) => {
      if (!sessionId) return;
      await store.updateModelSettings(projectId, sessionId, body);
    },
    [store, projectId, sessionId],
  );

  return { state, sendPrompt, abort, respondExtensionRequest, loadModelSettings, updateModelSettings };
}
