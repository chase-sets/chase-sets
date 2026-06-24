import { describe, expect, it } from "vitest";
import { getPlatformSmokeCliArgs } from "./platform-smoke-args.mjs";
import { resolveSyntheticWaitlistEmail } from "./platform-smoke-email.mjs";
import { resolvePlatformSmokeUrls } from "./platform-smoke-url-config.mjs";

describe("platform smoke CLI args", () => {
  it("uses positional URLs directly", () => {
    expect(getPlatformSmokeCliArgs(["node", "platform-smoke.mjs", "https://landing.test"])).toEqual([
      "https://landing.test",
    ]);
  });

  it("ignores a leading pnpm argument separator", () => {
    expect(
      getPlatformSmokeCliArgs(["node", "platform-smoke.mjs", "--", "https://landing.test", "https://admin.test"]),
    ).toEqual(["https://landing.test", "https://admin.test"]);
  });
});

describe("platform smoke synthetic waitlist email", () => {
  it("keeps an explicit waitlist email exact", () => {
    expect(
      resolveSyntheticWaitlistEmail({
        env: {
          SMOKE_WAITLIST_EMAIL: "ops+fixed@chasesets.com",
          SMOKE_EMAIL: "ops+smoke@chasesets.com",
          SMOKE_EMAIL_SUFFIX: "production-123",
        },
      }),
    ).toBe("ops+fixed@chasesets.com");
  });

  it("adds a safe run suffix to the base smoke email", () => {
    expect(
      resolveSyntheticWaitlistEmail({
        env: {
          SMOKE_EMAIL: "ops+smoke@chasesets.com",
          SMOKE_EMAIL_SUFFIX: "Production Main #42",
        },
      }),
    ).toBe("ops+smoke-production-main-42@chasesets.com");
  });

  it("uses GitHub run metadata when no explicit suffix is present", () => {
    expect(
      resolveSyntheticWaitlistEmail({
        env: {
          SMOKE_EMAIL: "ops@chasesets.com",
          GITHUB_RUN_ID: "28072494452",
          GITHUB_RUN_ATTEMPT: "2",
        },
      }),
    ).toBe("ops+gh-28072494452-2@chasesets.com");
  });

  it("keeps the stable default when no run metadata is present", () => {
    expect(resolveSyntheticWaitlistEmail()).toBe("ops+smoke@chasesets.com");
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

  it("uses the explicit marketplace root URL for staging root smoke", () => {
    expect(
      resolvePlatformSmokeUrls({
        cliArgs: ["https://landing.test", "https://admin.test", "https://marketplace.test", "https://legacy.test"],
        env: {
          MARKETPLACE_ROOT_WEB_URL: "https://staging.test",
        },
        sandboxEnv: {},
      }),
    ).toEqual({
      landingUrl: "https://landing.test",
      adminUrl: "https://admin.test",
      marketplaceUrl: "https://marketplace.test",
      marketplaceRootUrl: "https://staging.test",
      redirectUrl: "https://legacy.test",
    });
  });
});
