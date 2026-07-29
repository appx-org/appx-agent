import { useEffect, useState } from 'react';
import type { ExtensionUiRequest, ExtensionUiResponse } from '../core/types';

export type BlockingExtensionUiRequest =
  | Extract<ExtensionUiRequest, { method: 'select' }>
  | Extract<ExtensionUiRequest, { method: 'confirm' }>
  | Extract<ExtensionUiRequest, { method: 'input' }>
  | Extract<ExtensionUiRequest, { method: 'editor' }>;

export function isBlockingRequest(request: ExtensionUiRequest): request is BlockingExtensionUiRequest {
  return (
    request.method === 'select' ||
    request.method === 'confirm' ||
    request.method === 'input' ||
    request.method === 'editor'
  );
}

export interface ExtensionRequestPanelProps {
  request: BlockingExtensionUiRequest;
  onRespond: (requestId: string, response: ExtensionUiResponse) => Promise<void>;
}

/**
 * Renders a blocking extension-UI request (select / confirm / input / editor)
 * and resolves it back to the agent. Mirrors the four interactive pi request
 * methods documented by agent-server.
 */
export function ExtensionRequestPanel({ request, onRespond }: ExtensionRequestPanelProps) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (request.method === 'editor') setValue(request.prefill ?? '');
    else if (request.method === 'select') setValue(request.options[0] ?? '');
    else setValue('');
    setError('');
  }, [request]);

  const sendResponse = async (response: ExtensionUiResponse) => {
    setBusy(true);
    setError('');
    try {
      await onRespond(request.id, response);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-chat-ext-panel">
      <div className="agent-chat-ext-header">
        <span className="agent-chat-ext-kicker">AGENT REQUEST</span>
        <span className="agent-chat-ext-title">{request.title}</span>
      </div>
      {request.method === 'confirm' && <pre className="agent-chat-ext-message">{request.message}</pre>}
      {request.method === 'input' && (
        <input
          className="agent-chat-ext-input"
          value={value}
          placeholder={request.placeholder || 'Value'}
          onChange={(event) => setValue(event.target.value)}
          disabled={busy}
        />
      )}
      {request.method === 'editor' && (
        <textarea
          className="agent-chat-ext-textarea"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={busy}
          rows={5}
        />
      )}
      {request.method === 'select' && (
        <select
          className="agent-chat-ext-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={busy}
        >
          {request.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      )}
      {error && <div className="agent-chat-ext-error">{error}</div>}
      <div className="agent-chat-ext-actions">
        {request.method === 'confirm' ? (
          <>
            <button className="agent-chat-btn-secondary" disabled={busy} onClick={() => void sendResponse({ confirmed: false })}>
              Deny
            </button>
            <button className="agent-chat-btn-primary" disabled={busy} onClick={() => void sendResponse({ confirmed: true })}>
              Approve
            </button>
          </>
        ) : (
          <>
            <button className="agent-chat-btn-secondary" disabled={busy} onClick={() => void sendResponse({ cancelled: true })}>
              Cancel
            </button>
            <button className="agent-chat-btn-primary" disabled={busy} onClick={() => void sendResponse({ value })}>
              {request.method === 'select' ? 'Choose' : 'Submit'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
