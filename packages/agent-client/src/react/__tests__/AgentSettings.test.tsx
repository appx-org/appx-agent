// @vitest-environment jsdom
/**
 * Renders AgentSettings against a mocked AgentClient to assert which credential
 * controls appear for subscription-capable vs api-key-only providers. Guards
 * the regression where only the provider dropdown shows (no key input / no
 * subscription toggle).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { AgentChatProvider } from "../context";
import { AgentSettings } from "../AgentSettings";
import { AgentClient } from "../../core/client";
import type { AgentAuthProvider } from "../../core/types";

function makeProviders(): AgentAuthProvider[] {
  return [
    {
      provider: "anthropic",
      name: "Anthropic (Claude Pro/Max)",
      configured: false,
      supportsApiKey: true,
      supportsSubscription: true,
      modelCount: 10,
      availableModelCount: 0,
    },
    {
      provider: "openai",
      name: "OpenAI",
      configured: false,
      supportsApiKey: true,
      supportsSubscription: false,
      modelCount: 8,
      availableModelCount: 8,
    },
  ];
}

function renderWith(providers: AgentAuthProvider[]) {
  const client = new AgentClient({ baseUrl: "http://localhost" });
  vi.spyOn(client, "listAuthProviders").mockResolvedValue({ providers });
  vi.spyOn(client, "listCustomProviders").mockResolvedValue({ providers: [] });
  render(
    <AgentChatProvider client={client}>
      <AgentSettings />
    </AgentChatProvider>,
  );
}

describe("AgentSettings — credential controls", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("shows the subscription/API-key mode toggle for a subscription-capable provider", async () => {
    renderWith(makeProviders());
    // Default selection prefers anthropic (subscription-capable).
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Subscription" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "API key" })).toBeTruthy();
    });
    // Subscription login button is the active mode for anthropic.
    expect(screen.getByRole("button", { name: /Subscription Login/i })).toBeTruthy();
  });

  it("shows an API key input for an api-key-only provider with no toggle", async () => {
    renderWith([makeProviders()[1]!]); // openai only
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/OpenAI API key/i)).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Subscription" })).toBeNull();
  });

  it("falls back to an API key input when capability flags are absent", async () => {
    // Simulates an older agent-server that omits supportsApiKey/supportsSubscription.
    const legacy = {
      provider: "mystery",
      name: "Mystery Provider",
      configured: false,
      modelCount: 1,
      availableModelCount: 1,
    } as unknown as AgentAuthProvider;
    renderWith([legacy]);
    await waitFor(() => {
      // Must not collapse to just the dropdown: an API key input is still offered.
      expect(screen.getByPlaceholderText(/API key/i)).toBeTruthy();
    });
  });
});
