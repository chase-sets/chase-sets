// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { CHASE_SETS_COMMIT_RECEIPT_HEADER, encodeCommitReceipt } from "@chase-sets/http/responses";
import { jsonResponse, requestUrl } from "../tests/test-support/http";

const { mockUseLoaderData, mockUseActionData, mockRequireActorFromAuthApi } = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockUseActionData: vi.fn(),
  mockRequireActorFromAuthApi: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useLoaderData: mockUseLoaderData, useActionData: mockUseActionData };
});

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );
  return { ...actual, requireActorFromAuthApi: mockRequireActorFromAuthApi };
});

import AccountPurchaseRoute, { action, loader } from "./account-purchase";

const address = {
  name: "Collector",
  company: null,
  line1: "455 Market St",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
  phone: null,
  email: null,
};

function pendingPurchase(orderId: string, overrides: Record<string, unknown> = {}) {
  return {
    order_id: orderId,
    display_reference: orderId.toUpperCase(),
    source_type: "cart-checkout",
    source_reference_id: null,
    buyer_account_id: "acc_collector",
    buyer_display_name: "Collector",
    seller_account_id: "acc_seller",
    seller_display_name: "Seller",
    shipping_option: "standard",
    item_subtotal_amount: "20.00",
    shipping_base_amount: "4.99",
    shipping_discount_amount: "0.00",
    shipping_allowance_amount: "4.99",
    shipping_overage_amount: "0.00",
    shipping_charge_amount: "4.99",
    sales_tax_amount: "0.00",
    marketplace_sales_fee_amount: "1.00",
    seller_net_amount: "19.00",
    seller_item_net_amount: "19.00",
    seller_payout_amount: "23.99",
    shipping_allowance_percentage_bps: 500,
    taxable_amount: "24.99",
    tax_jurisdiction_country: "US",
    tax_jurisdiction_state: "IL",
    tax_rate_bps: 0,
    tax_provider_name: "local-tax-stub",
    tax_provider_quote_reference: null,
    tax_quoted_at: "2026-10-25T00:00:00.000Z",
    total_amount: "24.99",
    terms_schedule_id: "cts_default",
    terms_agreement_id: null,
    terms_resolved_at: "2026-10-25T00:00:00.000Z",
    shipping_destination_snapshot: address,
    shipping_origin_snapshot: address,
    status: "pending-payment",
    payment_deadline_at: "2026-10-25T01:00:00.000Z",
    created_at: "2026-10-25T00:00:00.000Z",
    updated_at: "2026-10-25T00:00:00.000Z",
    cancelled_at: null,
    cancellation_reason: null,
    ready_for_fulfillment_at: null,
    self_service_cancellation_available: true,
    cancellation_unavailable_reason: null,
    line_count: 1,
    total_quantity: 1,
    lines: [],
    inventory_holds: [],
    reviewOutcome: { status: "unavailable", opportunity: null },
    ...overrides,
  };
}

// The sandbox collector: an owner whose session Auth resolved without
// orders.manage because the primary email is not verified yet.
const unverifiedCollector = {
  sessionId: "ses_collector",
  tenantId: "tnt_identity",
  userId: "usr_collector",
  accountId: "acc_collector",
  membershipId: "mbr_collector",
  roleKey: "owner",
  permissions: ["orders.view"],
};
// The same member after consuming the magic link: Auth re-resolves the actor
// per request, and a verified email no longer withholds orders.manage.
const verifiedCollector = { ...unverifiedCollector, permissions: ["orders.view", "orders.manage"] };
const viewerMember = { ...unverifiedCollector, roleKey: "viewer", permissions: ["orders.view"] };

let actor: typeof unverifiedCollector = unverifiedCollector;
const cancelledOrderIds: string[] = [];

function purchaseApi(purchases: Readonly<Record<string, ReturnType<typeof pendingPurchase>>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      const cancel = /\/api\/marketplace\/account\/purchases\/([^/?]+)\/cancel/.exec(url);
      if (cancel) {
        cancelledOrderIds.push(cancel[1]!);
        return jsonResponse({ id: cancel[1], version: 3, status: "cancelled" }, 200, {
          "Chase-Sets-Consistency": "committed",
          [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([
            { sourceContextName: "ordering", maxGlobalPosition: "42", eventIds: [`evt_${cancel[1]}_cancelled`] },
          ]),
        });
      }
      const read = /\/api\/marketplace\/account\/purchases\/([^/?]+)/.exec(url);
      const purchase = read ? purchases[read[1]!] : undefined;
      return purchase ? jsonResponse(purchase) : jsonResponse({ error: { code: "not_found" } }, 404);
    }),
  );
}

