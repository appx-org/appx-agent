import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { AgentClient, type AgentClientConfig } from '../core/client';
import { SessionStore } from '../core/store';

/**
 * Slot-level class name overrides. Every component merges its built-in class
 * (e.g. `agent-chat-chat-panel`) with the matching override so consumers can
 * theme via plain CSS without forking components.
 */
export interface AgentChatClassNames {
  root?: string;
  sessionList?: string;
  chatPanel?: string;
  message?: string;
  userMessage?: string;
  assistantMessage?: string;
  toolCard?: string;
  inputBar?: string;
}

/** User-facing string overrides for light localization / branding. */
export interface AgentChatLabels {
  agentName?: string;
  userName?: string;
  sessionsTitle?: string;
  newSession?: string;
  deleteSession?: string;
  confirmDeleteSession?: string;
  emptyConversation?: string;
  emptySessions?: string;
  sendButton?: string;
  stopButton?: string;
  inputPlaceholder?: string;
  workingPlaceholder?: string;
}

const defaultLabels: Required<AgentChatLabels> = {
  agentName: 'AGENT',
  userName: 'YOU',
  sessionsTitle: 'SESSIONS',
  newSession: '+ New',
  deleteSession: 'Delete session',
  confirmDeleteSession: 'Delete this session and its history? This cannot be undone.',
  emptyConversation: 'Send a prompt to start',
  emptySessions: 'No sessions yet',
  sendButton: 'Send',
  stopButton: 'Stop',
  inputPlaceholder: 'Send a message...',
  workingPlaceholder: 'Agent is working...',
};

interface AgentChatContextValue {
  client: AgentClient;
  store: SessionStore;
  classNames: AgentChatClassNames;
  labels: Required<AgentChatLabels>;
}

const AgentChatContext = createContext<AgentChatContextValue | null>(null);

export interface AgentChatProviderProps {
  /** A pre-built client. Mutually exclusive with `config`. */
  client?: AgentClient;
  /** Config used to build a client when `client` is not supplied. */
  config?: AgentClientConfig;
  classNames?: AgentChatClassNames;
  labels?: AgentChatLabels;
  children: ReactNode;
}

/**
 * Provides a shared `AgentClient` + `SessionStore` (and theming defaults) to all
 * agent-chat components below it. Memoizes the store so a single SSE connection
 * is shared across the subtree.
 */
export function AgentChatProvider({ client, config, classNames, labels, children }: AgentChatProviderProps) {
  // The client + store are the expensive, stateful layer (one SSE connection and
  // the live SessionState), so they are memoized *independently of theming*.
  // They rebuild only when `client`/`config` identity changes — never when
  // `classNames`/`labels` change — so passing inline theme objects (a new object
  // each render) can't tear down and reconnect a live session. See
  // docs/architecture/chat-ui-session-flow.md, improvement item 3.
  const resolvedClient = useMemo(() => client ?? new AgentClient(config), [client, config]);
  const store = useMemo(() => new SessionStore(resolvedClient), [resolvedClient]);

  const value = useMemo<AgentChatContextValue>(
    () => ({
      client: resolvedClient,
      store,
      classNames: classNames ?? {},
      labels: { ...defaultLabels, ...labels },
    }),
    [resolvedClient, store, classNames, labels],
  );

  return <AgentChatContext.Provider value={value}>{children}</AgentChatContext.Provider>;
}

/** Reads the agent-chat context; throws if used outside an `AgentChatProvider`. */
export function useAgentChatContext(): AgentChatContextValue {
  const ctx = useContext(AgentChatContext);
  if (!ctx) throw new Error('agent-client components must be used within <AgentChatProvider>');
  return ctx;
}
