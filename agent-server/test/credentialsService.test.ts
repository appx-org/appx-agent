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
});
