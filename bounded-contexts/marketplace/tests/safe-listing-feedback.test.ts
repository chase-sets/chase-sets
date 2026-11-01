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
        attemptId: "browser_attempt_00000001",
        batchId: "browser_batch_000000001",
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
    new Error("postgres password=secret"),
    { body: { nested: "nested-secret-body" } },
    json({ secret: "nested-secret-body" }, 500),
  ])("turns a possibly-sent command failure into one redacted lookup and an ambiguous result: %s", async (failure) => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/api/auth/session")) return json({ actor });
      throw failure;
    });
    vi.stubGlobal("fetch", fetch);
    const result = await listingsAction(actionArgs("set-order-capacity"));
    expect(result).toMatchObject({ recovery: "ambiguous", error: t("marketplace.listingRecovery.ambiguous") });
    expect(inspect(result, { depth: null })).not.toMatch(/password=secret|nested-secret-body/);
    const commandCalls = fetch.mock.calls
      .map(([input]) => String(input))
      .filter((url) => !url.includes("/api/auth/session"));
    expect(commandCalls).toHaveLength(2);
    expect(commandCalls[1]).toContain("/mutation-attempts/browser_attempt_00000001?");
  });
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
    [listingsAction, "set-order-capacity", "ambiguous"],
    [listingsAction, "bulk-pause-listings", "unknown"],
    [listingsAction, "bulk-withdraw-listings", "unknown"],
    [listingsNewAction, "create-listing", "ambiguous"],
    [listingsNewAction, "create-and-publish-listing", "ambiguous"],
    [listingsNewAction, "preview-listing", "boundary"],
  ] as const)(
    "redacts an unknown 5xx for %s %s without exposing seller action data",
    async (action, intent, expected) => {
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
      let result: unknown;
      try {
        result = await action(actionArgs(intent));
      } catch (error) {
        failure = error;
      }
      if (expected === "boundary") {
        // A read-only preview has no possible-send state, so it keeps the existing root boundary.
        expect(failure).toBeInstanceOf(Response);
        expect((failure as Response).status).toBe(500);
        expect(await (failure as Response).text()).not.toMatch(/password=secret|nested-secret-body/);
      } else if (expected === "unknown") {
        // A possibly-sent bulk target is `unknown`, the only state a retry may send again.
        expect(result).toMatchObject({
          bulkBatch: { outcomes: [{ listingId: "lst_1", outcome: "unknown", message: null }] },
        });
      } else {
        expect(result).toMatchObject({ recovery: "ambiguous" });
      }
      expect([inspect(result, { depth: null }), inspect(log.mock.calls, { depth: null })].join()).not.toMatch(
        /password=secret|nested-secret-body/,
      );
    },
  );

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
    expect(result).toMatchObject({ bulkBatch: { outcomes: [{ listingId: "lst_1", outcome: "error" }] } });
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
    const attempt = { idempotencyKey: "browser_attempt_00000001" };
    await expect(client.pauseListing("lst_1", attempt)).rejects.toMatchObject({
      status: 400,
      body: { error: { code: "listing_command_rejected" } },
      message: t("marketplace.features.listings.api.route.error.commandRejected"),
    });
    await expect(client.pauseListing("lst_1", attempt)).rejects.toBeInstanceOf(MarketplaceApiError);
  });
});
