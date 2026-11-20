import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { resolveCartCount } from "./marketplace-root";

const signedInActor: ResolvedActor = {
  userId: "usr_cart",
  accountId: "acc_cart",
  tenantId: "acc_cart",
  sessionId: "ses_cart",
  membershipId: "mbr_cart",
  roleKey: "manager",
  permissions: ["accounts.view"],
};

const actors: ReadonlyArray<readonly [string, ResolvedActor | null, boolean]> = [
  ["signed-in without anonymous permission", signedInActor, true],
  ["guest role without anonymous permission", { ...signedInActor, roleKey: "guest-buyer" }, false],
  ["non-guest role with anonymous permission", { ...signedInActor, permissions: ["guest-checkout.manage"] }, false],
  [
    "guest role with anonymous permission",
    { ...signedInActor, roleKey: "guest-buyer", permissions: ["guest-checkout.manage"] },
    false,
  ],
  ["anonymous request", null, false],
];

describe("marketplace root cart count resolver preserves guest, permission, anonymous and failure branches", () => {
  afterEach(() => vi.unstubAllGlobals());

  describe.each(actors)("%s", (_name, actor, accountCart) => {
    it.each([true, false])("selects only the permitted endpoint with cookie=%s", async (withCookie) => {
      const requests: Request[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          requests.push(request);
          const path = new URL(request.url).pathname;
          if (path === "/api/marketplace/account/cart") return Response.json({ items: [], count: 11 });
          if (path === "/api/marketplace/guest/cart") return Response.json({ items: [], count: 23 });
          throw new Error(`Unexpected request: ${path}`);
        }),
      );
      const request = new Request("http://localhost/search", {
        headers: { cookie: withCookie ? "chase_sets_anonymous_cart=anon_cart_root" : "" },
      });

      expect(await resolveCartCount(request, actor)).toBe(accountCart ? 11 : withCookie ? 23 : 0);
      expect(requests.map((read) => new URL(read.url).pathname)).toEqual(
        accountCart ? ["/api/marketplace/account/cart"] : withCookie ? ["/api/marketplace/guest/cart"] : [],
      );
      if (!accountCart && withCookie) {
        expect(requests[0]?.headers.get("x-checkout-anonymous-cart-id")).toBe("anon_cart_root");
      }
    });

    it("returns zero when the selected read fails", async () => {
      const paths: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          paths.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
          return Response.json({ error: "unavailable" }, { status: 503 });
        }),
      );

      expect(
        await resolveCartCount(
          new Request("http://localhost/search", {
            headers: { cookie: "chase_sets_anonymous_cart=anon_cart_root" },
          }),
          actor,
        ),
      ).toBe(0);
      expect(paths).toEqual([accountCart ? "/api/marketplace/account/cart" : "/api/marketplace/guest/cart"]);
    });
  });

  it("fails soft when the anonymous cookie cannot be decoded", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      await resolveCartCount(
        new Request("http://localhost/search", {
          headers: { cookie: "chase_sets_anonymous_cart=%" },
        }),
        null,
      ),
    ).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
