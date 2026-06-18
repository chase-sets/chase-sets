import { afterEach, describe, expect, it, vi } from "vitest";
import { getApiHostContextNames } from "@chase-sets/platform-runtime/api";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import { getContextDatabaseEnvName, loadConfig } from "../src/config";

const adminSupportContextNames = [
  "auth",
  "catalog",
  "fulfillment",
  "identity",
  "ordering",
  "platform-operations",
  "public-presence",
] as const;

describe("admin-support API configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("selects admin-support contexts and source-only projection inputs", () => {
    expect([...getApiHostContextNames(apiContextRegistry, "admin-support-api")].sort()).toEqual(
      [...adminSupportContextNames].sort(),
    );
  });

  it("ignores retired standalone context database URL env vars", () => {
    vi.stubEnv("DATABASE_URL", "postgres://shared");
    vi.stubEnv("PLATFORM_INTERNAL_AUTH_SECRET", "dev-internal-secret");
    vi.stubEnv("DATABASE_URL_EXPERIENCE", "postgres://experience");
    vi.stubEnv("DATABASE_URL_INSIGHTS", "postgres://insights");
    vi.stubEnv("DATABASE_URL_SUPPORT", "postgres://support");

    const config = loadConfig();

    expect(
      Object.keys(config.contextDatabaseUrls).every((contextName) => {
        return adminSupportContextNames.includes(contextName as (typeof adminSupportContextNames)[number]);
      }),
    ).toBe(true);
    expect(Object.values(config.contextDatabaseUrls)).not.toEqual(
      expect.arrayContaining(["postgres://experience", "postgres://insights", "postgres://support"]),
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
    expect(config.socialLogin).toEqual({});
    expect(config.adminGoogleWorkspaceSso).toBeNull();
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
        fulfillment: "postgres://fulfillment",
        ordering: "postgres://ordering",
        "platform-operations": "postgres://platform-operations",
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
    expect(config.readConsistency).toEqual({
      timeoutMs: 2_500,
      pollIntervalMs: 75,
      exactDependencyMode: "enabled",
      routeTuning: [],
      wakeBeforeWaitEnabled: false,
    });
  });

  it("loads read consistency controls from environment variables", () => {
    vi.stubEnv("DATABASE_URL", "postgres://shared");
    vi.stubEnv("PLATFORM_INTERNAL_AUTH_SECRET", "dev-internal-secret");
    vi.stubEnv("READ_CONSISTENCY_TIMEOUT_MS", "1500");
    vi.stubEnv("READ_CONSISTENCY_POLL_INTERVAL_MS", "25");
    vi.stubEnv("READ_CONSISTENCY_EXACT_DEPENDENCY_MODE", "target-context");
    vi.stubEnv("READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED", "true");
    vi.stubEnv(
      "READ_CONSISTENCY_ROUTE_TUNING_JSON",
      JSON.stringify([
        {
          mountPath: "/api/catalog",
          routePath: "/source-observations/provider-profiles",
          targetContextName: "catalog",
          timeoutMs: 900,
          pollIntervalMs: 15,
          exactDependencyMode: "enabled",
        },
      ]),
    );

    expect(loadConfig().readConsistency).toEqual({
      timeoutMs: 1_500,
      pollIntervalMs: 25,
      exactDependencyMode: "target-context",
      routeTuning: [
        {
          mountPath: "/api/catalog",
          routePath: "/source-observations/provider-profiles",
          targetContextName: "catalog",
          timeoutMs: 900,
          pollIntervalMs: 15,
          exactDependencyMode: "enabled",
        },
      ],
      wakeBeforeWaitEnabled: true,
    });
  });

  it("rejects invalid read consistency controls", () => {
    vi.stubEnv("DATABASE_URL", "postgres://shared");
    vi.stubEnv("PLATFORM_INTERNAL_AUTH_SECRET", "dev-internal-secret");
    vi.stubEnv("READ_CONSISTENCY_EXACT_DEPENDENCY_MODE", "off");

    expect(() => loadConfig()).toThrow("READ_CONSISTENCY_EXACT_DEPENDENCY_MODE must be enabled or target-context.");

    vi.stubEnv("READ_CONSISTENCY_EXACT_DEPENDENCY_MODE", "enabled");
    vi.stubEnv("READ_CONSISTENCY_TIMEOUT_MS", "0");

    expect(() => loadConfig()).toThrow("READ_CONSISTENCY_TIMEOUT_MS must be a positive number.");

    vi.stubEnv("READ_CONSISTENCY_TIMEOUT_MS", "2500");
    vi.stubEnv(
      "READ_CONSISTENCY_ROUTE_TUNING_JSON",
      JSON.stringify([{ mountPath: "/api/catalog", routePath: "source-observations/provider-profiles" }]),
    );

    expect(() => loadConfig()).toThrow(
      "READ_CONSISTENCY_ROUTE_TUNING_JSON[0].routePath must be an absolute path string.",
    );
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

  it("allows representative commerce state only outside production", () => {
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "staging");
    vi.stubEnv("DATABASE_URL", "postgres://shared");
    vi.stubEnv("PLATFORM_INTERNAL_AUTH_SECRET", "staging-internal-secret");
    vi.stubEnv("CATALOG_ASSET_STORAGE_KIND", "s3");
    vi.stubEnv("CATALOG_ASSET_S3_BUCKET", "catalog-assets-staging");
    vi.stubEnv("CATALOG_ASSET_S3_REGION", "nyc3");
    vi.stubEnv("CATALOG_ASSET_PUBLIC_BASE_URL", "https://assets.staging.chasesets.com");
    vi.stubEnv("PLATFORM_DATA_PROFILES", "critical-bootstrap,representative-commerce-state");

    expect(loadConfig().dataProfiles).toEqual(["critical-bootstrap", "representative-commerce-state"]);

    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "production");

    expect(() => loadConfig()).toThrow(
      "representative-commerce-state is not allowed when DEPLOYMENT_ENVIRONMENT=production.",
    );
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

  it("loads Google Workspace SSO configuration for production admin sign-in", () => {
    vi.stubEnv("DATABASE_URL", "postgres://shared");
    vi.stubEnv("PLATFORM_INTERNAL_AUTH_SECRET", "production-internal-secret");
    vi.stubEnv("GOOGLE_SOCIAL_LOGIN_CLIENT_ID", "google-client");
    vi.stubEnv("GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET", "google-secret");
    vi.stubEnv("ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS", "ChaseSets.com, internal.chasesets.com ");

    const config = loadConfig();

    expect(config.socialLogin).toEqual({
      google: {
        clientId: "google-client",
        clientSecret: "google-secret",
      },
    });
    expect(config.adminGoogleWorkspaceSso).toEqual({
      allowedHostedDomains: ["chasesets.com", "internal.chasesets.com"],
    });
  });

  it("requires Google credentials when admin Workspace SSO domains are configured", () => {
    vi.stubEnv("DATABASE_URL", "postgres://shared");
    vi.stubEnv("PLATFORM_INTERNAL_AUTH_SECRET", "production-internal-secret");
    vi.stubEnv("ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS", "chasesets.com");

    expect(() => loadConfig()).toThrow(
      "ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS requires GOOGLE_SOCIAL_LOGIN_CLIENT_ID and GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET.",
    );
  });

  it("requires Google social login credentials to be configured together", () => {
    vi.stubEnv("DATABASE_URL", "postgres://shared");
    vi.stubEnv("PLATFORM_INTERNAL_AUTH_SECRET", "production-internal-secret");
    vi.stubEnv("GOOGLE_SOCIAL_LOGIN_CLIENT_ID", "google-client");

    expect(() => loadConfig()).toThrow(
      "GOOGLE_SOCIAL_LOGIN_CLIENT_ID and GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET must be configured together.",
    );
  });
});
