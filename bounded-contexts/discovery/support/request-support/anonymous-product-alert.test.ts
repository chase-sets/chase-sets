import { describe, expect, it } from "vitest";
import { appendAnonymousProductAlertCookie } from "./anonymous-product-alert";

function setCookieHeaders(write: (headers: Headers, request?: Request) => void) {
  return [
    new Request("https://marketplace.example.test/alerts"),
    new Request("http://localhost/alerts"),
    undefined,
  ].map((request) => {
    const headers = new Headers();
    write(headers, request);
    return headers.getSetCookie();
  });
}

describe("anonymous product alert cookie header", () => {
  it("writes the exact Set-Cookie header over https, http and without a request", () => {
    expect(
      setCookieHeaders((headers, request) => appendAnonymousProductAlertCookie(headers, "anon_a b;c", request)),
    ).toEqual([
      ["chase_sets_anonymous_product_alerts=anon_a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure"],
      ["chase_sets_anonymous_product_alerts=anon_a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"],
      ["chase_sets_anonymous_product_alerts=anon_a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"],
    ]);
  });
});
