import { memo } from "react";
import type { UiMessage, UiMessagePart } from "../core/types";
import { Markdown } from "./Markdown";
import { ToolCallCard } from "./ToolCallCard";

/** Stable per-part key for React reconciliation within a message. */
function partKey(part: UiMessagePart, index: number): string {
  return part.type === "tool"
    ? `tool-${part.id || index}`
    : `text-${part.contentIndex ?? index}`;
}

interface MessagePartProps {
  part: UiMessagePart;
  /** True only for the actively-growing block, so markdown parsing throttles. */
  streaming: boolean;
  toolCardClass?: string;
}

/**
 * One rendered part (text or tool call), memoized so that — combined with the
 * reducer preserving references for unchanged parts — a settled part above the
 * streaming cursor neither re-renders nor re-parses its markdown.
 */
const MessagePart = memo(function MessagePart({ part, streaming, toolCardClass }: MessagePartProps) {
  if (part.type === "text") {
    return part.text ? <Markdown text={part.text} streaming={streaming} /> : null;
  }
  return <ToolCallCard tool={part} className={toolCardClass} />;
});

export interface MessageItemProps {
  message: UiMessage;
  agentName: string;
  userName: string;
  messageClass?: string;
  userMessageClass?: string;
  assistantMessageClass?: string;
  toolCardClass?: string;
}

/**
 * A single transcript message, memoized on its props. Because the reducer gives
 * every message a stable `id` and only replaces the *streaming* message's object
 * per token, every other message bails out of re-rendering during streaming.
 */
export const MessageItem = memo(function MessageItem({
  message,
  agentName,
  userName,
  messageClass,
  userMessageClass,
  assistantMessageClass,
  toolCardClass,
}: MessageItemProps) {
  const roleClass =
    message.role === "user"
      ? ["agent-chat-msg", "agent-chat-msg-user", userMessageClass]
      : ["agent-chat-msg", "agent-chat-msg-assistant", assistantMessageClass];
  const lastIndex = message.parts.length - 1;

  return (
    <div className={[...roleClass, messageClass].filter(Boolean).join(" ")}>
      <span className="agent-chat-msg-role">
        {message.role === "user" ? userName : agentName}
      </span>
      {message.parts.length === 0 && message.streaming && <Markdown text="..." />}
      {message.parts.map((part, index) => (
        <MessagePart
          key={partKey(part, index)}
          part={part}
          streaming={message.streaming && index === lastIndex}
          toolCardClass={toolCardClass}
        />
      ))}
    </div>
  );
});
