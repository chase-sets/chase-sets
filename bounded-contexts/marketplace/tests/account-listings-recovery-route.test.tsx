// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ChaseRoot } from "@chase-sets/design-system";
import Route, { action, loader, shouldRevalidate, ErrorBoundary } from "../routes/account-listings";
import ListingRoute, {
  action as listingAction,
  loader as listingLoader,
  shouldRevalidate as listingShouldRevalidate,
} from "../routes/account-listing";
import { hashMarketplaceRequest, marketplaceAttemptBinding } from "../features/mutation-recovery/api/attempt";
import {
  listingRecoveryForForm,
  listingRecoveryUrl,
  type ListingRecoveryIdentity,
  type ListingRecoveryOutcome,
} from "../features/listings/ui/listing-batch";
import { t } from "@chase-sets/localization";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createMarketplaceListingRuntime } from "../features/listings/api/runtime";
import { createListingMutationLookup } from "../features/listings/api/listing-attempt";

const actor = {
  sessionId: "ses_test",
  tenantId: "tnt_test",
  userId: "usr_test",
  accountId: "acc_seller",
  membershipId: "mem_test",
  roleKey: "owner",
  permissions: ["listings.view", "listings.manage"],
};
const path = "/account/listings";
const batchId = "listing_recovery_batch_00001_bulk-pause-listings";
const listing = {
  listing_id: "lst_one",
  account_id: actor.accountId,
  item_title: "Test Listing",
  catalog_catalog_item_id: "cat_one",
  inventory_item_id: "inv_one",
  price_amount: "10.00",
  price_currency_code: "USD",
  quantity_cap: 1,
  evidence: [],
  status: "active",
  product_measure_snapshot: {},
  shipping_allowance_percentage_bps: 0,
  listing_stream_version: 1,
};
const availability = {
  account_id: actor.accountId,
  status: "available",
  updated_at: "2026-01-01T00:00:00.000Z",
  away_window_starts_at: null,
  away_window_ends_at: null,
  away_window_reason_category: null,
};
const json = (body: unknown) => Response.json(body);
function identity(ids = ["lst_one"]): ListingRecoveryIdentity {
  return {
    batchId,
    bulk: true,
    mutationKind: "listing.pause",
    targets: ids.map((id) => ({ id, requestHash: hashMarketplaceRequest({ listingId: id, reason: "seller" }) })),
  };
}

function routerReady(router: ReturnType<typeof createMemoryRouter>) {
  if (router.state.initialized && router.state.navigation.state === "idle" && router.state.revalidation === "idle")
    return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = router.subscribe((state) => {
      if (state.initialized && state.navigation.state === "idle" && state.revalidation === "idle") {
        unsubscribe();
        resolve();
      }
    });
  });
}

