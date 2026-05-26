import { afterEach, describe, expect, it, vi } from "vitest";
import { getWorkerHostContextNames } from "@chase-sets/platform-runtime/worker";
import { workerContextRegistry } from "../src/generated/worker-context-registry";
import { getContextDatabaseEnvName, loadConfig } from "../src/config";

const adminSupportContextNames = ["auth", "catalog", "experience", "identity", "public-presence"] as const;

describe("admin-support worker configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("selects only the landing/admin-support bounded contexts", () => {
    expect([...getWorkerHostContextNames(workerContextRegistry, "admin-support-worker")].sort()).toEqual(
      [...adminSupportContextNames].sort(),
    );
  });

  it("loads per-context database configuration", () => {
    vi.stubEnv("PLATFORM_CONTROL_DATABASE_URL", "postgres://control");
    for (const contextName of adminSupportContextNames) {
      vi.stubEnv(getContextDatabaseEnvName(contextName), `postgres://${contextName}`);
    }

    const config = loadConfig();

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

  it("keeps default runner concurrency within shared-resource capacity", () => {
    vi.stubEnv("DATABASE_URL", "postgres://shared");

    const config = loadConfig();

    expect(config).toMatchObject({
      maxConcurrentRunners: 4,
      projectionMaxConcurrentRunners: 2,
      jobMaxConcurrentRunners: 1,
      catalogAssetStorage: {
        kind: "filesystem",
        rootDir: "artifacts/catalog-assets",
        publicBaseUrl: `http://localhost:${config.port}/catalog-assets`,
      },
    });
  });

  it("loads S3 Catalog asset storage for admin-support worker jobs", () => {
    vi.stubEnv("DATABASE_URL", "postgres://shared");
    vi.stubEnv("CATALOG_ASSET_STORAGE_KIND", "s3");
    vi.stubEnv("CATALOG_ASSET_S3_BUCKET", "catalog-assets");
    vi.stubEnv("CATALOG_ASSET_S3_REGION", "nyc3");
    vi.stubEnv("CATALOG_ASSET_S3_ENDPOINT", "https://nyc3.digitaloceanspaces.com");
    vi.stubEnv("CATALOG_ASSET_PUBLIC_BASE_URL", "https://assets.chasesets.test");
    vi.stubEnv("CATALOG_ASSET_S3_ACCESS_KEY_ID", "spaces-key");
    vi.stubEnv("CATALOG_ASSET_S3_SECRET_ACCESS_KEY", "spaces-secret");

    expect(loadConfig().catalogAssetStorage).toEqual({
      kind: "s3",
      bucket: "catalog-assets",
      region: "nyc3",
      endpoint: "https://nyc3.digitaloceanspaces.com",
      publicBaseUrl: "https://assets.chasesets.test",
      accessKeyId: "spaces-key",
      secretAccessKey: "spaces-secret",
      forcePathStyle: false,
    });
  });
});
