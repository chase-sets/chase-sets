import { afterEach, describe, expect, it, vi } from "vitest";
import { defineAuthHost } from "./auth-host";

const host = defineAuthHost({
  signInPath: "/sign-in",
  fallbackPath: "/account",
  defaultSuccessPath: "/account",
  accountSelectionPath: "/account/select",
  signedOutReturnTo: "/search",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth host sign-out", () => {
  it("clears and revokes guest checkout state alongside normal session sign-out", async () => {
    const fetchPaths: string[] = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (input) => {
      fetchPaths.push(new URL(String(input)).pathname);
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetch);

    const response = await host.signOutActor(
      new Request("https://marketplace.test/sign-out", {
        method: "POST",
        headers: {
          cookie: "chase_sets_guest_checkout=guest_token; chase_sets_session=session_token",
        },
      }),
    );
    const cookies = response.headers.getSetCookie();

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/search");
    expect(cookies.find((cookie) => cookie.startsWith("chase_sets_guest_checkout="))).toContain("Max-Age=0");
    expect(cookies.find((cookie) => cookie.startsWith("chase_sets_guest_checkout="))).toContain("Secure");
    expect(cookies.find((cookie) => cookie.startsWith("chase_sets_session="))).toContain("Max-Age=0");
    expect(fetchPaths).toEqual(["/api/auth/guest-checkout/exit", "/api/auth/sign-out"]);
  });
});
