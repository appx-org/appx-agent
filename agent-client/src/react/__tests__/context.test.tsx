// @vitest-environment jsdom
/**
 * Tests that the provider's expensive, stateful layer (the `SessionStore` that
 * owns the SSE connection + live state) is decoupled from cheap theming props.
 * A `labels`/`classNames` change must NOT recreate the store, or it would tear
 * down and reconnect any live session (chat-ui-session-flow.md, item 3).
 */
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { AgentChatProvider, useAgentChatContext } from "../context";
import { AgentClient } from "../../core/client";

describe("AgentChatProvider — store stability", () => {
  it("keeps the same store instance when labels change identity", () => {
    const client = new AgentClient({ baseUrl: "http://localhost" });
    let labels: { agentName: string } = { agentName: "A" };

    const { result, rerender } = renderHook(() => useAgentChatContext(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <AgentChatProvider client={client} labels={labels}>
          {children}
        </AgentChatProvider>
      ),
    });

    const firstStore = result.current.store;

    // New labels object identity (as an inline `labels={{...}}` would produce).
    labels = { agentName: "B" };
    rerender();

    expect(result.current.store).toBe(firstStore); // store survives
    expect(result.current.labels.agentName).toBe("B"); // theming still updates
  });

  it("keeps the same store instance when classNames change identity", () => {
    const client = new AgentClient({ baseUrl: "http://localhost" });
    let classNames: { chatPanel: string } = { chatPanel: "x" };

    const { result, rerender } = renderHook(() => useAgentChatContext(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <AgentChatProvider client={client} classNames={classNames}>
          {children}
        </AgentChatProvider>
      ),
    });

    const firstStore = result.current.store;
    classNames = { chatPanel: "y" };
    rerender();

    expect(result.current.store).toBe(firstStore);
    expect(result.current.classNames.chatPanel).toBe("y");
  });

  it("rebuilds the store when the client instance changes", () => {
    let client = new AgentClient({ baseUrl: "http://localhost" });

    const { result, rerender } = renderHook(() => useAgentChatContext(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <AgentChatProvider client={client}>{children}</AgentChatProvider>
      ),
    });

    const firstStore = result.current.store;
    client = new AgentClient({ baseUrl: "http://localhost" });
    rerender();

    expect(result.current.store).not.toBe(firstStore);
  });
});
