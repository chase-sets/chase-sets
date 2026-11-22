import { describe, expect, it } from "vitest";
import { clearedOriginVariables, cortenAdminSmokeInvocation, forcedSmokeEnvironment } from "./corten-admin-smoke.mjs";

const landing = "https://landing.example";
const admin = "https://admin-corten.example";

describe("Corten admin smoke entry", () => {
  it("runs the platform smoke against the given admin origin only", () => {
    const { args, env } = cortenAdminSmokeInvocation(["node", "corten-admin-smoke.mjs", "--", landing, admin], {
      PLATFORM_ADMIN_EMAIL: "kept",
      SMOKE_REQUIRE_LANDING: "true",
      SMOKE_REQUIRE_MARKETPLACE: "true",
      SMOKE_WRITE_WAITLIST: "true",
      ADMIN_WEB_URL: "https://admin.elsewhere.example",
      MARKETPLACE_WEB_URL: "https://market.example",
    });
    expect(args.slice(1)).toEqual([landing, admin]);
    expect(args[0].replaceAll("\\", "/")).toMatch(/\/scripts\/platform-smoke\.mjs$/);
    expect(env).toMatchObject(forcedSmokeEnvironment);
    expect(env.PLATFORM_ADMIN_EMAIL).toBe("kept");
    for (const name of clearedOriginVariables) expect(env).not.toHaveProperty(name);
  });

  it("refuses anything but a landing and an admin origin", () => {
    expect(() => cortenAdminSmokeInvocation(["node", "x", admin], {})).toThrow(/Usage/);
    expect(() => cortenAdminSmokeInvocation(["node", "x", landing, admin, "https://market.example"], {})).toThrow(
      /Usage/,
    );
  });
});