describe("Listing recovery through a real data router", () => {
  beforeEach(() => vi.stubGlobal("crypto", webcrypto));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function setup(
    outcomes: ListingRecoveryOutcome[],
    options: {
      retained?: boolean;
      loseSend?: boolean;
      holdLookup?: Promise<void>;
      poisoned?: boolean;
      injected?: boolean;
      loseRouteResponse?: boolean;
      failReadsAfterRouteLoss?: boolean;
      failPageReads?: boolean;
      failPreparation?: boolean;
      realNoOp?: boolean;
    } = {},
  ) {
    const ids = outcomes.map((_, index) => (index === 0 ? "lst_one" : `lst_${index + 1}`));
    const reference = identity(ids);
    const state = new Map(ids.map((id, index) => [id, outcomes[index]!]));
    const lookups: string[] = [];
    const sends: string[][] = [];
    let prepared = reference;
    let established = options.retained !== false;
    const { eventStore, allEvents } = createInMemoryEventStore();
    const context = {
      tenantId: actor.tenantId as never,
      audit: { performedByUserId: actor.userId as never, forAccountId: actor.accountId as never },
    };
    const runtime = createMarketplaceListingRuntime({
      eventStore,
      db: { query: async () => ({ rows: [] }) } as never,
      checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
      commercialTermsResolver: { resolveListingTerms: vi.fn() } as never,
    });
    if (options.realNoOp) {
      await eventStore.appendToStream({
        streamId: "marketplace.listing-lst_one",
        expectedVersion: "no_stream",
        context,
        events: [
          {
            eventType: "marketplace.listing.created",
            payload: {
              listingId: "lst_one",
              accountId: actor.accountId,
              inventoryItemId: "inv_one",
              catalogItemId: "cat_one",
              productId: "cat_one::",
              itemTitle: "Synthetic Listing",
              itemSubtitle: null,
              selectedOptions: [],
              productSummary: null,
              storageLocationName: null,
              shipFromCode: null,
              shipFromAddress: null,
              priceAmount: "10.00",
              priceCurrencyCode: "USD",
              marketplaceSalesFeeUnitAmount: null,
              sellerNetUnitAmount: null,
              termsScheduleId: null,
              termsAgreementId: null,
              termsResolvedAt: null,
              feeLocks: [],
              quantityCap: 1,
              evidence: [],
            },
          },
          { eventType: "marketplace.listing.paused", payload: { reason: "seller" } },
        ],
      });
    }
    let routeResponseLost = false;
    let router: ReturnType<typeof createMemoryRouter>;
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/api/auth/session")) return json({ actor });
      if (url.pathname.endsWith("/listings/batch/prepare")) {
        if (options.failPreparation) throw new TypeError("preparation unavailable");
        prepared = JSON.parse(String(init?.body));
        if (options.realNoOp) await runtime.prepareListingBatch(actor.accountId, prepared, context);
        established = true;
        return json({ prepared: true });
      }
      if (routeResponseLost && options.failReadsAfterRouteLoss) {
        if (url.pathname.includes("mutation-attempts")) lookups.push(url.searchParams.get("target")!);
        throw new TypeError("read connection unavailable");
      }
      if (url.pathname.includes("mutation-attempts")) {
        const id = url.searchParams.get("target")!;
        lookups.push(id);
        await options.holdLookup;
        if (options.realNoOp)
          return json(
            await createListingMutationLookup(eventStore)({
              attemptId: decodeURIComponent(url.pathname.split("/").at(-1)!),
              accountId: actor.accountId,
              mutationKind: "listing.pause",
              target: { kind: "listing", id },
              requestHash: url.searchParams.get("requestHash")!,
            }),
          );
        const binding = marketplaceAttemptBinding({
          attemptId: decodeURIComponent(url.pathname.split("/").at(-1)!),
          accountId: actor.accountId,
          mutationKind: url.searchParams.get("kind") as "listing.pause",
          target: { kind: "listing", id },
          request: null,
        });
        return json({
          ...binding,
          canonicalRequestHash: options.poisoned ? "0".repeat(64) : url.searchParams.get("requestHash"),
          ownerStatus:
            state.get(id) === "succeeded" ? "committed" : state.get(id) === "ambiguous" ? "ambiguous" : "not-observed",
          ...(state.get(id) === "succeeded" ? { ownerReceipt: { id, version: 2 } } : {}),
        });
      }
      if (url.pathname.includes("/listings/batch/")) {
        if (options.realNoOp)
          return json(
            await runtime.lookupListingBatch({
              accountId: actor.accountId,
              batchId: decodeURIComponent(url.pathname.split("/").at(-1)!),
              family: "listing.pause",
            }),
          );
        return json({
          batchId: decodeURIComponent(url.pathname.split("/").at(-1)!),
          family: url.searchParams.get("family"),
          items: [...state].map(([targetId, outcome]) => ({
            targetId,
            outcome: outcome === "ambiguous" ? "unknown" : outcome,
            version: outcome === "succeeded" ? 2 : 0,
            requestHash: prepared.targets.find((target) => target.id === targetId)?.requestHash,
          })),
        });
      }
      if (url.pathname.endsWith("/listings/batch") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { batchId: string; family: string; listingIds: string[] };
        expect(router.state.location.search).toContain("listingRecovery=");
        expect(established).toBe(true);
        sends.push(body.listingIds);
        if (options.realNoOp) {
          await runtime.applyListingBatch(
            { accountId: actor.accountId, batchId: body.batchId, family: "listing.pause", listingIds: body.listingIds },
            context,
          );
          throw new TypeError("synthetic no-op response lost");
        }
        for (const id of body.listingIds) state.set(id, "succeeded");
        if (options.loseSend) throw new TypeError("response lost after commit");
        return json({
          batchId: body.batchId,
          family: body.family,
          items: body.listingIds.map((targetId) => ({ targetId, outcome: "succeeded", version: 2 })),
        });
      }
      if (options.failPageReads) throw new TypeError("projected reads unavailable");
      if (url.pathname.endsWith("listing-availability")) return json(availability);
      if (url.pathname.endsWith("order-capacity"))
        return json(
          url.pathname.includes("sales")
            ? { open_order_count: 0 }
            : { account_id: actor.accountId, max_open_orders: null, updated_at: availability.updated_at },
        );
      if (url.pathname.endsWith("/account/listings"))
        return json({
          items: [listing],
          total: 1,
          count: 1,
          limit: 100,
          offset: 0,
          statusCounts: { active: 1, draft: 0, paused: 0, withdrawn: 0 },
        });
      return json({ items: [], total: 0, count: 0 });
    });
    vi.stubGlobal("fetch", transport);
    router = createMemoryRouter(
      [
        {
          path,
          loader,
          action: options.loseRouteResponse
            ? async (args: Parameters<typeof action>[0]) => {
                await action(args);
                routeResponseLost = true;
                throw new TypeError("route POST response lost after possible commit");
              }
            : action,
          ErrorBoundary,
          shouldRevalidate,
          Component: options.injected
            ? () => <Route {...({ listingRecovery: { phase: "succeeded", identity: null, items: [] } } as object)} />
            : Route,
        },
      ],
      { initialEntries: [options.retained === false ? path : listingRecoveryUrl(path, reference)] },
    );
    const mount = () =>
      render(
        <ChaseRoot>
          <RouterProvider router={router} />
        </ChaseRoot>,
      );
    await act(async () => {
      mount();
      await routerReady(router);
    });
    return { router, reference, lookups, sends, state, transport, mount, allEvents };
  }

  it("reopens a real C2 zero-event pause after response loss as succeeded, without another owner event or terminal send", async () => {
    const fixture = await setup(["unknown"], { retained: false, realNoOp: true });
    fireEvent.click(screen.getAllByLabelText("Select row lst_one")[0]!);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause selected" }));
    });
    await act(async () => {
      await routerReady(fixture.router);
    });
    await screen.findAllByText(t("marketplace.listingRecovery.succeeded"));
    const ownerEvents = () => fixture.allEvents.filter((event) => event.streamId === "marketplace.listing-lst_one");
    expect(ownerEvents()).toHaveLength(2);
    expect(fixture.lookups).toEqual(["lst_one", "lst_one", "lst_one"]);
    const before = fixture.allEvents.length;
    await act(async () => {
      await fixture.router.revalidate();
    });
    expect(fixture.lookups).toHaveLength(4);
    expect(fixture.allEvents).toHaveLength(before);
    await screen.findAllByText(t("marketplace.listingRecovery.succeeded"));
    expect(screen.getByRole("link", { name: t("marketplace.listingRecovery.continue") })).toBeTruthy();
    const form = new FormData();
    form.set("intent", "retry-listing-batch");
    await act(async () => {
      await fixture.router.navigate(`${path}${fixture.router.state.location.search}`, {
        formMethod: "post",
        formData: form,
      });
    });
    expect(fixture.sends).toEqual([["lst_one"]]);
    expect(ownerEvents()).toHaveLength(2);
  });

  it("never sends a command when server preparation fails", async () => {
    const fixture = await setup(["unknown"], { retained: false, failPreparation: true });
    fireEvent.click(screen.getAllByLabelText("Select row lst_one")[0]!);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause selected" }));
    });
    await screen.findAllByText(t("marketplace.listingRecovery.failedSafe"));
    expect(fixture.sends).toEqual([]);
    expect(fixture.router.state.location.search).toBe("");
  });

  it.each([
    [["unknown"], "confirming"],
    [["succeeded"], "succeeded"],
    [["succeeded", "unknown", "error"], "partial"],
    [["conflict"], "conflict"],
    [["error"], "failedSafe"],
    [["ambiguous"], "ambiguous"],
  ] as const)("loads the %s vector as %s from the actual loader", async (outcomes, phase) => {
    const fixture = await setup([...outcomes]);
    await screen.findAllByText(
      t(`marketplace.listingRecovery.${phase}`, {
        succeeded: outcomes.filter((item) => item === "succeeded").length,
        total: outcomes.length,
      }),
    );
    expect(fixture.lookups).toEqual(fixture.reference.targets.map((target) => target.id));
    expect(fixture.sends).toEqual([]);
    if (phase === "ambiguous") {
      const alert = screen.getByRole("alert");
      await waitFor(() => expect(document.activeElement).toBe(alert));
      expect(alert.textContent).toBe(t("marketplace.listingRecovery.ambiguous"));
      expect(screen.getByRole("button", { name: "Turn off listings" }).matches(":disabled")).toBe(true);
      const form = new FormData();
      form.set("intent", "retry-listing-batch");
      await act(async () => {
        await fixture.router.navigate(`${path}${fixture.router.state.location.search}`, {
          formMethod: "post",
          formData: form,
        });
      });
      expect(fixture.sends).toEqual([]);
    }
    if (phase === "partial") {
      expect(screen.getByText("lst_one: succeeded, will not send again")).toBeTruthy();
      expect(screen.getByText("lst_2: unknown, available for explicit retry")).toBeTruthy();
      expect(screen.getByText("lst_3: failed safely, will not send again")).toBeTruthy();
    }
  });

  it("shows loading while a real navigation waits for owner history", async () => {
    let release!: () => void;
    const holdLookup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await setup(["unknown"], { retained: false, holdLookup });
    await screen.findByText("Listing health");
    let navigation!: Promise<void>;
    act(() => {
      navigation = fixture.router.navigate(listingRecoveryUrl(path, fixture.reference));
    });
    await screen.findAllByText(t("marketplace.listingRecovery.loading"));
    expect(screen.getByRole("button", { name: "Turn off listings" }).matches(":disabled")).toBe(true);
    await act(async () => {
      release();
      await navigation;
    });
    await screen.findByRole("button", { name: t("marketplace.listingRecovery.retryUnknown") });
  });

  it("reopens retained owner history once even when projected page reads are unavailable", async () => {
    const fixture = await setup(["succeeded"], { failPageReads: true });
    await screen.findAllByText(t("marketplace.listingRecovery.succeeded"));
    expect(fixture.lookups).toEqual(["lst_one"]);
    expect(fixture.sends).toEqual([]);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("looks up once after possible-send loss, retains the pre-send URL, and reopens without another append", async () => {
    const fixture = await setup(["unknown"], { retained: false, loseSend: true });
    await screen.findByText("Listing health");
    fireEvent.click(screen.getAllByLabelText("Select row lst_one")[0]!);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause selected" }));
    });
    await act(async () => {
      await routerReady(fixture.router);
    });
    await screen.findAllByText(t("marketplace.listingRecovery.succeeded"));
    // One preparation lookup, one action preflight, then exactly one recovery lookup. No revalidation lookup.
    expect(fixture.lookups).toEqual(["lst_one", "lst_one", "lst_one"]);
    expect(fixture.sends).toEqual([["lst_one"]]);
    const retained = `${path}${fixture.router.state.location.search}`;
    cleanup();
    const reopened = createMemoryRouter([{ path, loader, action, shouldRevalidate, Component: Route }], {
      initialEntries: [retained],
    });
    await act(async () => {
      render(
        <ChaseRoot>
          <RouterProvider router={reopened} />
        </ChaseRoot>,
      );
      await routerReady(reopened);
    });
    await screen.findAllByText(t("marketplace.listingRecovery.succeeded"));
    expect(fixture.lookups).toHaveLength(4);
    expect(fixture.sends).toEqual([["lst_one"]]);
  });

  it("submits only explicit unknown targets, never succeeded, conflict or error targets, including on a repeated POST", async () => {
    const fixture = await setup(["succeeded", "conflict", "error", "unknown"]);
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: t("marketplace.listingRecovery.retryUnknown") }));
      await routerReady(fixture.router);
    });
    await waitFor(() => expect(fixture.sends).toEqual([["lst_4"]]));
    await waitFor(() => expect(fixture.router.state.navigation.state).toBe("idle"));
    expect(fixture.lookups).toHaveLength(8);
    const form = new FormData();
    form.set("intent", "retry-listing-batch");
    await act(async () => {
      await fixture.router.navigate(`${path}${fixture.router.state.location.search}`, {
        formMethod: "post",
        formData: form,
      });
    });
    expect(fixture.lookups).toHaveLength(12);
    expect(fixture.sends).toEqual([["lst_4"]]);
  });

  it("recovers a lost route POST response through one loader lookup rather than repeating the action", async () => {
    const fixture = await setup(["unknown"], { retained: false, loseRouteResponse: true });
    fireEvent.click(screen.getAllByLabelText("Select row lst_one")[0]!);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause selected" }));
    });
    await act(async () => {
      await routerReady(fixture.router);
    });
    await screen.findAllByText(t("marketplace.listingRecovery.succeeded"));
    expect(fixture.lookups).toEqual(["lst_one", "lst_one", "lst_one"]);
    expect(fixture.sends).toEqual([["lst_one"]]);
  });

  it("announces ambiguity with no writes when the lost route response cannot be reloaded", async () => {
    const fixture = await setup(["unknown"], {
      retained: false,
      loseRouteResponse: true,
      failReadsAfterRouteLoss: true,
    });
    fireEvent.click(screen.getAllByLabelText("Select row lst_one")[0]!);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause selected" }));
    });
    await act(async () => {
      await routerReady(fixture.router);
    });
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(alert.textContent).toBe(t("marketplace.listingRecovery.ambiguous"));
    // The unavailable vector cannot reconstruct targets, so recovery refuses before any owner lookup.
    expect(fixture.lookups).toEqual(["lst_one", "lst_one"]);
    expect(fixture.sends).toEqual([["lst_one"]]);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("rejects poisoned owner binding and ignores injected route props", async () => {
    const fixture = await setup(["succeeded"], { poisoned: true, injected: true });
    await screen.findByRole("alert");
    expect(fixture.lookups).toEqual(["lst_one"]);
    expect(screen.queryByRole("button", { name: t("marketplace.listingRecovery.retryUnknown") })).toBeNull();
    expect(fixture.sends).toEqual([]);
    expect(fixture.router.state.loaderData).toMatchObject({ "0": { listingRecovery: { phase: "ambiguous" } } });
  });

  it("constructs an opaque URL with no submitted prices or request body", async () => {
    const form = new FormData();
    form.set("idempotencyKey", "listing_recovery_price_00001");
    form.set("intent", "update-price");
    form.set("priceAmount", "1234.56");
    form.set("priceCurrencyCode", "USD");
    form.set("csv", "private inventory bytes");
    const reference = await listingRecoveryForForm(form, "lst_one", actor.accountId);
    const url = listingRecoveryUrl(`${path}?maxOpenOrders=17&awayWindowReasonCategory=travel`, reference!);
    expect(decodeURIComponent(url)).not.toMatch(/1234\.56|USD|private inventory|priceAmount|csv|blob:|storage/i);
    expect(url).not.toMatch(/maxOpenOrders|travel|awayWindow/);
    expect(reference?.targets[0]?.requestHash).toBe(
      hashMarketplaceRequest({ listingId: "lst_one", priceAmount: "1234.56", priceCurrencyCode: "USD" }),
    );
  });

  it("fails safely before send when the submitted attempt is missing", async () => {
    const fixture = await setup(["unknown"], { retained: false });
    const form = new FormData();
    form.set("intent", "bulk-pause-listings");
    form.set("listingIds", "lst_one");
    await act(async () => {
      await fixture.router.navigate(path, { formMethod: "post", formData: form });
    });
    expect(
      screen
        .getAllByRole("status")
        .some((status) => status.textContent === t("marketplace.listingRecovery.failedSafe")),
    ).toBe(true);
    expect(fixture.sends).toEqual([]);
    expect(fixture.lookups).toEqual([]);
  });

  it("discards an older preparation when another navigation wins the generation", async () => {
    const fixture = await setup(["unknown"], { retained: false });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("crypto", {
      randomUUID: () => webcrypto.randomUUID(),
      subtle: {
        digest: async (...args: Parameters<typeof webcrypto.subtle.digest>) => {
          await hold;
          return webcrypto.subtle.digest(...args);
        },
      },
    });
    fireEvent.click(screen.getAllByLabelText("Select row lst_one")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Pause selected" }));
    await act(async () => {
      await fixture.router.navigate(`${path}?search=newer`);
    });
    await act(async () => {
      release();
      await hold;
    });
    expect(fixture.router.state.location.search).toBe("?search=newer");
    expect(fixture.sends).toEqual([]);
    expect(fixture.lookups).toEqual([]);
  });

  it.each([false, true])(
    "recovers a single Listing's lost POST and reopens without resending, projected reads unavailable=%s",
    async (unavailableOnReload) => {
      const singlePath = `${path}/lst_one`;
      let committed = false;
      let failPageReads = false;
      let sends = 0;
      let prepared: ListingRecoveryIdentity | null = null;
      const lookups: string[] = [];
      let router: ReturnType<typeof createMemoryRouter>;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input), "http://localhost");
          if (url.pathname.endsWith("/api/auth/session")) return json({ actor });
          if (url.pathname.endsWith("/listings/batch/prepare")) {
            prepared = JSON.parse(String(init?.body));
            return json({ prepared: true });
          }
          if (url.pathname.includes("/listings/batch/"))
            return json({
              batchId: prepared!.batchId,
              family: prepared!.mutationKind,
              items: prepared!.targets.map((target) => ({
                targetId: target.id,
                requestHash: target.requestHash,
                outcome: "unknown",
                version: 0,
              })),
            });
          if (url.pathname.includes("mutation-attempts")) {
            const id = url.searchParams.get("target")!;
            lookups.push(id);
            const binding = marketplaceAttemptBinding({
              attemptId: decodeURIComponent(url.pathname.split("/").at(-1)!),
              accountId: actor.accountId,
              mutationKind: "listing.pause",
              target: { kind: "listing", id },
              request: null,
            });
            return json({
              ...binding,
              canonicalRequestHash: url.searchParams.get("requestHash"),
              ownerStatus: committed ? "committed" : "not-observed",
              ...(committed ? { ownerReceipt: { id, version: 2 } } : {}),
            });
          }
          if (init?.method === "POST") {
            expect(router.state.location.search).toContain("listingRecovery=");
            sends++;
            committed = true;
            throw new TypeError("response lost after commit");
          }
          if (failPageReads) throw new TypeError("projected reads unavailable");
          if (url.pathname.endsWith("/fee-history")) return json({ items: [], total: 0, count: 0 });
          return json({
            ...listing,
            fee_locks: [],
            selected_options: [],
            evidence_readiness: {
              ready: true,
              policy: { explanationCodes: [] },
              requirements: {
                minimumPhotoCount: 0,
                requiredSlots: [],
                sellerTrustRequirements: [],
                buyerAcknowledgment: "none",
              },
              coverage: { complete: true, unmetCodes: [], slots: [], activePhotoCount: 0, minimumPhotoCount: 0 },
              nextActions: [],
              publicGallery: [],
            },
          });
        }),
      );
      const routes = [
        {
          path: `${path}/:listingId`,
          loader: listingLoader,
          action: listingAction,
          shouldRevalidate: listingShouldRevalidate,
          Component: ListingRoute,
        },
      ];
      router = createMemoryRouter(routes, { initialEntries: [singlePath] });
      await act(async () => {
        render(
          <ChaseRoot>
            <RouterProvider router={router} />
          </ChaseRoot>,
        );
        await routerReady(router);
      });
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: "Pause listing" }));
      });
      await act(async () => {
        await routerReady(router);
      });
      await screen.findAllByText(t("marketplace.listingRecovery.succeeded"));
      expect(sends).toBe(1);
      expect(lookups).toEqual(["lst_one", "lst_one", "lst_one"]);
      const retained = `${singlePath}${router.state.location.search}`;
      cleanup();
      failPageReads = unavailableOnReload;
      router = createMemoryRouter(routes, { initialEntries: [retained] });
      await act(async () => {
        render(
          <ChaseRoot>
            <RouterProvider router={router} />
          </ChaseRoot>,
        );
        await routerReady(router);
      });
      await screen.findAllByText(t("marketplace.listingRecovery.succeeded"));
      expect(sends).toBe(1);
      expect(lookups).toHaveLength(4);
      if (unavailableOnReload) expect(screen.queryByRole("button")).toBeNull();
      else expect(screen.getByRole("button", { name: "Pause listing" }).matches(":disabled")).toBe(true);
    },
  );
});
