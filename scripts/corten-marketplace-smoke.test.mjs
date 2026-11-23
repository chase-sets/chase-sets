import { describe, expect, it } from "vitest";
import {
  clearedVariables,
  cortenMarketplaceSmokeInvocation,
  forcedSmokeEnvironment,
} from "./corten-marketplace-smoke.mjs";

const landing = "https://landing.example";
const admin = "https://admin.example";
const marketplace = "https://marketplace-corten.example";

describe("Corten marketplace smoke entry", () => {
  it("runs the platform smoke against the given marketplace origin, signed out", () => {
    const { args, env } = cortenMarketplaceSmokeInvocation(
      ["node", "corten-marketplace-smoke.mjs", "--", landing, admin, marketplace],
      {
        PLATFORM_ADMIN_EMAIL: "admin@example.test",
        PLATFORM_ADMIN_PASSWORD: "not-sent",
        SMOKE_REQUIRE_SOCIAL_LOGIN: "true",
        SMOKE_REQUIRE_LANDING: "true",
        SMOKE_REQUIRE_ADMIN: "true",
        SMOKE_REQUIRE_MARKETPLACE_ROOT: "true",
        SMOKE_WRITE_WAITLIST: "true",
        MARKETPLACE_WEB_URL: "https://marketplace.elsewhere.example",
        MARKETPLACE_ROOT_WEB_URL: "https://root.example",
      },
    );
    expect(args.slice(1)).toEqual([landing, admin, marketplace]);
    expect(args[0].replaceAll("\\", "/")).toMatch(/\/scripts\/platform-smoke\.mjs$/);
    expect(env).toMatchObject(forcedSmokeEnvironment);
    // Social login follows the caller, as the Smoke check decides it.
    expect(env.SMOKE_REQUIRE_SOCIAL_LOGIN).toBe("true");
    for (const name of clearedVariables) expect(env).not.toHaveProperty(name);
  });

  it("refuses anything but a landing, an admin and a marketplace origin", () => {
    expect(() => cortenMarketplaceSmokeInvocation(["node", "x", landing, admin], {})).toThrow(/Usage/);
    expect(() =>
      cortenMarketplaceSmokeInvocation(["node", "x", landing, admin, marketplace, "https://legacy.example"], {}),
    ).toThrow(/Usage/);
  });
});
