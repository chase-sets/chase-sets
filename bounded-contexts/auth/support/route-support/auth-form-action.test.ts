import { describe, expect, it } from "vitest";
import { authFormActionFromLocation, authFormActionFromRequest } from "./auth-form-action";

describe("auth form action", () => {
  it("preserves the current path and query from a request", () => {
    const request = new Request(
      "https://marketplace.test/sign-in?returnTo=%2Faccount%2Fsell-list%3FregistrationReturn%3Dseller-checkout",
    );

    expect(authFormActionFromRequest(request)).toBe(
      "/sign-in?returnTo=%2Faccount%2Fsell-list%3FregistrationReturn%3Dseller-checkout",
    );
  });

  it("builds route-relative actions from router locations", () => {
    expect(
      authFormActionFromLocation({
        pathname: "/access/sign-in",
        search: "?returnTo=%2Fsupport%2Fplatform-feedback",
      }),
    ).toBe("/access/sign-in?returnTo=%2Fsupport%2Fplatform-feedback");
  });
});
