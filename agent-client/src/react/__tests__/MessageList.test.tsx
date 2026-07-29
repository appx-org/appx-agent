// @vitest-environment jsdom
/**
 * Smoke tests for the virtualized transcript wrapper. `react-virtuoso` measures
 * the scroller/items via `ResizeObserver` + real layout, which jsdom doesn't
 * provide, so it never completes its measure cycle here and renders no item DOM.
 * Rather than fake the layout with brittle mocks, we treat windowing as the
 * library's (well-tested) responsibility and assert only *our* wiring: the
 * component mounts without throwing, applies the scroller class, and renders the
 * Virtuoso scaffolding. The data → UiMessage mapping is covered by the reducer
 * tests; the prop contract is enforced by `tsc`.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MessageList } from "../MessageList";
import type { UiMessage } from "../../core/types";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  Element.prototype.scrollTo = () => {};
});

afterEach(cleanup);

const messages: UiMessage[] = [
  { id: "h0", role: "user", parts: [{ type: "text", text: "first" }], streaming: false, timestamp: "t0" },
  { id: "h1", role: "assistant", parts: [{ type: "text", text: "second" }], streaming: false, timestamp: "t1" },
];

describe("MessageList", () => {
  it("mounts and applies the agent-chat-messages class to the scroller", () => {
    const { container } = render(
      <MessageList messages={messages} renderItem={(m) => <span>{m.id}</span>} />,
    );
    expect(container.querySelector(".agent-chat-messages")).toBeTruthy();
  });

  it("merges a custom className onto the scroller", () => {
    const { container } = render(
      <MessageList messages={messages} className="custom-x" renderItem={(m) => <span>{m.id}</span>} />,
    );
    const scroller = container.querySelector(".agent-chat-messages");
    expect(scroller?.classList.contains("custom-x")).toBe(true);
  });

  it("renders the Virtuoso list scaffolding", () => {
    const { container } = render(
      <MessageList messages={messages} renderItem={(m) => <span>{m.id}</span>} />,
    );
    expect(container.querySelector('[data-testid="virtuoso-item-list"]')).toBeTruthy();
  });
});
