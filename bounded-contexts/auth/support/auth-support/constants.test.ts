import { describe, expect, it } from "vitest";
import { AUTH_ROLE_PERMISSIONS } from "./constants";

describe("auth role permissions", () => {
  it("grants platform admins the explicit admin-web surface permissions", () => {
    expect(AUTH_ROLE_PERMISSIONS["platform-admin"]).toEqual(
      expect.arrayContaining([
        "accounts.manage",
        "accounts.view",
        "catalog.manage",
        "catalog.view",
        "memberships.manage",
        "memberships.view",
        "platform-feedback.manage",
        "platform-feedback.view",
        "public-presence.manage",
        "public-presence.view",
        "security.manage",
      ]),
    );
  });
});
