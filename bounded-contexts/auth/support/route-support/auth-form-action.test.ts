import { describe, expect, it } from "vitest";
import { authFormActionFromLocation, authFormActionFromRequest } from "./auth-form-action";

describe("auth form action", () => {
  it.each([
    "?socialLoginError=provider_failed&returnTo=%2Faccount%3Fq%3Dtwo%20words",
    "?returnTo=%2faccount%3fq%3dtwo%20words&socialLoginError=provider_failed",
    "?socialLoginError=provider_failed&returnTo=%2faccount%3fq%3dtwo%20words&socialLoginError=cancelled",
  ])("F1 regression: strips social failures and preserves returnTo bytes from %s", (search) => {
    const returnTo = search.split(/[?&]/).find((parameter) => parameter.startsWith("returnTo="))!;
    const expected = `/sign-in?${returnTo}`;
    expect(authFormActionFromLocation({ pathname: "/sign-in", search })).toBe(expected);
    expect(authFormActionFromRequest(new Request(`https://marketplace.test/sign-in${search}`))).toBe(expected);
  });

  it("F1 regression: returns the original action unchanged when no social failure is present", () => {
    expect(authFormActionFromLocation({ pathname: "/sign-in", search: "?returnTo=%2faccount%3fq%3dtwo%20words" })).toBe(
      "/sign-in?returnTo=%2faccount%3fq%3dtwo%20words",
    );
    expect(authFormActionFromLocation({ pathname: "/sign-in", search: "?socialLoginError=provider_failed" })).toBe(
      "/sign-in",
    );
  });

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
