import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendAccountSelectionCookie,
  appendSessionCookie,
  clearAccountSelectionCookie,
  clearGuestCheckoutCookie,
  clearSessionCookie,
} from "./http";

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
