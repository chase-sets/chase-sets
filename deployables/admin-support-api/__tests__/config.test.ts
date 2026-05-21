import { afterEach, describe, expect, it, vi } from "vitest";
import { getApiHostContextNames } from "@chase-sets/platform-runtime/api";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import { getContextDatabaseEnvName, loadConfig } from "../src/config";

const adminSupportContextNames = ["auth", "catalog", "experience", "identity", "public-presence"] as const;

describe("admin-support API configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("selects only the landing/admin-support bounded contexts", () => {
    expect([...getApiHostContextNames(apiContextRegistry, "admin-support-api")].sort()).toEqual(
      [...adminSupportContextNames].sort(),
    );
  });

  it("loads production config without Stripe, EasyPost, payment, or marketplace requirements", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PLATFORM_CONTROL_DATABASE_URL", "postgres://control");
    vi.stubEnv("PLATFORM_INTERNAL_AUTH_SECRET", "production-internal-secret");
    vi.stubEnv("PLATFORM_ADMIN_EMAIL", "ops@chasesets.com");
    vi.stubEnv("PLATFORM_ADMIN_PASSWORD", "rotate-me-before-go-live");
    vi.stubEnv("CATALOG_ASSET_STORAGE_KIND", "s3");
    vi.stubEnv("CATALOG_ASSET_S3_BUCKET", "catalog-assets");
    vi.stubEnv("CATALOG_ASSET_S3_REGION", "nyc3");
    vi.stubEnv("CATALOG_ASSET_PUBLIC_BASE_URL", "https://assets.chasesets.com");
    for (const contextName of adminSupportContextNames) {
      vi.stubEnv(getContextDatabaseEnvName(contextName), `postgres://${contextName}`);
    }

    const config = loadConfig();

    expect(config.adminRegistrationEnabled).toBe(false);
    expect(config.platformAdmin).toMatchObject({
      email: "ops@chasesets.com",
      accountName: "Chase Sets Platform",
    });
    expect(config.deploymentEnvironment).toBe("production");
    expect(config.dataProfiles).toEqual(["critical-bootstrap", "catalog-integration-bootstrap"]);
    expect(config.catalogAssetStorage).toMatchObject({
      kind: "s3",
      bucket: "catalog-assets",
      region: "nyc3",
      publicBaseUrl: "https://assets.chasesets.com",
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

  it("uses filesystem Catalog asset storage locally", () => {
    vi.stubEnv("DATABASE_URL", "postgres://shared");
    vi.stubEnv("PLATFORM_INTERNAL_AUTH_SECRET", "dev-internal-secret");
    vi.stubEnv("PORT", "7552");

    const config = loadConfig();

    expect(config.deploymentEnvironment).toBe("test");
    expect(config.dataProfiles).toEqual(["critical-bootstrap", "catalog-integration-bootstrap", "scenario-seed"]);
    expect(config.catalogAssetStorage).toEqual({
      kind: "filesystem",
      rootDir: "artifacts/catalog-assets",
      publicBaseUrl: "http://localhost:7552/catalog-assets",
    });
  });

  it("treats staging as production-like data with no scenario seed", () => {
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "staging");
    vi.stubEnv("DATABASE_URL", "postgres://shared");
    vi.stubEnv("PLATFORM_INTERNAL_AUTH_SECRET", "staging-internal-secret");
    vi.stubEnv("CATALOG_ASSET_STORAGE_KIND", "s3");
    vi.stubEnv("CATALOG_ASSET_S3_BUCKET", "catalog-assets-staging");
    vi.stubEnv("CATALOG_ASSET_S3_REGION", "nyc3");
    vi.stubEnv("CATALOG_ASSET_PUBLIC_BASE_URL", "https://assets.staging.chasesets.com");

    const config = loadConfig();

    expect(config.deploymentEnvironment).toBe("staging");
    expect(config.dataProfiles).toEqual(["critical-bootstrap", "catalog-integration-bootstrap"]);
  });

  it("allows explicit admin-support bootstrap profile overrides", () => {
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "production");
    vi.stubEnv("DATABASE_URL", "postgres://shared");
    vi.stubEnv("PLATFORM_INTERNAL_AUTH_SECRET", "production-internal-secret");
    vi.stubEnv("CATALOG_ASSET_STORAGE_KIND", "s3");
    vi.stubEnv("CATALOG_ASSET_S3_BUCKET", "catalog-assets");
    vi.stubEnv("CATALOG_ASSET_S3_REGION", "nyc3");
    vi.stubEnv("CATALOG_ASSET_PUBLIC_BASE_URL", "https://assets.chasesets.com");
    vi.stubEnv("PLATFORM_DATA_PROFILES", "critical-bootstrap");

    expect(loadConfig().dataProfiles).toEqual(["critical-bootstrap"]);
  });

  it("rejects unsupported admin-support bootstrap profile overrides", () => {
    vi.stubEnv("DATABASE_URL", "postgres://shared");
    vi.stubEnv("PLATFORM_INTERNAL_AUTH_SECRET", "dev-internal-secret");
    vi.stubEnv("PLATFORM_DATA_PROFILES", "scenario-seed,unknown");

    expect(() => loadConfig()).toThrow("PLATFORM_DATA_PROFILES contains unsupported data profile 'unknown'.");
  });

  it("requires platform admin email and password to be configured together", () => {
    vi.stubEnv("DATABASE_URL", "postgres://shared");
    vi.stubEnv("PLATFORM_INTERNAL_AUTH_SECRET", "production-internal-secret");
    vi.stubEnv("PLATFORM_ADMIN_EMAIL", "ops@chasesets.com");

    expect(() => loadConfig()).toThrow("PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD must be configured together.");
  });
});
