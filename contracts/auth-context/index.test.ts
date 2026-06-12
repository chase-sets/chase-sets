import { describe, expect, it } from "vitest";
import { createAuthBootstrapContext, parseCookieHeader, readAuthSessionToken } from "./index";

describe("auth request context helpers", () => {
  it("parses cookie headers with empty and encoded values", () => {
    expect([...parseCookieHeader(" chase_sets_session=tok%201 ; flag ; empty= ").entries()]).toEqual([
      ["chase_sets_session", "tok 1"],
      ["flag", ""],
      ["empty", ""],
    ]);
  });

  it("prefers the auth session cookie over bearer authorization", () => {
    const request = new Request("https://chase-sets.local", {
      headers: {
        cookie: "chase_sets_session=cookie-token",
        authorization: "Bearer bearer-token",
      },
    });

    expect(readAuthSessionToken(request)).toBe("cookie-token");
  });

  it("falls back to bearer authorization when the auth session cookie is absent", () => {
    const request = new Request("https://chase-sets.local", {
      headers: {
        authorization: "Bearer bearer-token ",
      },
    });

    expect(readAuthSessionToken(request)).toBe("bearer-token");
  });

  it("creates the identity bootstrap event context", () => {
    expect(
      createAuthBootstrapContext({
        identity: {
          bootstrapTenantId: "tnt_identity",
        },
      }),
    ).toEqual({
      tenantId: "tnt_identity",
      audit: {
        performedByUserId: "usr_identity_system",
        forAccountId: "acc_identity_system",
      },
      trace: {},
    });
  });
});
