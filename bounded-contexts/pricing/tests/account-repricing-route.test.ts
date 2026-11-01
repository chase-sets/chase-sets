import { resolveActorFromSessionId } from "@chase-sets/auth/server";
import { resolveWebHostNavItems } from "@chase-sets/platform-runtime/web";
import pricingManifest from "../context.json";
import { afterEach, describe, expect, it, vi } from "vitest";
import { action as repricingAction, loader as repricingLoader } from "../routes/marketplace/account-repricing";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createPricingRecommendationRuntime,
  type PricingMarketplaceListingGateway,
} from "../features/recommendations/api/runtime";
import type { AccountRecommendationListItem } from "../features/recommendations/read-model/queries";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("marketplace repricing route", () => {
  it("redirects a missing actor without reading or mutating pricing", async () => {
    const fetch = vi.fn(async () => jsonResponse({}, 401));
    vi.stubGlobal("fetch", fetch);
    for (const method of ["GET", "POST"]) {
      const body = new FormData();
      body.set("intent", "refresh-recommendations");
      const args = {
        request: new Request("https://marketplace.test/account/repricing", {
          method,
          ...(method === "POST" ? { body } : {}),
        }),
        params: {},
        context: undefined,
      } as never;
      await expect(method === "GET" ? repricingLoader(args) : repricingAction(args)).rejects.toMatchObject({
        status: 302,
      });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const slot of ["top-nav", "bottom-nav"] as const) {
      expect(
        resolveWebHostNavItems(
          [
            {
              contextName: "pricing",
              packageName: "@chase-sets/pricing",
              manifest: pricingManifest as Parameters<typeof resolveWebHostNavItems>[0][number]["manifest"],
            },
          ],
          "marketplace-web",
          slot,
        ),
      ).toEqual([]);
    }
  });
  it.each(["owner", "manager", "fulfillment", "viewer", "platform-admin"])(
    "authorizes account repricing with current role presets: %s",
    async (roleKey) => {
      for (const verified of [true, false]) {
        const actor = await resolvePricingActor(roleKey, verified);
        const fetch = vi.fn(async (input: string | URL | Request) => {
          if (String(input).includes("/api/auth/session")) return jsonResponse({ actor });
          return jsonResponse({ items: [], total: 0, count: 0, jobId: "job_synthetic_pricing" });
        });
        vi.stubGlobal("fetch", fetch);
        const args = {
          request: new Request("https://marketplace.test/account/repricing"),
          params: {},
          context: undefined,
        } as never;
        if (roleKey === "platform-admin") {
          await expect(repricingLoader(args)).rejects.toMatchObject({ status: 403 });
        } else {
          await expect(repricingLoader(args)).resolves.toMatchObject({ recommendations: { items: [] } });
        }
        for (const slot of ["top-nav", "bottom-nav"] as const) {
          const items = resolveWebHostNavItems(
            [
              {
                contextName: "pricing",
                packageName: "@chase-sets/pricing",
                manifest: pricingManifest as Parameters<typeof resolveWebHostNavItems>[0][number]["manifest"],
              },
            ],
            "marketplace-web",
            slot,
            actor,
          );
          // Marketplace never rendered Pricing in its bottom bar, so #9551 removed that dead declaration.
          expect(items.some((item) => item.href === "/account/repricing")).toBe(
            slot === "top-nav" && roleKey !== "platform-admin",
          );
        }
        fetch.mockClear();
        const body = new FormData();
        body.set("intent", "refresh-recommendations");
        const action = repricingAction({
          request: new Request("https://marketplace.test/account/repricing", { method: "POST", body }),
          params: {},
          context: undefined,
        } as never);
        if (verified && ["owner", "manager"].includes(roleKey)) {
          await expect(action).resolves.toMatchObject({ status: 302 });
          expect(fetch.mock.calls.some(([url]) => String(url).includes("/recommendations/refresh"))).toBe(true);
        } else {
          await expect(action).rejects.toMatchObject({ status: 403 });
          expect(fetch.mock.calls.every(([url]) => String(url).includes("/api/auth/session"))).toBe(true);
        }
      }
    },
  );
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads advisory pricing recommendations through the pricing API", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        requestedUrls.push(url);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["pricing.view"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse({
            items: [
              {
                recommendation_id: "rec_1",
                catalog_catalog_item_id: "cat_1",
                seller_account_id: "acc_1",
                catalog_item_title: "Charizard ex",
                catalog_item_subtitle: null,
                catalog_item_status: "active",
                market_price_amount: 20,
                market_currency: "USD",
                market_observed_at: "2026-05-09T00:00:00.000Z",
                recommended_list_amount: 22,
                recommendation_reason: "Protect margin.",
                recommendation_published_at: null,
                stock_on_hand_quantity: 4,
                stock_reserved_quantity: 1,
                active_listing_count: 3,
                lowest_listing_price_amount: 18,
                active_offer_count: 2,
                highest_offer_price_amount: 19,
                committed_order_quantity: 5,
                delivered_quantity: 4,
                returned_quantity: 1,
                updated_at: "2026-05-09T00:02:00.000Z",
              },
            ],
            total: 1,
            count: 1,
          }),
        );
      }),
    );

    const result = await repricingLoader({
      request: new Request("http://localhost/account/repricing"),
      params: {},
      context: undefined,
    } as never);

    expect(result.recommendations.items[0]?.recommendation_id).toBe("rec_1");
    expect(requestedUrls.some((url) => url.includes("/api/marketplace/account/recommendations"))).toBe(true);
  });

  it("hydrates the active recommendation job snapshot after a write redirect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["pricing.view"],
              },
            }),
          );
        }

        if (url.includes("/api/marketplace/account/recommendation-jobs/job_apply")) {
          return Promise.resolve(
            jsonResponse({
              jobId: "job_apply",
              jobKind: "apply",
              status: "queued",
              progress: {
                phase: "queued",
                completed: 0,
                total: 1,
                message: "Recommendation job queued.",
              },
              result: null,
              errorMessage: null,
              createdAt: "2026-05-09T00:00:00.000Z",
              startedAt: null,
              completedAt: null,
              updatedAt: "2026-05-09T00:00:00.000Z",
            }),
          );
        }

        return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
      }),
    );

    const result = await repricingLoader({
      request: new Request("http://localhost/account/repricing?jobId=job_apply"),
      params: {},
      context: undefined,
    } as never);

    expect(result.activeJob).toMatchObject({
      jobId: "job_apply",
      status: "queued",
      progress: {
        message: "Recommendation job queued.",
      },
    });
  });

  it("redirects apply writes to a job snapshot correction route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["pricing.view", "pricing.manage"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse({
            jobId: "job_apply",
            jobKind: "apply",
            status: "queued",
            progress: {
              phase: "queued",
              completed: 0,
              total: 1,
              message: "Recommendation job queued.",
            },
            result: null,
            errorMessage: null,
            createdAt: "2026-05-09T00:00:00.000Z",
            startedAt: null,
            completedAt: null,
            updatedAt: "2026-05-09T00:00:00.000Z",
          }),
        );
      }),
    );

    const form = new FormData();
    form.set("intent", "apply-recommendations");
    form.append("recommendationId", "rec_1");
    const response = await repricingAction({
      request: new Request("http://localhost/account/repricing", {
        method: "POST",
        body: form,
      }),
      params: {},
      context: undefined,
    } as never);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("Location")).toBe("/account/repricing?jobId=job_apply");
  });

  it("retries a commit-then-loss apply with the same target attempts and never re-applies a succeeded recommendation", async () => {
    const pricing = createApplyHarness([recommendationRow("rec_a", "lst_a"), recommendationRow("rec_b", "lst_b")]);
    vi.stubGlobal("fetch", pricing.fetch);
    const submit = async (recommendationIds: readonly string[]) => {
      const form = new FormData();
      form.set("intent", "apply-recommendations");
      for (const id of recommendationIds) form.append("recommendationId", id);
      const response = await repricingAction({
        request: new Request("http://localhost/account/repricing", { method: "POST", body: form }),
        params: {},
        context: undefined,
      } as never);
      expect((response as Response).status).toBe(302);
    };

    // Marketplace commits both targets, then the response is lost before Pricing records the outcome.
    pricing.loseNextResponse();
    await submit(["rec_a", "rec_b"]);
    expect(pricing.appendsByListing()).toEqual({ lst_a: 1, lst_b: 1 });
    expect(pricing.statusOf("rec_a")).not.toBe("applied");

    await submit(["rec_a", "rec_b"]);
    expect(pricing.gatewayCalls).toHaveLength(2);
    expect(pricing.gatewayCalls[1]).toEqual(pricing.gatewayCalls[0]);
    expect(pricing.appendsByListing()).toEqual({ lst_a: 1, lst_b: 1 });
    expect([pricing.statusOf("rec_a"), pricing.statusOf("rec_b")]).toEqual(["applied", "applied"]);

    // A later apply that includes the succeeded targets sends only the new recommendation.
    pricing.addRecommendation(recommendationRow("rec_c", "lst_c"));
    await submit(["rec_a", "rec_b", "rec_c"]);
    expect(pricing.gatewayCalls).toHaveLength(3);
    expect(pricing.gatewayCalls[2]!.updates.map((update) => update.listingId)).toEqual(["lst_c"]);
    expect(pricing.appendsByListing()).toEqual({ lst_a: 1, lst_b: 1, lst_c: 1 });
    expect(pricing.applyRequests()).toBe(3);
  });
});

