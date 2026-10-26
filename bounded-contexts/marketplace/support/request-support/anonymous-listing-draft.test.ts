import { describe, expect, it } from "vitest";
import { appendAnonymousListingDraftCookie, appendAnonymousReportCookie } from "./anonymous-listing-draft";

function setCookieHeaders(write: (headers: Headers, request?: Request) => void) {
  return [new Request("https://marketplace.example.test/sell"), new Request("http://localhost/sell"), undefined].map(
    (request) => {
      const headers = new Headers();
      write(headers, request);
      return headers.getSetCookie();
    },
  );
}

describe("anonymous marketplace cookie headers", () => {
  it("writes the exact listing draft Set-Cookie header over https, http and without a request", () => {
    expect(
      setCookieHeaders((headers, request) => appendAnonymousListingDraftCookie(headers, "anon_a b;c", request)),
    ).toEqual([
      ["chase_sets_anonymous_listing_drafts=anon_a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure"],
      ["chase_sets_anonymous_listing_drafts=anon_a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"],
      ["chase_sets_anonymous_listing_drafts=anon_a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"],
    ]);
  });

  it("writes the exact report Set-Cookie header over https, http and without a request", () => {
    expect(setCookieHeaders((headers, request) => appendAnonymousReportCookie(headers, "anon_a b;c", request))).toEqual(
      [
        ["chase_sets_anonymous_reports=anon_a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure"],
        ["chase_sets_anonymous_reports=anon_a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"],
        ["chase_sets_anonymous_reports=anon_a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"],
      ],
    );
  });
});
