import { describe, expect, it } from "vitest";
import { getPlatformSmokeCliArgs } from "./platform-smoke-args.mjs";
import { resolvePlatformSmokeUrls } from "./platform-smoke-url-config.mjs";

describe("platform smoke CLI args", () => {
  it("uses positional URLs directly", () => {
    expect(getPlatformSmokeCliArgs(["node", "platform-smoke.mjs", "https://landing.test"]))
      .toEqual(["https://landing.test"]);
  });

  it("ignores a leading pnpm argument separator", () => {
    expect(
      getPlatformSmokeCliArgs([
        "node",
        "platform-smoke.mjs",
        "--",
        "https://landing.test",
        "https://admin.test",
      ]),
    ).toEqual(["https://landing.test", "https://admin.test"]);
  });
});

describe("platform smoke URL resolution", () => {
  it("does not use sandbox-only optional URLs when explicit target URLs are passed", () => {
    expect(
      resolvePlatformSmokeUrls({
        cliArgs: ["https://landing.test", "https://admin.test"],
        env: {},
        sandboxEnv: {
          MARKETPLACE_WEB_URL: "http://localhost:10053",
          LEGACY_PUBLIC_URL: "http://localhost:10054",
        },
      }),
    ).toEqual({
      landingUrl: "https://landing.test",
      adminUrl: "https://admin.test",
      marketplaceUrl: "",
      marketplaceRootUrl: "",
      redirectUrl: "",
    });
  });

  it("uses sandbox URLs for local smoke when no explicit target is passed", () => {
    expect(
      resolvePlatformSmokeUrls({
        cliArgs: [],
        env: {},
        sandboxEnv: {
          LANDING_WEB_URL: "http://localhost:10054",
          ADMIN_WEB_URL: "http://localhost:10052",
          MARKETPLACE_WEB_URL: "http://localhost:10053",
        },
      }),
    ).toEqual({
      landingUrl: "http://localhost:10054",
      adminUrl: "http://localhost:10052",
      marketplaceUrl: "http://localhost:10053",
      marketplaceRootUrl: "",
      redirectUrl: "",
    });
  });

  it("uses an explicit marketplace root URL only when configured", () => {
    expect(
      resolvePlatformSmokeUrls({
        cliArgs: ["https://landing.test", "https://admin.test", "https://marketplace.test"],
        env: {
          MARKETPLACE_ROOT_WEB_URL: "https://staging.test/",
        },
        sandboxEnv: {},
      }),
    ).toEqual({
      landingUrl: "https://landing.test",
      adminUrl: "https://admin.test",
      marketplaceUrl: "https://marketplace.test",
      marketplaceRootUrl: "https://staging.test",
      redirectUrl: "",
    });
  });
});
