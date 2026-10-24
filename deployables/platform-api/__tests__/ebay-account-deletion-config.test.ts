import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getContextDatabaseEnvName, getPlatformApiContextsForRuntimeProfile, loadConfig } from "../src/config";

const endpoint = "https://Example.com:443/api/channels-webhooks/ebay/account-deletion";
const token = "synthetic_verification_token_0123456789";
beforeEach(() => {
  vi.stubEnv("PLATFORM_CONTROL_DATABASE_URL", "postgresql://localhost/chase_sets");
  vi.stubEnv("CHASE_SETS_RUNTIME_PROFILE", "public");
  for (const context of getPlatformApiContextsForRuntimeProfile("public")) {
    vi.stubEnv(getContextDatabaseEnvName(context), "postgresql://localhost/chase_sets");
  }
  vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "local");
  vi.stubEnv("EBAY_ACCOUNT_DELETION_ENDPOINT", "");
  vi.stubEnv("EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN", "");
  vi.stubEnv("EBAY_APPLICATION_CLIENT_ID", "");
  vi.stubEnv("EBAY_APPLICATION_CLIENT_SECRET", "");
});
afterEach(() => vi.unstubAllEnvs());
describe("ebay-account-deletion-config", () => {
  it.each(["production", "staging", "preview", "local"])(
    "ebay-account-deletion-key-config binds %s only to deployment authority",
    (environment) => {
      vi.stubEnv("DEPLOYMENT_ENVIRONMENT", environment);
      vi.stubEnv("CHASE_SETS_RUNTIME_PROFILE", "landing");
      vi.stubEnv("PLATFORM_INTERNAL_AUTH_SECRET", "synthetic-internal-secret");
      vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_synthetic_connect");
      vi.stubEnv("CATALOG_ASSET_STORAGE_KIND", "s3");
      vi.stubEnv("CATALOG_ASSET_S3_BUCKET", "synthetic-assets");
      vi.stubEnv("CATALOG_ASSET_S3_REGION", "nyc3");
      vi.stubEnv("CATALOG_ASSET_PUBLIC_BASE_URL", "https://synthetic.example");
      vi.stubEnv("EBAY_ACCOUNT_DELETION_ENDPOINT", endpoint);
      vi.stubEnv("EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN", token);
      vi.stubEnv("EBAY_APPLICATION_CLIENT_ID", "synthetic-client-id");
      vi.stubEnv("EBAY_APPLICATION_CLIENT_SECRET", "synthetic-client-secret");
      expect(loadConfig().ebayAccountDeletionConfiguration?.applicationAuthority).toEqual({
        clientId: "synthetic-client-id",
        clientSecret: "synthetic-client-secret",
        environment: environment === "production" ? "production" : "sandbox",
      });
    },
  );
  it.each([
    ["id", ""],
    ["", "secret"],
    ["bad:id", "secret"],
    ["id", "bad\nsecret"],
    ["id", " "],
  ])(
    "ebay-account-deletion-key-config rejects malformed/partial application authority without values: %#",
    (id, secret) => {
      vi.stubEnv("EBAY_APPLICATION_CLIENT_ID", id);
      vi.stubEnv("EBAY_APPLICATION_CLIENT_SECRET", secret);
      expect(() => loadConfig()).toThrow(/^ebay_application_key_authority_configuration_invalid$/);
    },
  );
  it("disables absent and empty pairs", () => {
    expect(loadConfig().ebayAccountDeletionConfiguration).toBeNull();
    vi.stubEnv("EBAY_ACCOUNT_DELETION_ENDPOINT", undefined);
    vi.stubEnv("EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN", undefined);
    expect(loadConfig().ebayAccountDeletionConfiguration).toBeNull();
  });
  it.each([32, 80])("preserves the exact endpoint and %i-character token", (length) => {
    vi.stubEnv("EBAY_ACCOUNT_DELETION_ENDPOINT", endpoint);
    vi.stubEnv("EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN", "A_-0".repeat(20).slice(0, length));
    expect(loadConfig().ebayAccountDeletionConfiguration).toEqual({
      endpoint,
      verificationToken: "A_-0".repeat(20).slice(0, length),
    });
  });
  it.each([
    [endpoint, ""],
    ["", token],
    [endpoint, "a".repeat(31)],
    [endpoint, "a".repeat(81)],
    [endpoint, token + "!"],
    [endpoint, " " + token],
    [endpoint, token + "\n"],
    [endpoint.replace("https:", "http:"), token],
    [endpoint.replace("Example.com:443", "127.0.0.1"), token],
    [endpoint.replace("Example.com:443", "2130706433"), token],
    [endpoint.replace("Example.com:443", "[::1]"), token],
    [endpoint.replace("Example.com:443", "localhost"), token],
    [endpoint.replace("Example.com:443", "sub.localhost."), token],
    [endpoint.replace("Example.com:443", "user:password@example.com"), token],
    [endpoint.replace("Example.com:443", "@example.com"), token],
    [endpoint.replace("/api/", "/extra/../api/"), token],
    [endpoint.replace("Example.com:443", "bad_host.example.com"), token],
    [endpoint + "?", token],
    [endpoint + "?token=private", token],
    [endpoint + "#", token],
    [endpoint + "/wrong", token],
    [" " + endpoint, token],
    ["not-a-url", token],
  ])("rejects invalid configuration case %# without values", (url, verificationToken) => {
    vi.stubEnv("EBAY_ACCOUNT_DELETION_ENDPOINT", url);
    vi.stubEnv("EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN", verificationToken);
    expect(() => loadConfig()).toThrow(/^ebay_account_deletion_configuration_invalid$/);
  });
});
