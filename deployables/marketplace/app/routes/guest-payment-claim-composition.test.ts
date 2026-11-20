import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveMarketplaceRouteConfigRecords } from "../host";
const { read, loader, action, create } = vi.hoisted(() => ({
  read: vi.fn(),
  loader: vi.fn(),
  action: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@chase-sets/auth/server", () => ({ createGuestPaymentClaimRoute: create }));
vi.mock("@chase-sets/payments/server", () => ({ readGuestPaymentClaimability: read }));

describe("guest payment claim host binding", () => {
  it("binds the real Payments reader once and preserves route exports", async () => {
    create.mockReturnValue({ loader, action });
    const bound = await import("../guest-payment-claim.server");
    expect(create).toHaveBeenCalledExactlyOnceWith(read);
    expect(bound.loader).toBe(loader);
    expect(bound.action).toBe(action);
  });
  it("substitutes only the Auth route file without changing its identity or owner", () => {
    const records = resolveMarketplaceRouteConfigRecords().filter((r) => r.routeId === "guest-payment-claim");
    expect(records).toEqual([
      expect.objectContaining({
        contextName: "auth",
        sourceContext: "auth",
        routePath: "checkout/claim/:paymentId",
        file: "routes/guest-payment-claim.tsx",
        delivery: "server-only",
        authorization: { kind: "public" },
      }),
    ]);
    const wrapper = readFileSync(resolve("app/routes/guest-payment-claim.tsx"), "utf8");
    expect(wrapper.trim().split("\n")).toHaveLength(2);
    expect(wrapper).toContain('export { loader, action } from "../guest-payment-claim.server"');
    expect(wrapper).toContain(
      'export { default, meta, ErrorBoundary } from "@chase-sets/auth/routes/marketplace/guest-payment-claim"',
    );
  });
  it("keeps issued email URLs compatible with old web, new web and rollback", async () => {
    const source = readFileSync(
      resolve("../../bounded-contexts/auth/support/api-support/guest-checkout-routes.ts"),
      "utf8",
    );
    expect(source).toContain("/checkout/payments/");
    expect(source).not.toContain("/checkout/claim/");
    const payments = await import("@chase-sets/payments/routes/marketplace/account-payment");
    const request = new Request(
      "https://marketplace.test/checkout/payments/pay_1?claimContinuation=issued&afterWrite=receipt&other=kept",
      { headers: { cookie: "guest=caller" } },
    );
    await expect(
      payments.loader({ request, params: { paymentId: "pay_1" }, context: undefined }),
    ).rejects.toMatchObject({ status: 302 });
    const response = await payments
      .loader({ request, params: { paymentId: "pay_1" }, context: undefined })
      .catch((e: unknown) => {
        if (e instanceof Response) return e;
        throw e;
      });
    if (!(response instanceof Response)) throw new Error("Expected the stable email URL to redirect.");
    expect(response.headers.get("location")).toBe(
      "/checkout/claim/pay_1?claimContinuation=issued&afterWrite=receipt&other=kept",
    );
  });
});
