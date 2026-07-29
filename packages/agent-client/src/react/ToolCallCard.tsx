import { useState } from 'react';
import type { UiMessagePart } from '../core/types';

type Tool = Extract<UiMessagePart, { type: 'tool' }>;

export interface ToolCallCardProps {
  tool: Tool;
  /** Whether the card starts expanded. Default: true. */
  defaultOpen?: boolean;
  className?: string;
}

function formatJson(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

/** Produces a compact one-line summary of a tool call for the collapsed header. */
function summarise(tool: Tool): string {
  const args = (tool.args ?? {}) as Record<string, unknown>;
  switch (tool.name) {
    case 'read':
    case 'write':
    case 'edit':
      return String(args.path ?? args.file_path ?? '');
    case 'bash':
      return String(args.command ?? '').replace(/\s+/g, ' ').trim();
    case 'glob':
    case 'grep':
      return String(args.pattern ?? args.query ?? '');
    default:
      return truncate(formatJson(args).replace(/\s+/g, ' '), 90);
  }
}

/** Collapsible card showing a single tool call's status, arguments and result. */
export function ToolCallCard({ tool, defaultOpen = true, className }: ToolCallCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const result = formatJson(tool.result);
  const args = formatJson(tool.args);
  const summary = summarise(tool);

  return (
    <div className={['agent-chat-tool-card', className].filter(Boolean).join(' ')}>
      <button
        type="button"
        className="agent-chat-tool-header"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span
          className="agent-chat-tool-status"
          data-status={tool.status}
        >
          {tool.status}
        </span>
        <span className="agent-chat-tool-name">{tool.name}</span>
        {summary && <span className="agent-chat-tool-summary">{summary}</span>}
        <span className="agent-chat-tool-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="agent-chat-tool-body">
          {args && args !== '{}' && (
            <>
              <span className="agent-chat-tool-label">arguments</span>
              <pre className="agent-chat-tool-pre">{truncate(args, 4000)}</pre>
            </>
          )}
          {result && (
            <>
              <span className="agent-chat-tool-label">{tool.isError ? 'error' : 'result'}</span>
              <pre className="agent-chat-tool-pre">{truncate(result, 4000)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