type RecommendationRow = AccountRecommendationListItem;

function recommendationRow(recommendationId: string, listingId: string): RecommendationRow {
  return {
    recommendation_id: recommendationId,
    catalog_catalog_item_id: `cat_${recommendationId}`,
    catalog_item_language_code: "en",
    seller_account_id: "acc_1",
    action_type: "active-listing-price-update",
    status: "proposed",
    listing_id: listingId,
    inventory_item_id: `inv_${recommendationId}`,
    catalog_item_title: "Charizard ex",
    catalog_item_subtitle: null,
    catalog_item_status: "active",
    market_price_amount: 18,
    market_currency: "USD",
    market_signal_type: "competition",
    market_observed_at: "2026-05-09T00:00:00.000Z",
    current_price_amount: 20,
    current_price_currency_code: "USD",
    recommended_list_amount: 17.99,
    recommendation_reason: "Priced one cent below the lowest competing active listing.",
    quantity_cap: 1,
    applied_listing_id: null,
    last_error: null,
    recommendation_published_at: "2026-05-09T00:00:00.000Z",
    stock_on_hand_quantity: 1,
    stock_reserved_quantity: 0,
    active_listing_count: 2,
    lowest_listing_price_amount: 18,
    active_offer_count: 0,
    highest_offer_price_amount: null,
    committed_order_quantity: 0,
    delivered_quantity: 0,
    returned_quantity: 0,
    updated_at: "2026-05-09T00:00:00.000Z",
  };
}

