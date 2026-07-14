import { describe, expect, it } from "vitest";
import { isDeveloperPortalReady, requireDeveloperPortalReady } from "./developer-portal-readiness";

describe("developer portal readiness", () => {
  it("defaults off and accepts only an explicit true value", () => {
    expect(isDeveloperPortalReady({})).toBe(false);
    expect(isDeveloperPortalReady({ CHASE_SETS_M86_DEVELOPER_PORTAL_READY: "false" })).toBe(false);
    expect(isDeveloperPortalReady({ CHASE_SETS_M86_DEVELOPER_PORTAL_READY: " TRUE " })).toBe(true);
  });

  it("returns a not-found response while certification readiness is off", () => {
    expect(() => requireDeveloperPortalReady({})).toThrowError(Response);
    try {
      requireDeveloperPortalReady({});
    } catch (error) {
      expect((error as Response).status).toBe(404);
    }
  });
});
