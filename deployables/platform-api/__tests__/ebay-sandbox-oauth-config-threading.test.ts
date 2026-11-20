import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getContextDatabaseEnvName, getPlatformApiContextsForRuntimeProfile, loadConfig } from "../src/config";
beforeEach(() => {
  vi.stubEnv("PLATFORM_CONTROL_DATABASE_URL", "postgresql://localhost/chase_sets");
  vi.stubEnv("CHASE_SETS_RUNTIME_PROFILE", "public");
  for (const name of getPlatformApiContextsForRuntimeProfile("public"))
    vi.stubEnv(getContextDatabaseEnvName(name), "postgresql://localhost/chase_sets");
  vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "local");
  vi.stubEnv("EBAY_APPLICATION_CLIENT_ID", "synthetic-app");
  vi.stubEnv("EBAY_APPLICATION_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("EBAY_OAUTH_RUNAME", "synthetic-runame");
});
afterEach(() => vi.unstubAllEnvs());
describe("ebay-sandbox-oauth-config-threading", () => {
  it("loads all three host values without forwarding configuration to the browser", () => {
    expect(loadConfig().ebayOAuthConfiguration).toEqual({
      environment: "sandbox",
      clientId: "synthetic-app",
      clientSecret: "synthetic-secret",
      ruName: "synthetic-runame",
    });
  });
  it.each(["EBAY_APPLICATION_CLIENT_ID", "EBAY_APPLICATION_CLIENT_SECRET", "EBAY_OAUTH_RUNAME"])(
    "withholding %s disables connection",
    (name) => {
      vi.stubEnv(name, "");
      if (name === "EBAY_OAUTH_RUNAME") expect(loadConfig().ebayOAuthConfiguration).toBeNull();
      else expect(() => loadConfig()).toThrow("ebay_application_key_authority_configuration_invalid");
    },
  );
  it("withholds connection when the application keyset is entirely absent", () => {
    vi.stubEnv("EBAY_APPLICATION_CLIENT_ID", "");
    vi.stubEnv("EBAY_APPLICATION_CLIENT_SECRET", "");
    expect(loadConfig().ebayOAuthConfiguration).toBeNull();
  });
  it("never enables OAuth in production even with a complete keyset", () => {
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "production");
    vi.stubEnv("CHASE_SETS_RUNTIME_PROFILE", "landing");
    vi.stubEnv("PLATFORM_INTERNAL_AUTH_SECRET", "synthetic-internal-secret");
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_synthetic_connect");
    vi.stubEnv("CATALOG_ASSET_STORAGE_KIND", "s3");
    vi.stubEnv("CATALOG_ASSET_S3_BUCKET", "synthetic-assets");
    vi.stubEnv("CATALOG_ASSET_S3_REGION", "nyc3");
    vi.stubEnv("CATALOG_ASSET_PUBLIC_BASE_URL", "https://synthetic.example");
    expect(loadConfig().ebayOAuthConfiguration).toBeNull();
  });
});
