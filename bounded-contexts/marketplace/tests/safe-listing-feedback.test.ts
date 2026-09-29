import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "@chase-sets/localization";
import { action as listingsAction } from "../routes/account-listings";
import { action as listingsNewAction } from "../routes/account-listings-new";
import { createMarketplaceApiClient, MarketplaceApiError } from "../client";

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
function actionArgs(intent: string) {
  return {
    request: new Request("http://localhost/account/listings", {
      method: "POST",
      body: new URLSearchParams({
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
  it.each([
    [listingsAction, "set-order-capacity", "order_capacity_invalid", "orderCapacityInvalid"],
    [listingsNewAction, "create-listing", "listing_command_rejected", "commandRejected"],
  ] as const)("presents only allowlisted Listing feedback for %s %s", async (action, intent, code, copy) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).includes("/api/auth/session")
          ? json({ actor })
          : json({ error: { code, message: "untrusted-copy-secret" } }, 400),
      ),
    );
    const result = await action(actionArgs(intent));
    expect(result).toMatchObject({ error: t(`marketplace.features.listings.api.route.error.${copy}`) });
    expect(inspect(result)).not.toContain("untrusted-copy-secret");
  });

  it.each([
    [listingsAction, "set-order-capacity"],
    [listingsAction, "bulk-pause-listings"],
    [listingsAction, "bulk-withdraw-listings"],
    [listingsNewAction, "create-listing"],
    [listingsNewAction, "create-and-publish-listing"],
    [listingsNewAction, "preview-listing"],
  ] as const)("sends unknown 5xx to the existing boundary, never seller action data: %s %s", async (action, intent) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).includes("/api/auth/session")
          ? json({ actor })
          : json(
              {
                error: {
                  code: "internal_error",
                  message: "postgres password=secret",
                  nested: { body: "nested-secret-body" },
                },
              },
              500,
            ),
      ),
    );
    let failure: unknown;
    try {
      await action(actionArgs(intent));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Response);
    const response = failure as Response;
    expect(response.status).toBe(500);
    expect([await response.text(), inspect(log.mock.calls, { depth: null })].join()).not.toMatch(
      /password=secret|nested-secret-body/,
    );
  });

  it("keeps a non-admitted bulk 4xx as a redacted per-row outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input).includes("/api/auth/session")
          ? json({ actor })
          : json({ error: { code: "validation_failed", message: "postgres password=secret" } }, 400),
      ),
    );
    const result = await listingsAction(actionArgs("bulk-pause-listings"));
    expect(result).toMatchObject({ bulkActionOutcomes: [{ listingId: "lst_1", outcome: "error" }] });
    expect(inspect(result, { depth: null })).not.toContain("password=secret");
  });

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
    await expect(client.pauseListing("lst_1")).rejects.toMatchObject({
      status: 400,
      body: { error: { code: "listing_command_rejected" } },
      message: t("marketplace.features.listings.api.route.error.commandRejected"),
    });
    await expect(client.pauseListing("lst_1")).rejects.toBeInstanceOf(MarketplaceApiError);
  });
});
