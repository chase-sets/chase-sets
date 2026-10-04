import { expect, it } from "vitest";
import { createTestWindowDriver } from "./test-window-driver.mjs";
import { syntheticManifest, SYNTHETIC_FIXTURES } from "./test-window-fixtures.mjs";

it("AC-02 entrypoint: driver rejects noncanonical API versions and non-TEST secret keys before journal access", () => {
  const pool = new Proxy(
    {},
    {
      get() {
        throw new Error("SYNTHETIC_6733_UNEXPECTED_JOURNAL_ACCESS");
      },
    },
  );
  const dependencies = {
    pool,
    secretKey: "sk_test_SYNTHETIC_6733",
    fixtures: SYNTHETIC_FIXTURES,
    browser: {},
  };
  const staleManifest = syntheticManifest();
  staleManifest.configuration.apiVersion = "SYNTHETIC_6733_STALE_VERSION";
  expect(() => createTestWindowDriver(staleManifest, dependencies)).toThrow("authority-unavailable");
  for (const secretKey of [
    "sk_live_SYNTHETIC_6733",
    "rk_test_SYNTHETIC_6733",
    "pk_test_SYNTHETIC_6733",
    "sk_test_",
    "sk_test_SYNTHETIC_6733!",
  ]) {
    expect(() => createTestWindowDriver(syntheticManifest(), { ...dependencies, secretKey })).toThrow(
      "authority-unavailable",
    );
  }
});
