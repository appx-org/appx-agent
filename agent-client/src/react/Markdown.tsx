import { useState, useRef, useEffect } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export interface MarkdownProps {
  text: string;
  /**
   * When true, the source text is still streaming in. Parsing is then throttled
   * to a fixed cadence instead of running on every token, and a final parse is
   * flushed when streaming ends. Defaults to false (parse immediately).
   */
  streaming?: boolean;
  className?: string;
}

/** Max markdown re-parse frequency while streaming (~10 fps is imperceptible). */
const STREAM_PARSE_INTERVAL_MS = 100;

/** Parse markdown to sanitized HTML (OWASP A03 — defends against XSS in model output). */
function renderMarkdown(text: string): string {
  if (!text) return '';
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}

/**
 * Renders a markdown string as sanitized HTML and decorates code blocks with a
 * copy button.
 *
 * Re-parsing markdown is O(text length); doing it on every streamed token is
 * O(n²) over a turn and dominates streaming cost. While `streaming` is true we
 * therefore re-parse on a fixed interval (reading the latest text from a ref)
 * rather than on every render, and flush one final parse when streaming stops.
 */
export function Markdown({ text, streaming = false, className }: MarkdownProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string>(() => renderMarkdown(text));

  // Always expose the latest text to the streaming cadence below without making
  // that effect depend on (and restart on) every token.
  const textRef = useRef(text);
  textRef.current = text;

  // Static / finalized text: parse immediately on change.
  useEffect(() => {
    if (streaming) return;
    setHtml(renderMarkdown(text));
  }, [text, streaming]);

  // Streaming text: parse on a fixed cadence, and flush the final text on stop.
  useEffect(() => {
    if (!streaming) return;
    setHtml(renderMarkdown(textRef.current));
    const timer = setInterval(() => setHtml(renderMarkdown(textRef.current)), STREAM_PARSE_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      setHtml(renderMarkdown(textRef.current));
    };
  }, [streaming]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const pres = container.querySelectorAll('pre');
    pres.forEach((pre) => {
      if (pre.querySelector('[data-copy-btn]')) return;
      const btn = document.createElement('button');
      btn.setAttribute('data-copy-btn', '');
      btn.className = 'agent-chat-copy-btn';
      btn.textContent = 'Copy';
      btn.addEventListener('click', () => {
        const code = pre.querySelector('code');
        const value = code?.textContent ?? pre.textContent ?? '';
        void navigator.clipboard.writeText(value).then(() => {
          btn.textContent = 'Copied!';
          setTimeout(() => {
            btn.textContent = 'Copy';
          }, 2000);
        });
      });
      pre.appendChild(btn);
    });
  }, [html]);

  return (
    <div
      ref={containerRef}
      className={['agent-chat-markdown', className].filter(Boolean).join(' ')}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
