import { afterEach, describe, expect, it } from "vitest";
import {
  getContextDatabaseEnvName,
  loadBootstrapConfig,
  loadConfig,
} from "../src/config";
import { getApiHostContextNames } from "@chase-sets/platform-runtime/api";
import { apiContextRegistry } from "../src/generated/api-context-registry";

const envNames = [
  "DATABASE_URL",
  ...platformApiContextNames().map((contextName) =>
    getContextDatabaseEnvName(contextName),
  ),
];

function platformApiContextNames() {
  return getApiHostContextNames(apiContextRegistry, "platform-api");
}

afterEach(() => {
  for (const envName of envNames) {
    delete process.env[envName];
  }

  delete process.env.PORT;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PUBLISHABLE_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_API_BASE_URL;
});

describe("platform api config", () => {
  it("loads the shared database url", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";

    const config = loadBootstrapConfig();

    expect(config.sharedDatabaseUrl).toBe("postgresql://localhost/chase_sets");
    expect(config.contextDatabaseUrls).toEqual({});
  });

  it("loads per-context database urls without a shared fallback", () => {
    delete process.env.DATABASE_URL;
    for (const contextName of platformApiContextNames()) {
      process.env[getContextDatabaseEnvName(contextName)] =
        `postgresql://localhost/${contextName.replaceAll("-", "_")}`;
    }

    const config = loadBootstrapConfig();

    expect(config.sharedDatabaseUrl).toBeNull();
    expect(config.contextDatabaseUrls.auth).toBe("postgresql://localhost/auth");
    expect(config.contextDatabaseUrls.checkout).toBe("postgresql://localhost/checkout");
    expect(config.contextDatabaseUrls["commercial-terms"]).toBe(
      "postgresql://localhost/commercial_terms",
    );
    expect(config.contextDatabaseUrls.settlement).toBe("postgresql://localhost/settlement");
  });

  it("supports mixed shared and per-context database urls", () => {
    process.env.DATABASE_URL = "postgresql://localhost/shared";
    process.env.DATABASE_URL_PAYMENTS = "postgresql://localhost/payments";

    const config = loadBootstrapConfig();

    expect(config.sharedDatabaseUrl).toBe("postgresql://localhost/shared");
    expect(config.contextDatabaseUrls.payments).toBe("postgresql://localhost/payments");
  });

  it("falls back to the fake payment processor when stripe env vars are missing", () => {
    process.env.DATABASE_URL = "postgresql://localhost/chase_sets";

    expect(loadConfig().paymentProcessor).toEqual({ kind: "fake" });
  });
});
