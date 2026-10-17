import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("constructs the Catalog-owned runtime with the pool, config and dedicated keyring", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  expect(main).toContain("createTcgplayerAutomationRuntime({");
  expect(main).toContain("pool: pools.catalog");
  expect(main).toContain("config: config.tcgplayerAutomation");
  expect(main).toContain("keyring: config.catalogOperatorSessionKeyring");
  expect(main).toContain("tcgplayerAutomationRuntime?.catalogClient");
  expect(main).not.toContain("createPostgresTcgplayerAutomationHttpConfigStore");
  expect(main).not.toContain("createTcgplayerAutomationHttpClients");
});
