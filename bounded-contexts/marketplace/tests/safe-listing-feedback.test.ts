import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "@chase-sets/localization";
import { createMarketplaceApiClient, MarketplaceApiError } from "../client";
import { listingPreparationResponse } from "../features/listings/tests/listing-attempt-test-support";
import { listingRecoveryResult } from "../features/listings/api/listing-recovery";
import { listingRecoveryReferenceSchema, type ListingRecoveryOutcome } from "../features/listings/ui/contracts";

const actor = {
  sessionId: "ses_1",
  tenantId: "tnt_test",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["listings.view", "listings.manage"],
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function recoveryResponse(
  input: string | URL | Request,
  init?: RequestInit,
  outcome: ListingRecoveryOutcome = "ambiguous",
) {
  const url = new URL(String(input), "http://localhost");
  if (url.pathname.endsWith("/listings/batch/prepare")) return listingPreparationResponse(init, actor.accountId);
  if (!url.pathname.includes("/listings/batch/") || init?.method === "POST") return null;
  const reference = listingRecoveryReferenceSchema.parse({
    batchId: url.pathname.split("/").at(-1),
    mutationKind: url.searchParams.get("family"),
    bulk: url.searchParams.get("bulk") === "true",
  });
  return json(listingRecoveryResult(reference, [{ targetId: reference.bulk ? "lst_1" : actor.accountId, outcome }]));
}
function actionArgs(intent: string) {
  return {
    request: new Request("http://localhost/account/listings", {
      method: "POST",
      body: new URLSearchParams({
        idempotencyKey: "feedback_form_attempt_0001",
        intent,
        listingIds: "lst_1",
        inventoryItemId: "inv_1",
        priceAmount: "10.00",
        priceCurrencyCode: "USD",
        quantityCap: "1",
      }),
    }),
    params: {},
    context: undefined,
  } as never;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("presents only allowlisted Listing feedback", () => {
  it("preserves the client status and code for safe Listing feedback", async () => {
    const client = createMarketplaceApiClient({
      baseUrl: "http://localhost/api/marketplace",
      fetch: vi.fn(async () =>
        json(
          {
            error: {
              code: "listing_command_rejected",
              message: t("marketplace.features.listings.api.route.error.commandRejected"),
            },
          },
          400,
        ),
      ),
    });
    await expect(client.pauseListing("lst_1", { idempotencyKey: "client_pause_attempt_0001" })).rejects.toMatchObject({
      status: 400,
      body: { error: { code: "listing_command_rejected" } },
      message: t("marketplace.features.listings.api.route.error.commandRejected"),
    });
    await expect(client.pauseListing("lst_1", { idempotencyKey: "client_pause_attempt_0002" })).rejects.toBeInstanceOf(
      MarketplaceApiError,
    );
  });

  it("stamps attempt identities on quantity-cap, purchase-limit, and bulk Listing edits", async () => {
    const requests: Array<{ body: Record<string, unknown>; attemptKey: string | null }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({
        body: (await request.json()) as Record<string, unknown>,
        attemptKey: request.headers.get("Idempotency-Key"),
      });
      return json({ items: [] });
    });
    const client = createMarketplaceApiClient({ baseUrl: "http://localhost/api/marketplace", fetch });

    await client.updateListingQuantityCap("lst_1", { quantityCap: 2, idempotencyKey: "client_quantity_attempt_0001" });
    await client.updateListingPurchaseLimits("lst_1", { maxPerBuyer: 3, idempotencyKey: "client_limits_attempt_0001" });
    await client.applyBulkListingPriceUpdates({
      batchId: "client_bulk_attempt_0001",
      updates: [{ listingId: "lst_1", priceAmount: "10.00", priceCurrencyCode: "USD" }],
    });

    expect(requests).toHaveLength(3);
    expect(requests[0]!.body).toMatchObject({ quantityCap: 2 });
    expect(requests[1]!.body).toMatchObject({ maxPerBuyer: 3 });
    expect(requests[2]!.body).toMatchObject({ updates: [{ listingId: "lst_1" }] });
    expect(requests[0]!.body.idempotencyKey).toEqual(expect.any(String));
    expect(requests[1]!.body.idempotencyKey).toEqual(expect.any(String));
    expect(requests[2]!.attemptKey).toEqual(expect.any(String));
  });
});
