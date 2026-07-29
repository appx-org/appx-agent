import type { ReactNode } from "react";
import { Virtuoso, type Components } from "react-virtuoso";
import type { UiMessage } from "../core/types";

/**
 * Fixed spacers stand in for the scroller's top/bottom gutter. We render them as
 * Virtuoso `Header`/`Footer` (rather than vertical padding on the scroller)
 * because padding on the scrollable element skews Virtuoso's height measurement
 * and its at-bottom detection.
 */
const ListHeader = () => <div aria-hidden className="agent-chat-messages-spacer-top" />;
const ListFooter = () => <div aria-hidden className="agent-chat-messages-spacer-bottom" />;

const VIRTUOSO_COMPONENTS: Components<UiMessage> = {
  Header: ListHeader,
  Footer: ListFooter,
};

export interface MessageListProps {
  /** Full, already-reduced transcript. Only the visible window is mounted. */
  messages: UiMessage[];
  /** Render one message; receives the message and its index in `messages`. */
  renderItem: (message: UiMessage, index: number) => ReactNode;
  className?: string;
}

/**
 * Virtualized (windowed) transcript. Keeps the entire `messages` array in memory
 * but mounts DOM nodes only for the visible window (plus overscan), so very long
 * sessions don't pay for thousands of message/markdown subtrees. This is purely
 * a rendering optimization — the data layer (store/reducer) is untouched.
 *
 * Scroll behavior (delegated to `react-virtuoso`):
 *  - `followOutput="auto"` sticks to the bottom **only while already at the
 *    bottom**, so a new message (or streamed token growing the last message)
 *    keeps the view pinned, while scrolling up to read history releases the pin.
 *  - `initialTopMostItemIndex` starts a freshly-mounted list at the latest
 *    message. The consumer remounts this component per session (via `key`) so
 *    switching sessions re-anchors at that session's newest message.
 *  - `computeItemKey` keys rows by the reducer's stable `message.id`, preserving
 *    the `MessageItem`/`MessagePart` memoization across re-renders.
 */
export function MessageList({ messages, renderItem, className }: MessageListProps) {
  return (
    <Virtuoso<UiMessage>
      className={["agent-chat-messages", className].filter(Boolean).join(" ")}
      data={messages}
      components={VIRTUOSO_COMPONENTS}
      computeItemKey={(_index, message) => message.id}
      itemContent={(index, message) => (
        <div className="agent-chat-msg-row">{renderItem(message, index)}</div>
      )}
      followOutput="auto"
      alignToBottom
      initialTopMostItemIndex={Math.max(0, messages.length - 1)}
      increaseViewportBy={{ top: 600, bottom: 600 }}
    />
  );
}
