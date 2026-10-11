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
});
afterEach(() => vi.unstubAllEnvs());
describe("ebay-account-deletion-config", () => {
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
