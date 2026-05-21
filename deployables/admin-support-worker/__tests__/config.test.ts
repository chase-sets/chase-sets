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
});
