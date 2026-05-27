import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { AgentCredentialsService } from "../src/credentialsService.js";

function makeAgentDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(resolve(tmpdir(), "agent-server-creds-"));
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("AgentCredentialsService", () => {
  let agent: { dir: string; cleanup: () => void };

  before(() => {
    agent = makeAgentDir();
  });

  after(() => {
    agent.cleanup();
  });

  test("constructor requires authStorage and modelRegistry references", () => {
    const authStorage = AuthStorage.create(resolve(agent.dir, "auth.json"));
    const modelRegistry = ModelRegistry.create(authStorage, resolve(agent.dir, "models.json"));
    const service = new AgentCredentialsService({
      authStorage,
      modelRegistry,
      modelsJsonPath: resolve(agent.dir, "models.json"),
      logger: { log: () => {}, error: () => {} },
    });
    assert.equal(typeof service.listAuthProviders, "function");
  });

  test("listModels returns Pi-shaped rows with availability flag", () => {
    const authStorage = AuthStorage.create(resolve(agent.dir, "auth.json"));
    const modelRegistry = ModelRegistry.create(authStorage, resolve(agent.dir, "models.json"));
    authStorage.set("anthropic", { type: "api_key", key: "sk-ant-test" });
    modelRegistry.refresh();
    const service = new AgentCredentialsService({
      authStorage,
      modelRegistry,
      modelsJsonPath: resolve(agent.dir, "models.json"),
      logger: { log: () => {}, error: () => {} },
    });

    const models = service.listModels();
    const anthropic = models.find((m) => m.provider === "anthropic");
    assert.ok(anthropic, "expected at least one anthropic model");
    assert.equal(anthropic!.available, true);
    assert.equal(typeof anthropic!.contextWindow, "number");
  });

  test("setProviderApiKey persists, listAuthProviders shows configured, removeProviderCredential clears", () => {
    const authStorage = AuthStorage.create(resolve(agent.dir, "auth.json"));
    const modelRegistry = ModelRegistry.create(authStorage, resolve(agent.dir, "models.json"));
    const service = new AgentCredentialsService({
      authStorage,
      modelRegistry,
      modelsJsonPath: resolve(agent.dir, "models.json"),
      logger: { log: () => {}, error: () => {} },
    });

    service.setProviderApiKey("anthropic", "sk-ant-test");
    let providers = service.listAuthProviders();
    let anthropic = providers.find((p) => p.provider === "anthropic");
    assert.equal(anthropic?.configured, true);
    assert.equal(anthropic?.source, "stored");

    service.removeProviderCredential("anthropic");
    providers = service.listAuthProviders();
    anthropic = providers.find((p) => p.provider === "anthropic");
    // remaining anthropic row reflects no stored credential
    assert.notEqual(anthropic?.source, "stored");
  });

  test("setProviderApiKey rejects malformed provider id", () => {
    const authStorage = AuthStorage.create(resolve(agent.dir, "auth.json"));
    const modelRegistry = ModelRegistry.create(authStorage, resolve(agent.dir, "models.json"));
    const service = new AgentCredentialsService({
      authStorage,
      modelRegistry,
      modelsJsonPath: resolve(agent.dir, "models.json"),
      logger: { log: () => {}, error: () => {} },
    });
    assert.throws(() => service.setProviderApiKey("bad provider!", "k"), /invalid provider id/);
  });
});