/**
 * Serves the route's apply request with the real Pricing recommendation runtime. The Marketplace gateway
 * records each target attempt once, replays a recorded attempt with zero appends, and can lose a response
 * after committing, so the counts show which targets a retry actually re-sends.
 */
function createApplyHarness(initialRows: readonly RecommendationRow[]) {
  const rows = [...initialRows];
  const streams = new Map<string, StoredEvent[]>();
  const eventStore: EventStore = {
    appendToStream: async (input: AppendToStreamInput) => {
      const existing = streams.get(input.streamId) ?? [];
      const stored = input.events.map(
        (event, index) =>
          ({
            eventId: `evt_${input.streamId}_${existing.length + index + 1}` as never,
            streamId: input.streamId,
            streamVersion: existing.length + index + 1,
            globalPosition: String(existing.length + index + 1) as never,
            tenantId: input.context.tenantId,
            eventType: event.eventType,
            payload: event.payload,
            metadata: event.metadata ?? {},
            occurredAt: "2026-05-09T00:00:00.000Z" as never,
            recordedAt: "2026-05-09T00:00:00.000Z" as never,
            performedByUserId: input.context.audit.performedByUserId,
            forAccountId: input.context.audit.forAccountId,
          }) satisfies StoredEvent,
      );
      streams.set(input.streamId, [...existing, ...stored]);
      return stored;
    },
    readStream: async ({ streamId }) => streams.get(streamId) ?? [],
    readAll: async () => [...streams.values()].flat(),
  };
  const statusOf = (recommendationId: string) =>
    (streams.get(`pricing.recommendation-${recommendationId}`) ?? []).some(
      (event) => event.eventType === "pricing.recommendation.applied",
    )
      ? "applied"
      : "proposed";
  const db: PgQueryable = {
    query: async <T>(sql: string, values?: readonly unknown[]) => {
      if (!sql.includes("FROM pricing_recommendation_feed")) return { rows: [] as T[] };
      const ids = new Set((values?.[1] as string[] | undefined) ?? []);
      return {
        rows: rows
          .filter((row) => ids.has(row.recommendation_id))
          .map((row) => ({ ...row, status: statusOf(row.recommendation_id) })) as T[],
      };
    },
  };
  const services = createPricingRecommendationRuntime({ eventStore, checkpointStore: {} as never, db });
  const context: EventStoreContext = {
    tenantId: "ten_1" as never,
    audit: { performedByUserId: "usr_1" as never, forAccountId: "acc_1" as never },
  };
  const proposeAll = (proposed: readonly RecommendationRow[]) =>
    Promise.all(
      proposed.map((row) =>
        services.commandHandler({
          streamId: `pricing.recommendation-${row.recommendation_id}`,
          command: {
            type: "ProposeRecommendation",
            recommendationId: row.recommendation_id,
            catalogItemId: row.catalog_catalog_item_id,
            sellerAccountId: row.seller_account_id,
            actionType: row.action_type,
            listingId: row.listing_id,
            inventoryItemId: row.inventory_item_id,
            marketPriceAmount: row.market_price_amount,
            marketCurrency: row.market_currency,
            marketSignalType: row.market_signal_type,
            currentPriceAmount: row.current_price_amount,
            recommendedListAmount: row.recommended_list_amount ?? row.market_price_amount,
            reason: row.recommendation_reason ?? "Recommendation proposed.",
            quantityCap: row.quantity_cap,
            observedAt: row.market_observed_at,
          },
          context,
        }),
      ),
    );
  let seeded = proposeAll(rows);

  const recordedAttempts = new Map<string, Readonly<{ listingId: string; priceAmount: string; version: number }>>();
  const appends: Record<string, number> = {};
  const gatewayCalls: Parameters<PricingMarketplaceListingGateway["applyBulkListingPriceUpdates"]>[0][] = [];
  let loseNext = false;
  const marketplaceListings: PricingMarketplaceListingGateway = {
    applyBulkListingPriceUpdates: async (body) => {
      gatewayCalls.push(body);
      const items = body.updates.map((update) => {
        const recorded = recordedAttempts.get(update.idempotencyKey);
        if (recorded) {
          const same = recorded.listingId === update.listingId && recorded.priceAmount === update.priceAmount;
          return {
            listingId: update.listingId,
            outcome: same ? "applied" : "conflict",
            version: recorded.version,
          } as const;
        }
        appends[update.listingId] = (appends[update.listingId] ?? 0) + 1;
        recordedAttempts.set(update.idempotencyKey, { ...update, version: 2 });
        return { listingId: update.listingId, outcome: "applied", version: 2 } as const;
      });
      if (loseNext) {
        loseNext = false;
        throw new TypeError("response lost after Marketplace committed");
      }
      return { items };
    },
    createListing: async () => {
      throw new Error("No draft create is selected in this route test.");
    },
  };

  let applyRequests = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/api/auth/session")) {
      return jsonResponse({
        actor: {
          sessionId: "ses_1",
          tenantId: "tnt_identity",
          userId: "usr_1",
          accountId: "acc_1",
          membershipId: "mbr_1",
          roleKey: "owner",
          permissions: ["pricing.view", "pricing.manage"],
        },
      });
    }
    if (!url.pathname.endsWith("/account/recommendations/apply")) return jsonResponse({}, 404);
    applyRequests += 1;
    const body = input instanceof Request ? await input.text() : String(init?.body ?? "{}");
    const { recommendationIds } = JSON.parse(body) as { recommendationIds: string[] };
    await seeded;
    const status = await services
      .applyRecommendations({ accountId: "acc_1", recommendationIds, marketplaceListings }, context)
      .then(
        () => "succeeded" as const,
        () => "failed" as const,
      );
    return jsonResponse({
      jobId: `job_apply_${applyRequests}`,
      jobKind: "apply",
      status,
      progress: { phase: status, completed: 1, total: 1, message: "Recommendation job finished." },
      result: null,
      errorMessage: null,
      createdAt: "2026-05-09T00:00:00.000Z",
      startedAt: "2026-05-09T00:00:00.000Z",
      completedAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:00.000Z",
    });
  });

  return {
    fetch,
    gatewayCalls,
    statusOf,
    loseNextResponse: () => {
      loseNext = true;
    },
    addRecommendation: (row: RecommendationRow) => {
      rows.push(row);
      seeded = seeded.then(() => proposeAll([row]));
    },
    appendsByListing: () => ({ ...appends }),
    applyRequests: () => applyRequests,
  };
}

