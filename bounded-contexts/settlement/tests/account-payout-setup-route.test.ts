import { describe, expect, it } from "vitest";
import { CONNECT_EMBEDDED_COMPONENT_CSP, headers } from "../routes/marketplace/account-payout-setup";

describe("account payout setup route headers", () => {
  it("scopes Stripe Connect embedded component CSP to the payout setup route", () => {
    const routeHeaders = headers();

    expect(routeHeaders["Content-Security-Policy"]).toBe(CONNECT_EMBEDDED_COMPONENT_CSP);
    expect(routeHeaders["Cross-Origin-Opener-Policy"]).toBe("unsafe-none");
  });

  it("allows only the Stripe origins required by Connect embedded components", () => {
    expect(CONNECT_EMBEDDED_COMPONENT_CSP).toContain(
      "script-src 'self' 'unsafe-inline' https://connect-js.stripe.com https://js.stripe.com",
    );
    expect(CONNECT_EMBEDDED_COMPONENT_CSP).toContain("frame-src https://connect-js.stripe.com https://js.stripe.com");
    expect(CONNECT_EMBEDDED_COMPONENT_CSP).toContain("img-src 'self' data: https://*.stripe.com");
    expect(CONNECT_EMBEDDED_COMPONENT_CSP).toContain("style-src 'self' 'unsafe-inline'");
    expect(CONNECT_EMBEDDED_COMPONENT_CSP).toContain("style-src-elem 'self' 'unsafe-inline'");
    expect(CONNECT_EMBEDDED_COMPONENT_CSP).toContain("style-src-attr 'unsafe-inline'");
    expect(CONNECT_EMBEDDED_COMPONENT_CSP).not.toContain(" https:;");
    expect(CONNECT_EMBEDDED_COMPONENT_CSP).not.toContain(" * ");
  });
});
