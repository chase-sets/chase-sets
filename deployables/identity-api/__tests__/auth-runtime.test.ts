import { describe, expect, it } from "vitest";
import { readAuthSessionToken } from "../../../bounded-contexts/auth/runtime";

describe("auth request token resolution", () => {
  it("prefers the auth session cookie when it is present", () => {
    const request = new Request("http://identity.test/api/auth/session", {
      headers: {
        cookie: "chase_sets_session=session_cookie; theme=light",
        authorization: "Bearer session_bearer",
      },
    });

    expect(readAuthSessionToken(request)).toBe("session_cookie");
  });

  it("falls back to the bearer token when no auth cookie is present", () => {
    const request = new Request("http://identity.test/api/auth/session", {
      headers: {
        authorization: "Bearer session_bearer",
      },
    });

    expect(readAuthSessionToken(request)).toBe("session_bearer");
  });
});
