import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendAnonymousCartCookie,
  appendAnonymousSellListCookie,
  appendClearedAnonymousCartCookie,
  appendClearedAnonymousSellListCookie,
  appendGuestCheckoutCookie,
} from "./guest-checkout";

function setCookieHeaders(write: (headers: Headers, request?: Request) => void) {
  return [new Request("https://marketplace.example.test/cart"), new Request("http://localhost/cart"), undefined].map(
    (request) => {
      const headers = new Headers();
      write(headers, request);
      return headers.getSetCookie();
    },
  );
}

describe("checkout cookie headers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the exact anonymous cart Set-Cookie headers", () => {
    expect(setCookieHeaders((headers, request) => appendAnonymousCartCookie(headers, "anon_a b;c", request))).toEqual([
      ["chase_sets_anonymous_cart=anon_a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure"],
      ["chase_sets_anonymous_cart=anon_a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"],
      ["chase_sets_anonymous_cart=anon_a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"],
    ]);
    expect(setCookieHeaders((headers, request) => appendClearedAnonymousCartCookie(headers, request))).toEqual([
      ["chase_sets_anonymous_cart=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure"],
      ["chase_sets_anonymous_cart=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"],
      ["chase_sets_anonymous_cart=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"],
    ]);
  });

  it("writes the exact anonymous sell list Set-Cookie headers", () => {
    expect(
      setCookieHeaders((headers, request) => appendAnonymousSellListCookie(headers, "anon_a b;c", request)),
    ).toEqual([
      ["chase_sets_anonymous_sell_list=anon_a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure"],
      ["chase_sets_anonymous_sell_list=anon_a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"],
      ["chase_sets_anonymous_sell_list=anon_a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"],
    ]);
    expect(setCookieHeaders((headers, request) => appendClearedAnonymousSellListCookie(headers, request))).toEqual([
      ["chase_sets_anonymous_sell_list=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure"],
      ["chase_sets_anonymous_sell_list=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"],
      ["chase_sets_anonymous_sell_list=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"],
    ]);
  });

  it("writes the exact guest checkout Set-Cookie header from the token expiry or the one-day default", () => {
    expect(
      setCookieHeaders((headers, request) =>
        appendGuestCheckoutCookie(headers, "gst a;b", request, "2026-10-20T12:30:00.500Z"),
      ),
    ).toEqual([
      ["chase_sets_guest_checkout=gst%20a%3Bb; Path=/; HttpOnly; SameSite=Lax; Max-Age=1801; Secure"],
      ["chase_sets_guest_checkout=gst%20a%3Bb; Path=/; HttpOnly; SameSite=Lax; Max-Age=1801"],
      ["chase_sets_guest_checkout=gst%20a%3Bb; Path=/; HttpOnly; SameSite=Lax; Max-Age=1801"],
    ]);
    expect(setCookieHeaders((headers, request) => appendGuestCheckoutCookie(headers, "gst a;b", request))).toEqual([
      ["chase_sets_guest_checkout=gst%20a%3Bb; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure"],
      ["chase_sets_guest_checkout=gst%20a%3Bb; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400"],
      ["chase_sets_guest_checkout=gst%20a%3Bb; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400"],
    ]);
  });
});
