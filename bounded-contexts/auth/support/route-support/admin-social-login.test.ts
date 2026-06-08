import { describe, expect, it } from "vitest";
import { createAdminGoogleWorkspaceSocialLoginHref, getSafeAdminReturnTo } from "./admin-social-login";

describe("admin social login route support", () => {
  it("keeps safe in-app return paths for admin SSO", () => {
    expect(getSafeAdminReturnTo(new URLSearchParams("returnTo=/support/platform-feedback"), "/access/accounts")).toBe(
      "/support/platform-feedback",
    );
    expect(
      getSafeAdminReturnTo(new URLSearchParams("returnTo=/growth/waitlist%3Fstatus%3Dnew"), "/access/accounts"),
    ).toBe("/growth/waitlist?status=new");
  });

  it("falls back when admin return paths are missing or external", () => {
    expect(getSafeAdminReturnTo(new URLSearchParams(), "/access/accounts")).toBe("/access/accounts");
    expect(getSafeAdminReturnTo(new URLSearchParams("returnTo=//evil.example/path"), "/access/accounts")).toBe(
      "/access/accounts",
    );
    expect(getSafeAdminReturnTo(new URLSearchParams("returnTo=https://evil.example/path"), "/access/accounts")).toBe(
      "/access/accounts",
    );
  });

  it("builds Google Workspace SSO links with the requested route", () => {
    expect(createAdminGoogleWorkspaceSocialLoginHref("access-admin", "/support/platform-feedback")).toBe(
      "/api/auth/social/google/start?journey=access-admin&returnTo=%2Fsupport%2Fplatform-feedback",
    );
    expect(createAdminGoogleWorkspaceSocialLoginHref("catalog-admin", "/catalog/integrations")).toBe(
      "/api/auth/social/google/start?journey=catalog-admin&returnTo=%2Fcatalog%2Fintegrations",
    );
  });
});
