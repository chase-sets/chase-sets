import { afterEach, describe, expect, it, vi } from "vitest";
import { getApiHostContextNames } from "@chase-sets/platform-runtime/api";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import { getContextDatabaseEnvName, loadConfig } from "../src/config";

const adminSupportContextNames = [
  "auth",
  "catalog",
  "experience",
  "identity",
  "public-presence",
] as const;

describe("admin-support API configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("selects only the landing/admin-support bounded contexts", () => {
    expect(
      [...getApiHostContextNames(apiContextRegistry, "admin-support-api")].sort(),
    ).toEqual([...adminSupportContextNames].sort());
  });

  it("loads production config without Stripe, EasyPost, payment, or marketplace requirements", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PLATFORM_CONTROL_DATABASE_URL", "postgres://control");
    vi.stubEnv("PLATFORM_INTERNAL_AUTH_SECRET", "production-internal-secret");
    vi.stubEnv("PLATFORM_ADMIN_EMAIL", "ops@chasesets.com");
    vi.stubEnv("PLATFORM_ADMIN_PASSWORD", "rotate-me-before-go-live");
    for (const contextName of adminSupportContextNames) {
      vi.stubEnv(getContextDatabaseEnvName(contextName), `postgres://${contextName}`);
    }

    const config = loadConfig();

    expect(config.adminRegistrationEnabled).toBe(false);
    expect(config.platformAdmin).toMatchObject({
      email: "ops@chasesets.com",
      accountName: "Chase Sets Platform",
    });
    expect(config.contextDatabaseUrls).toEqual(
      expect.objectContaining({
        auth: "postgres://auth",
        catalog: "postgres://catalog",
        experience: "postgres://experience",
        identity: "postgres://identity",
        "public-presence": "postgres://public-presence",
      }),
    );
  });

  it("requires platform admin email and password to be configured together", () => {
    vi.stubEnv("DATABASE_URL", "postgres://shared");
    vi.stubEnv("PLATFORM_INTERNAL_AUTH_SECRET", "production-internal-secret");
    vi.stubEnv("PLATFORM_ADMIN_EMAIL", "ops@chasesets.com");

    expect(() => loadConfig()).toThrow(
      "PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD must be configured together.",
    );
  });
});