async function renderPurchase(orderId: string, search = "") {
  const data = await loader({
    request: new Request(`http://localhost/account/purchases/${orderId}${search}`),
    params: { purchaseId: orderId },
    context: undefined,
  } as never);
  mockUseLoaderData.mockReturnValue(data);
  render(
    <ChaseRoot>
      <AccountPurchaseRoute />
    </ChaseRoot>,
  );
  return data;
}

function cancelPurchase(orderId: string) {
  return action({
    request: new Request(`http://localhost/account/purchases/${orderId}`, {
      method: "POST",
      body: new URLSearchParams({ intent: "cancel-purchase" }),
    }),
    params: { purchaseId: orderId },
    context: undefined,
  } as never);
}

const cancelButtonName = t("ordering.features.orders.ui.orderDetailPage.cancel.projection", {
  projectionLabel: "purchase",
});
const verifyLinkName = t("ordering.features.orders.ui.orderDetailPage.verify.email");

describe("purchase cancellation authority on the account purchase route", () => {
  beforeEach(() => {
    cancelledOrderIds.length = 0;
    mockUseActionData.mockReturnValue(undefined);
    // Auth's own gate: the route asks for a permission and the resolved actor either holds it or is refused.
    mockRequireActorFromAuthApi.mockImplementation(async ({ permission }: { permission?: string }) => {
      if (permission && !actor.permissions.includes(permission)) {
        throw new Response("Forbidden", { status: 403 });
      }
      return actor;
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("guides an unverified collector to verify instead of offering a Cancel that answers Forbidden", async () => {
    actor = unverifiedCollector;
    purchaseApi({ ord_1: pendingPurchase("ord_1") });

    const data = await renderPurchase("ord_1");

    expect(data.cancelAuthority).toBe("verify-email");
    expect(screen.queryByRole("button", { name: cancelButtonName })).toBeNull();
    const verify = screen.getByRole("link", { name: verifyLinkName });
    const href = new URL(verify.getAttribute("href")!, "http://localhost");
    expect(href.pathname).toBe("/sign-in");
    expect(href.searchParams.get("signInMethod")).toBe("magic-link");
    expect(href.searchParams.get("returnTo")).toBe("/account/purchases/ord_1?verifyEmail=cancel-purchase");
  });

  it("refuses the unverified collector's direct cancel at Auth's gate before Ordering is called", async () => {
    actor = unverifiedCollector;
    purchaseApi({ ord_1: pendingPurchase("ord_1") });

    const refusal = await cancelPurchase("ord_1").catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(Response);
    expect((refusal as Response).status).toBe(403);
    expect(cancelledOrderIds).toEqual([]);
  });

  it("lets the verified collector, back on the returned purchase, cancel each pending order", async () => {
    actor = verifiedCollector;
    purchaseApi({ ord_1: pendingPurchase("ord_1"), ord_2: pendingPurchase("ord_2") });

    const data = await renderPurchase("ord_1", "?verifyEmail=cancel-purchase");

    expect(data.cancelAuthority).toBe("allowed");
    expect(screen.getByRole("button", { name: cancelButtonName })).toBeTruthy();
    expect(screen.queryByRole("link", { name: verifyLinkName })).toBeNull();

    for (const orderId of ["ord_1", "ord_2"]) {
      const response = (await cancelPurchase(orderId)) as Response;
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toContain(`/account/purchases/${orderId}`);
    }
    expect(cancelledOrderIds).toEqual(["ord_1", "ord_2"]);
  });

  it("offers neither Cancel nor a false verify prompt to a member whose role cannot cancel", async () => {
    actor = viewerMember;
    purchaseApi({ ord_1: pendingPurchase("ord_1") });

    const data = await renderPurchase("ord_1");

    expect(data.cancelAuthority).toBe("unavailable");
    expect(screen.queryByRole("button", { name: cancelButtonName })).toBeNull();
    expect(screen.queryByRole("link", { name: verifyLinkName })).toBeNull();
  });

  it("keeps a purchase with an unresolved payment protected and visibly unresolved, even for an authorized buyer", async () => {
    actor = verifiedCollector;
    purchaseApi({
      ord_1: pendingPurchase("ord_1", {
        self_service_cancellation_available: false,
        cancellation_unavailable_reason: "payment-unresolved",
      }),
    });

    await renderPurchase("ord_1");

    expect(screen.queryByRole("button", { name: cancelButtonName })).toBeNull();
    expect(screen.queryByRole("link", { name: verifyLinkName })).toBeNull();
    expect(screen.getByText(t("ordering.features.orders.ui.orderDetailPage.payment.unresolved.title"))).toBeTruthy();
  });
});
