// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ChaseRoot } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import ListingRoute, { action as listingAction, loader as listingLoader } from "../routes/account-listing";
import { action as listingsAction } from "../routes/account-listings";
import { hashMarketplaceRequest } from "../features/mutation-recovery/api/attempt";
import { MarketplaceListingListPage } from "../features/listings/ui/listing-list-page";
import {
  mergeListingBatchVector,
  unknownListingBatchTargets,
  type ListingBatchVector,
} from "../features/listings/ui/listing-batch";
import type { MarketplaceListingDetail } from "../features/listings/ui/contracts";

const actor = {
  sessionId: "ses_test",
  tenantId: "tnt_test",
  userId: "usr_seller",
  accountId: "acc_seller",
  membershipId: "mem_test",
  roleKey: "owner",
  permissions: ["listings.view", "listings.manage"],
};
const listing = {
  listing_id: "lst_1",
  account_id: "acc_seller",
  inventory_item_id: "inv_1",
  catalog_catalog_item_id: "cat_one",
  product_id: "cat_one::",
  item_language_code: "en",
  item_title: "Item",
  item_subtitle: null,
  selected_options: [],
  product_summary: null,
  product_measure_snapshot: null,
  graded_card: null,
  storage_location_name: "Shelf",
  ship_from_code: "CHI",
  ship_from_address: { name: "", line1: "", city: "", state: "", postalCode: "", country: "US" },
  price_amount: "20.00",
  price_currency_code: "USD",
  listing_stream_version: 1,
  marketplace_sales_fee_unit_amount: "0.00",
  seller_net_unit_amount: "20.00",
  shipping_allowance_percentage_bps: 500,
  terms_schedule_id: "cts_launch",
  terms_agreement_id: null,
  terms_resolved_at: "2026-04-01T00:00:00.000Z",
  fee_quote_fingerprint: "fingerprint",
  fee_locks: [],
  quantity_cap: 1,
  evidence_requirements: null,
  evidence: [],
  evidence_readiness: {
    ready: true,
    policy: {
      policyId: null,
      policyVersion: null,
      policyHash: "sha256:test",
      requirementHash: "sha256:requirement",
      evaluatedAt: "2026-07-13T00:00:00.000Z",
      explanationCodes: [],
    },
    requirements: { minimumPhotoCount: 0, requiredSlots: [], sellerTrustRequirements: [], buyerAcknowledgment: "none" },
    coverage: { complete: true, unmetCodes: [], slots: [], activePhotoCount: 0, minimumPhotoCount: 0 },
    nextActions: [],
    publicGallery: [],
  },
  status: "active",
  created_at: "2026-04-01T00:00:00.000Z",
  updated_at: "2026-04-01T00:00:00.000Z",
} as unknown as MarketplaceListingDetail;
const path = "/account/listings/lst_1";
const pauseLabel = () => t("marketplace.features.listings.ui.listingDetailPage.pause.listing");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const method = (input: string | URL | Request, init?: RequestInit) =>
  (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
const lookups = (transport: ReturnType<typeof vi.fn>) =>
  transport.mock.calls.filter(([url]) => String(url).includes("mutation-attempts"));
const posts = (transport: ReturnType<typeof vi.fn>) =>
  transport.mock.calls.filter(([input, init]) => method(input as string, init as RequestInit) === "POST");

/** The owner lookup the real client issues once after a possible-send loss. */
function lookupResponse(url: URL, mode: "ambiguous" | "committed" | "injected") {
  const kind = url.searchParams.get("kind")!;
  const targetId = url.searchParams.get("target")!;
  const target = {
    kind: kind.startsWith("seller.") ? "seller" : "listing",
    id: targetId === "self" ? actor.accountId : targetId,
  };
  const recovery = {
    schemaVersion: 1,
    mutationKind: kind,
    attemptKeyFingerprint: hashMarketplaceRequest([
      actor.accountId,
      kind,
      target,
      decodeURIComponent(url.pathname.split("/").at(-1)!),
    ]),
    actorBinding: { accountId: actor.accountId },
    target,
    canonicalRequestHash: url.searchParams.get("requestHash"),
  };
  if (mode === "ambiguous") return json({ ...recovery, ownerStatus: "ambiguous", reason: "history-incomplete" });
  return json({
    ...recovery,
    ownerStatus: "committed",
    ownerReceipt: { id: target.id, version: 2 },
    // The injected mutant claims a commit for a different request; the client must not accept it.
    ...(mode === "injected" ? { canonicalRequestHash: "0".repeat(64) } : {}),
  });
}

describe("Listing route recovery through the real data router", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function setup(mode: "ambiguous" | "committed" | "injected") {
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/api/auth/session")) return json({ actor });
      if (url.pathname.includes("mutation-attempts")) return lookupResponse(url, mode);
      if (method(input, init) === "POST") throw new TypeError("response lost after possible send");
      if (url.pathname.endsWith("/fee-history")) return json({ items: [], total: 0, count: 0 });
      return json(listing);
    });
    vi.stubGlobal("fetch", transport);
    const router = createMemoryRouter(
      [{ path: "/account/listings/:listingId", loader: listingLoader, action: listingAction, Component: ListingRoute }],
      { initialEntries: [path] },
    );
    render(
      <ChaseRoot>
        <RouterProvider router={router} />
      </ChaseRoot>,
    );
    return { router, transport };
  }

  it("possible-send loss makes one lookup, never retries, and ambiguity disables writes with focus and announcement", async () => {
    const { transport } = setup("ambiguous");
    fireEvent.click(await screen.findByRole("button", { name: pauseLabel() }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(t("marketplace.listingRecovery.ambiguous"));
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(screen.getByRole("button", { name: pauseLabel() })).toHaveProperty("disabled", true);
    expect(lookups(transport)).toHaveLength(1);
    expect(posts(transport)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: pauseLabel() }));
    expect(posts(transport)).toHaveLength(1);
    expect(lookups(transport)).toHaveLength(1);
  });

  it("sends the page attempt on the command and the lookup, bound to this Listing and kind", async () => {
    const { transport } = setup("ambiguous");
    fireEvent.click(await screen.findByRole("button", { name: pauseLabel() }));
    await screen.findByRole("alert");
    const [postUrl, postInit] = posts(transport)[0]!;
    expect(new URL(String(postUrl)).pathname).toBe("/api/marketplace/account/listings/lst_1/pause");
    const headers = new Headers((postInit as RequestInit).headers);
    const sentKey =
      headers.get("Idempotency-Key") ?? JSON.parse(String((postInit as RequestInit).body ?? "{}")).idempotencyKey;
    expect(sentKey).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
    const lookupUrl = new URL(String(lookups(transport)[0]![0]));
    expect(decodeURIComponent(lookupUrl.pathname.split("/").at(-1)!)).toBe(sentKey);
    expect(lookupUrl.searchParams.get("kind")).toBe("listing.pause");
    expect(lookupUrl.searchParams.get("target")).toBe("lst_1");
  });

  it("resolves a lost command from the owner's first receipt with no retry", async () => {
    const { router, transport } = setup("committed");
    fireEvent.click(await screen.findByRole("button", { name: pauseLabel() }));
    await waitFor(() => expect(lookups(transport)).toHaveLength(1));
    await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(posts(transport)).toHaveLength(1);
  });

  it("rejects the injected-receipt mutant: a commit for another request stays ambiguous", async () => {
    const { transport } = setup("injected");
    fireEvent.click(await screen.findByRole("button", { name: pauseLabel() }));
    expect((await screen.findByRole("alert")).textContent).toBe(t("marketplace.listingRecovery.ambiguous"));
    expect(screen.getByRole("button", { name: pauseLabel() })).toHaveProperty("disabled", true);
    expect(lookups(transport)).toHaveLength(1);
    expect(posts(transport)).toHaveLength(1);
  });
});
describe("Listing bulk vector partial state", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function bulkPause(listingIds: readonly string[], batchId: string, lost: ReadonlySet<string>) {
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/api/auth/session")) return json({ actor });
      if (url.pathname.includes("mutation-attempts")) return lookupResponse(url, "ambiguous");
      const listingId = url.pathname.split("/").at(-2)!;
      if (method(input, init) === "POST" && lost.has(listingId))
        throw new TypeError("response lost after possible send");
      return json({ listingId, version: 2 });
    });
    vi.stubGlobal("fetch", transport);
    const formData = new FormData();
    formData.set("intent", "bulk-pause-listings");
    formData.set("batchId", batchId);
    for (const listingId of listingIds) formData.append("listingIds", listingId);
    const result = (await listingsAction({
      request: new Request("http://localhost/account/listings", { method: "POST", body: formData }),
      params: {},
      context: {},
    } as never)) as { bulkBatch: ListingBatchVector };
    return { transport, vector: result.bulkBatch };
  }

  it("keeps a terminal vector, retries only unknown targets under the same batch, and never re-sends a succeeded one", async () => {
    const batchId = "batch_attempt_000000000000001";
    const first = await bulkPause(["lst_1", "lst_2"], batchId, new Set(["lst_2"]));
    expect(first.vector).toMatchObject({
      batchId,
      intent: "bulk-pause-listings",
      outcomes: [
        { listingId: "lst_1", outcome: "succeeded" },
        { listingId: "lst_2", outcome: "unknown" },
      ],
    });
    expect(lookups(first.transport)).toHaveLength(1);
    expect(posts(first.transport)).toHaveLength(2);

    const retryTargets = unknownListingBatchTargets(first.vector);
    expect(retryTargets).toEqual(["lst_2"]);
    const retry = await bulkPause(retryTargets, batchId, new Set());
    expect(posts(retry.transport).map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/marketplace/account/listings/lst_2/pause",
    ]);
    const merged = mergeListingBatchVector(first.vector, retry.vector);
    expect(merged.outcomes.map((entry) => entry.outcome)).toEqual(["succeeded", "succeeded"]);
    expect(unknownListingBatchTargets(merged)).toEqual([]);
  });

  it("renders partial with focus, disables new bulk writes, and offers only the unknown targets", async () => {
    const vector: ListingBatchVector = {
      batchId: "batch_attempt_000000000000001",
      intent: "bulk-withdraw-listings",
      outcomes: [
        { listingId: "lst_1", label: "Listing lst_1", outcome: "succeeded", message: null },
        { listingId: "lst_2", label: "Listing lst_2", outcome: "unknown", message: null },
      ],
    };
    const { container } = render(
      <ChaseRoot>
        <MarketplaceListingListPage
          data={{ items: [] }}
          listingAvailability={{
            account_id: "acc_seller",
            status: "available",
            disabled_reason_category: null,
            available_again_on: null,
            available_again_at: null,
            disabled_at: null,
            enabled_at: "2026-06-01T00:00:00.000Z",
            away_window_starts_at: null,
            away_window_ends_at: null,
            away_window_reason_category: null,
            updated_at: "2026-06-01T00:00:00.000Z",
          }}
          orderCapacity={{ account_id: "acc_seller", max_open_orders: null, updated_at: "2026-06-01T00:00:00.000Z" }}
          bulkBatch={vector}
        />
      </ChaseRoot>,
    );
    const notice = await screen.findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(notice));
    const retry = screen.getByRole("button", { name: t("marketplace.listingRecovery.retryUnknown") });
    const retryForm = retry.closest("form")!;
    expect(
      [...retryForm.querySelectorAll<HTMLInputElement>('input[name="listingIds"]')].map((input) => input.value),
    ).toEqual(["lst_2"]);
    expect(retryForm.querySelector<HTMLInputElement>('input[name="batchId"]')?.value).toBe(vector.batchId);
    expect(retry.getAttribute("value")).toBe("bulk-withdraw-listings");
    for (const button of [
      t("marketplace.features.listings.ui.listingListPage.pause.selected"),
      t("marketplace.features.listings.ui.listingListPage.withdraw.selected"),
    ])
      for (const element of container.querySelectorAll("button"))
        if (element.textContent === button) expect(element).toHaveProperty("disabled", true);
  });
});
