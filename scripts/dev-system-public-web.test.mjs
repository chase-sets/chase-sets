import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyDevTargetEnvOverrides,
  buildPlatformChildEnvironment,
  createPublicWebDevProcessDefinition,
} from "./dev-system-config.mjs";

const sandbox = {
  urls: { platformApi: "http://localhost:6412", marketplaceWeb: "http://localhost:6403" },
  ports: { publicWeb: 6406 },
};

function expectSandboxOrigins(environment) {
  expect(environment.CHASE_SETS_INTERNAL_API_ORIGIN).toBe(sandbox.urls.platformApi);
  expect(environment.CHASE_SETS_MARKETPLACE_ORIGIN).toBe(sandbox.urls.marketplaceWeb);
}

describe("public-web dev sandbox origins", () => {
  it("uses the importable definition in the CLI's public-web and all targets", () => {
    const source = readFileSync(new URL("./dev-system.mjs", import.meta.url), "utf8");
    expect(source).toContain("createPublicWebDevProcessDefinition,");
    expect(source).toContain("createPublicWebDevProcessDefinition(sandbox, sandboxEnv),");
    expect(source).toContain('"public-web": ["platform-api", "platform-worker", "public-web"]');
    expect(source).toContain("all: processes.map(({ name }) => name)");
    expect(source).toContain("applyDevTargetEnvOverrides(targetName, resolveProcessesForTarget(targetName))");
  });

  it.each(["public-web", "all"])("passes sandbox origins to the %s child process", (target) => {
    const definition = createPublicWebDevProcessDefinition(sandbox, {
      CHASE_SETS_SANDBOX_ID: "synthetic-public-web-test",
      CHASE_SETS_INTERNAL_API_ORIGIN: "https://synthetic-inherited-api.invalid",
      CHASE_SETS_MARKETPLACE_ORIGIN: "https://synthetic-inherited-marketplace.invalid",
    });
    const [resolved] = applyDevTargetEnvOverrides(target, [definition]);
    const environment = buildPlatformChildEnvironment({}, resolved.env);

    expectSandboxOrigins(environment);
    expect(resolved).toMatchObject({
      name: "public-web",
      workspace: "@chase-sets/app-public-web",
      port: sandbox.ports.publicWeb,
      env: {
        CHASE_SETS_SANDBOX_ID: "synthetic-public-web-test",
        PLATFORM_API_URL: sandbox.urls.platformApi,
        VITE_PLATFORM_API_URL: sandbox.urls.platformApi,
        PORT: String(sandbox.ports.publicWeb),
      },
    });
  });

  it.each(["CHASE_SETS_INTERNAL_API_ORIGIN", "CHASE_SETS_MARKETPLACE_ORIGIN"])(
    "rejects missing and independently wrong %s destinations",
    (name) => {
      const { env } = createPublicWebDevProcessDefinition(sandbox, {});
      const missing = { ...env };
      delete missing[name];
      expect(() => expectSandboxOrigins(missing)).toThrow();
      expect(() => expectSandboxOrigins({ ...env, [name]: "https://synthetic-wrong-origin.invalid" })).toThrow();
    },
  );

  it("rejects the original definition with neither origin configured", () => {
    expect(() =>
      expectSandboxOrigins({
        PLATFORM_API_URL: sandbox.urls.platformApi,
        VITE_PLATFORM_API_URL: sandbox.urls.platformApi,
        PORT: String(sandbox.ports.publicWeb),
      }),
    ).toThrow();
  });
});
