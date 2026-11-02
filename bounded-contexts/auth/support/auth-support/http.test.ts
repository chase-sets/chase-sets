import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import { defineAuthHost } from "../route-support/auth-host";
import { SAME_SITE_TEST_ORIGIN, UNSAFE_AUTH_PATHS, VALID_AUTH_PATHS } from "./same-site-path.test-support";
import {
  appendAccountSelectionCookie,
  appendSessionCookie,
  clearAccountSelectionCookie,
  clearGuestCheckoutCookie,
  clearSessionCookie,
  getSafeReturnTo,
} from "./http";

describe("Auth same-site path caller matrix", () => {
  const host = defineAuthHost({
    signInPath: "/sign-in",
    fallbackPath: "/account",
    defaultSuccessPath: "/account",
    accountSelectionPath: "/account/select",
    signedOutReturnTo: "/search",
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([...UNSAFE_AUTH_PATHS, ...VALID_AUTH_PATHS])("Auth same-site URL boundary: %j", async (path) => {
    const expected = VALID_AUTH_PATHS.includes(path) ? path : "/account";
    const url = new URL("/sign-in", SAME_SITE_TEST_ORIGIN);
    url.searchParams.set("returnTo", path);
    expect(getSafeReturnTo(new Request(url), "/account")).toBe(expected);

    const fetch = vi.fn(async () =>
      Response.json({
        type: "session-started",
        sessionToken: "synthetic-session-token",
        session: { expires_at: "2099-01-01T00:00:00.000Z" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    for (const action of [host.createSignInAction(), host.createAccountSelectionAction()]) {
      const request = new Request(url, {
        method: "POST",
        headers: { cookie: "chase_sets_account_selection=synthetic-selection-token" },
        body: new URLSearchParams({
          intent: "password",
          email: "buyer@example.test",
          password: "synthetic-password",
          accountId: "acc_test",
        }),
      });
      const result = await action({
        request,
        params: {},
        context: {},
        url,
        pattern: "/sign-in",
      } satisfies ActionFunctionArgs);
      expect(result).toBeInstanceOf(Response);
      const response = result as Response;
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(expected);
      expect(new URL(response.headers.get("Location")!, SAME_SITE_TEST_ORIGIN).origin).toBe(SAME_SITE_TEST_ORIGIN);
      expect(response.headers.getSetCookie().join(";")).toContain("chase_sets_session=synthetic-session-token");
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("decodes query transport once, not repeatedly", () => {
    expect(getSafeReturnTo(new Request(`${SAME_SITE_TEST_ORIGIN}/sign-in?returnTo=/%5Chost`), "/account")).toBe(
      "/account",
    );
    expect(getSafeReturnTo(new Request(`${SAME_SITE_TEST_ORIGIN}/sign-in?returnTo=/%255Chost`), "/account")).toBe(
      "/%5Chost",
    );
  });

  it("preserves untrimmed browser Return Paths without accepting leading spaces", () => {
    const url = new URL("/sign-in", SAME_SITE_TEST_ORIGIN);
    url.searchParams.set("returnTo", "/account ");
    expect(getSafeReturnTo(new Request(url), "/fallback")).toBe("/account ");
    url.searchParams.set("returnTo", " /account");
    expect(getSafeReturnTo(new Request(url), "/fallback")).toBe("/fallback");
  });
});

function setCookieHeaders(write: (headers: Headers, request?: Request) => void) {
  return [
    new Request("https://marketplace.example.test/sign-in"),
    new Request("http://localhost/sign-in"),
    undefined,
  ].map((request) => {
    const headers = new Headers();
    write(headers, request);
    return headers.getSetCookie();
  });
}

describe("auth cookie headers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the exact session Set-Cookie headers", () => {
    expect(
      setCookieHeaders((headers, request) =>
        appendSessionCookie(headers, "ses a;b", "2026-10-20T13:00:00.250Z", request),
      ),
    ).toEqual([
      ["chase_sets_session=ses%20a%3Bb; Path=/; HttpOnly; SameSite=Lax; Max-Age=3601; Secure"],
      ["chase_sets_session=ses%20a%3Bb; Path=/; HttpOnly; SameSite=Lax; Max-Age=3601"],
      ["chase_sets_session=ses%20a%3Bb; Path=/; HttpOnly; SameSite=Lax; Max-Age=3601"],
    ]);
    expect(setCookieHeaders((headers, request) => clearSessionCookie(headers, request))).toEqual([
      ["chase_sets_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure"],
      ["chase_sets_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"],
      ["chase_sets_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"],
    ]);
  });

  it("writes the exact account selection Set-Cookie headers", () => {
    expect(
      setCookieHeaders((headers, request) =>
        appendAccountSelectionCookie(headers, "sel a;b", "2026-10-20T11:59:00.000Z", request),
      ),
    ).toEqual([
      ["chase_sets_account_selection=sel%20a%3Bb; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure"],
      ["chase_sets_account_selection=sel%20a%3Bb; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"],
      ["chase_sets_account_selection=sel%20a%3Bb; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"],
    ]);
    expect(setCookieHeaders((headers, request) => clearAccountSelectionCookie(headers, request))).toEqual([
      ["chase_sets_account_selection=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure"],
      ["chase_sets_account_selection=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"],
      ["chase_sets_account_selection=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"],
    ]);
  });

  it("writes the exact guest checkout clearing Set-Cookie header", () => {
    expect(setCookieHeaders((headers, request) => clearGuestCheckoutCookie(headers, request))).toEqual([
      ["chase_sets_guest_checkout=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure"],
      ["chase_sets_guest_checkout=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"],
      ["chase_sets_guest_checkout=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"],
    ]);
  });
});
