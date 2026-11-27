import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyDevTargetEnvOverrides,
  browserE2eCortenPublicTarget,
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

function expectPublicCliBinding(source) {
  expect(source).toContain("createPublicWebDevProcessDefinition,");
  expect(source).toContain("createPublicWebDevProcessDefinition(sandbox, sandboxEnv),");
  expect(source).toContain('[browserE2eCortenPublicTarget]: ["platform-api", "platform-worker", "public-web"]');
  expect(source).toContain(
    'all: processes.filter(({ name }) => !["marketplace", "public-web"].includes(name)).map(({ name }) => name)',
  );
  expect(source).not.toContain('"public-web": ["platform-api", "platform-worker", "public-web"]');
  expect(source).toContain("applyDevTargetEnvOverrides(targetName, resolveProcessesForTarget(targetName))");
}

describe("public-web dev sandbox origins", () => {
  it("binds the shared definition into the CLI process table and only the Corten public target", () => {
    const source = readFileSync(new URL("./dev-system.mjs", import.meta.url), "utf8");
    expectPublicCliBinding(source);
    expect(() =>
      expectPublicCliBinding(source.replace("createPublicWebDevProcessDefinition(sandbox, sandboxEnv),", "")),
    ).toThrow();
  });

  it("names no workspace in the base definition, which is unchanged outside the browser targets", () => {
    const definition = createPublicWebDevProcessDefinition(sandbox, {
      CHASE_SETS_SANDBOX_ID: "synthetic-public-web-test",
      CHASE_SETS_INTERNAL_API_ORIGIN: "https://synthetic-inherited-api.invalid",
      CHASE_SETS_MARKETPLACE_ORIGIN: "https://synthetic-inherited-marketplace.invalid",
    });
    const [resolved] = applyDevTargetEnvOverrides("admin-web", [definition]);
    expect(resolved).toBe(definition);
    expect(resolved).not.toHaveProperty("workspace");
    expectSandboxOrigins(buildPlatformChildEnvironment({}, resolved.env));
    expect(resolved).toMatchObject({
      name: "public-web",
      port: sandbox.ports.publicWeb,
      env: {
        CHASE_SETS_SANDBOX_ID: "synthetic-public-web-test",
        PLATFORM_API_URL: sandbox.urls.platformApi,
        VITE_PLATFORM_API_URL: sandbox.urls.platformApi,
        PORT: String(sandbox.ports.publicWeb),
      },
    });
  });

  it("passes the sandbox origins to the Corten public app", () => {
    const definition = createPublicWebDevProcessDefinition(sandbox, {
      CHASE_SETS_SANDBOX_ID: "synthetic-public-web-test",
    });
    const [resolved] = applyDevTargetEnvOverrides(browserE2eCortenPublicTarget, [definition], { ci: true });
    expect(resolved).not.toHaveProperty("workspace");
    expect(resolved.command).toMatch(/public/);
    expectSandboxOrigins(buildPlatformChildEnvironment({}, resolved.env));
    expect(resolved.publicPort).toBe(sandbox.ports.publicWeb);
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