async function resolvePricingActor(roleKey: string, verified = true, accountId = "acc_synthetic_pricing") {
  const services = {
    sessions: {
      readAuthenticatedSession: vi.fn(async () => ({
        state: {
          id: "ses_synthetic_pricing",
          userId: "usr_synthetic_pricing",
          accountId,
          availableAccountIds: [accountId],
          authenticationMethod: "password",
          status: "active",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        authenticatedAt: "2026-09-01T00:00:00.000Z",
      })),
      getSession: vi.fn(async () => null),
    },
    identity: {
      getActiveMembershipForUserAccount: vi.fn(async () => ({
        membership_id: "mbr_synthetic_pricing",
        user_id: "usr_synthetic_pricing",
        account_id: accountId,
        role_key: roleKey,
        role_permissions: [],
        status: "active",
      })),
      getUser: vi.fn(async () => ({
        primary_email: "synthetic-pricing@example.test",
        contact_methods: [
          {
            type: "email",
            value: "synthetic-pricing@example.test",
            verifiedAt: verified ? "2026-09-01T00:00:00.000Z" : null,
          },
        ],
        social_login_links: [],
      })),
    },
  } as unknown as Parameters<typeof resolveActorFromSessionId>[0];
  const actor = await resolveActorFromSessionId(services, "ses_synthetic_pricing");
  expect(actor).not.toBeNull();
  return actor!;
}
