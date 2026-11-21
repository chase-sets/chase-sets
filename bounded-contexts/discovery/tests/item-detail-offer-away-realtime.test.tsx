// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import type { RealtimeProjectionPatchChange } from "@chase-sets/platform-runtime/realtime";
import DiscoveryItemDetailRoute, { clientLoader } from "../routes/item-detail";
import {
  baseAccountOfferMatch,
  baseOffer,
  createItem,
  PAGE_VIEW_ENTRY_KEY,
} from "./item-detail-commerce-panel-test-harness";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function view(count: 0 | 1, quote: string | null) {
  return { count, canFulfill: quote !== null, quote };
}

const away = view(0, null);
const publicOnly = { ...view(1, null), quote: "" };
const initialMatch = view(1, "quote_initial");
const newerMatch = view(1, "quote_newer");
const cappedMatch = view(0, "quote_newer");
const resumedMatch = view(1, "quote_resumed");

type Scenario = {
  name: string;
  phase: "before A" | "during A" | "during B" | "after B";
  event: "remove" | "upsert";
  initial: ReturnType<typeof view>;
  immediate: ReturnType<typeof view>;
  whileBPending: ReturnType<typeof view>;
  publishedA?: ReturnType<typeof view>;
  snapshotB: ReturnType<typeof view>;
  afterB: ReturnType<typeof view>;
  guest?: boolean;
  unchangedBook?: boolean;
  changedListingIds?: boolean;
  resume?: boolean;
};

const scenarios: Scenario[] = [
  {
    name: "removal before A does not hide B's fresh Match even with an unchanged book",
    phase: "before A",
    event: "remove",
    initial: initialMatch,
    immediate: away,
    whileBPending: away,
    snapshotB: newerMatch,
    afterB: newerMatch,
    unchangedBook: true,
  },
  {
    name: "upsert before A is not replayed onto either snapshot",
    phase: "before A",
    event: "upsert",
    initial: away,
    immediate: publicOnly,
    whileBPending: publicOnly,
    snapshotB: away,
    afterB: away,
  },
  {
    name: "removal during A does not filter B's capped-book private Match",
    phase: "during A",
    event: "remove",
    initial: initialMatch,
    immediate: away,
    whileBPending: away,
    snapshotB: cappedMatch,
    afterB: cappedMatch,
  },
  {
    name: "F12: upsert during A starts B, which omits the Offer",
    phase: "during A",
    event: "upsert",
    initial: initialMatch,
    immediate: initialMatch,
    whileBPending: initialMatch,
    snapshotB: away,
    afterB: away,
  },
  {
    name: "F13: removal during B overrides A published before B but rendered during B",
    phase: "during B",
    event: "remove",
    initial: initialMatch,
    immediate: away,
    whileBPending: away,
    publishedA: view(1, "quote_published_a"),
    snapshotB: newerMatch,
    afterB: away,
  },
  {
    name: "F10: removal during B overrides its stale resume snapshot",
    phase: "during B",
    event: "remove",
    initial: initialMatch,
    immediate: away,
    whileBPending: away,
    snapshotB: newerMatch,
    afterB: away,
    resume: true,
  },
  {
    name: "F10: removal during B survives changed Listing IDs",
    phase: "during B",
    event: "remove",
    initial: initialMatch,
    immediate: away,
    whileBPending: away,
    snapshotB: newerMatch,
    afterB: away,
    changedListingIds: true,
    resume: true,
  },
  {
    name: "guest upsert during B replays on B without a seller Match",
    phase: "during B",
    event: "upsert",
    initial: away,
    immediate: publicOnly,
    whileBPending: publicOnly,
    snapshotB: away,
    afterB: publicOnly,
    guest: true,
  },
  {
    name: "removal after B applies immediately without a reload",
    phase: "after B",
    event: "remove",
    initial: initialMatch,
    immediate: away,
    whileBPending: initialMatch,
    snapshotB: newerMatch,
    afterB: newerMatch,
  },
  {
    name: "upsert after B reloads fresh seller terms",
    phase: "after B",
    event: "upsert",
    initial: initialMatch,
    immediate: publicOnly,
    whileBPending: initialMatch,
    snapshotB: away,
    afterB: away,
    resume: true,
  },
];

function deferred<T>() {
  let resolve!: (response: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

it.each(scenarios)("$name", async (scenario) => {
  vi.stubGlobal("scrollTo", vi.fn());
  const sources: EventTarget[] = [];
  vi.stubGlobal(
    "EventSource",
    class extends EventTarget {
      constructor() {
        super();
        sources.push(this);
      }

      close() {}
    },
  );

  const item = createItem();
  const resumedOffer = { ...baseOffer, price_amount: "42.00" };
  const viewerAccountId = scenario.guest ? null : "seller_1";
  function routeData(snapshot: ReturnType<typeof view>, newer = false) {
    const changedBook = newer && !scenario.unchangedBook;
    const offer = changedBook ? resumedOffer : baseOffer;
    return {
      entryAttemptKey: PAGE_VIEW_ENTRY_KEY,
      item: createItem({
        offer_demand_matches: snapshot.count ? [offer] : [],
        ...(changedBook ? { updated_at: "2026-11-20T00:00:00.000Z" } : {}),
        ...(newer && scenario.changedListingIds ? { market_listings: [] } : {}),
      }),
      similarItems: [],
      accountOfferMatches: snapshot.quote
        ? [
            {
              ...baseAccountOfferMatch,
              ...offer,
              acceptance_terms: {
                account_type: "personal" as const,
                basis_amount: offer.price_amount,
                marketplace_sales_fee_unit_amount: "0.00",
                seller_net_unit_amount: offer.price_amount,
                shipping_allowance_percentage_bps: 500,
                schedule_id: null,
                agreement_id: null,
                resolved_at: offer.updated_at,
                fee_quote_fingerprint: snapshot.quote,
              },
            },
          ]
        : [],
      sellerInventoryItems: [],
      sellerAccountId: viewerAccountId,
      hasListingStockLocation: true,
      listingSetupLoadState: "ready" as const,
      listingSetupLoadError: null,
      viewerAccountId,
      initialMarketIntent: "sell" as const,
      initialSelectedListingId: null,
      initialSelectedOfferId: baseOffer.offer_id,
      initialSelectedOptions: [],
      hasInitialSelectedOptionFilters: false,
      showSellerTab: true,
      canUseSellerFeatures: !scenario.guest,
      canUseListingFeatures: !scenario.guest,
      canUseGuestListingDraft: false,
      canSubmitOffers: !scenario.guest,
      registerToSellHref: "/register",
      productAlertClaimError: null,
      productAlertCreated: false,
      savedListClaim: { preparation: null, error: null },
      notFound: false,
      error: null,
      canonicalUrl: null,
    };
  }

  const loadA = deferred<ReturnType<typeof routeData>>();
  const loadB = deferred<ReturnType<typeof routeData>>();
  const loadResume = deferred<ReturnType<typeof routeData>>();
  const bStarted = deferred<void>();
  const signals: AbortSignal[] = [];
  const loader = vi
    .fn()
    .mockResolvedValueOnce(routeData(scenario.initial))
    .mockReturnValueOnce(loadA.promise)
    .mockImplementationOnce(() => {
      bStarted.resolve();
      return loadB.promise;
    })
    .mockReturnValueOnce(loadResume.promise);
  const router = createMemoryRouter(
    [
      {
        id: "item",
        path: "/items/:id",
        loader: (args) => {
          signals.push(args.request.signal);
          return clientLoader({ ...args, serverLoader: loader });
        },
        Component: DiscoveryItemDetailRoute,
        HydrateFallback: () => null,
      },
    ],
    { initialEntries: [`/items/${item.catalog_item_id}`] },
  );
  render(<RouterProvider router={router} />);
  await screen.findByRole("complementary", { name: "Commerce options" });
  await waitFor(() => expect(sources).toHaveLength(1));

  function expectView(expected: ReturnType<typeof view>, checkpoint: string) {
    const rail = within(screen.getByRole("complementary", { name: "Commerce options" }));
    const accept = rail.queryByRole("button", { name: "Accept offer" });
    const form = accept?.closest("form");
    expect(
      {
        count: Number(screen.getByText(/^[01] matching offers?$/).textContent?.[0]),
        canFulfill: rail.queryByText("Can fulfill") !== null,
        quote: form ? new FormData(form).get("feeQuoteFingerprint") : null,
      },
      checkpoint,
    ).toEqual(expected);
    expect(Boolean(form), checkpoint).toBe(expected.quote !== null);
  }

  function dispatchPatch(op: Scenario["event"]) {
    const change: RealtimeProjectionPatchChange =
      op === "upsert"
        ? { entity: "discovery.buyerOffer", op, id: baseOffer.offer_id, value: resumedOffer }
        : { entity: "discovery.buyerOffer", op, id: baseOffer.offer_id };
    sources[0]!.dispatchEvent(
      new MessageEvent("projection.patch", {
        data: JSON.stringify({
          kind: "projection.patch",
          context: "discovery",
          projection: "discovery-market-projection",
          topics: [`item:${item.catalog_item_id}`],
          changes: [change],
        }),
      }),
    );
  }

  function send(op: Scenario["event"]) {
    act(() => dispatchPatch(op));
  }

  function revalidate() {
    act(() => {
      void router.revalidate();
    });
  }

  function sendAt(phase: Scenario["phase"]) {
    if (scenario.phase !== phase) return false;
    send(scenario.event);
    expectView(scenario.immediate, phase);
    return scenario.event === "upsert" && !scenario.guest;
  }

  expectView(scenario.initial, "initial snapshot");
  const removesDuringB = scenario.phase === "during B" && scenario.event === "remove" && !scenario.publishedA;
  if (removesDuringB) {
    send("remove");
    expectView(away, "first removal");
  }
  let aPublished: Promise<void> | undefined;
  if (scenario.publishedA) {
    act(() => {
      aPublished = router.revalidate();
    });
  } else if (!sendAt("before A")) {
    revalidate();
  }
  await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));

  if (scenario.publishedA) {
    const snapshotA = routeData(scenario.publishedA, true);
    await act(async () => {
      loadA.resolve(snapshotA);
      await aPublished;
      expect(router.state.loaderData.item).toEqual(snapshotA);
      expectView(scenario.initial, "A published but React has not rendered it");
      void router.revalidate();
      await bStarted.promise;
      expect(signals[1]!.aborted).toBe(false);
      dispatchPatch(scenario.event);
    });
  } else {
    if (removesDuringB) {
      send("upsert");
    } else if (!sendAt("during A")) {
      revalidate();
    }
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(3));
    expect(signals[1]!.aborted).toBe(true);
    sendAt("during B");
  }

  expect(router.state.revalidation).toBe("loading");
  expectView(scenario.whileBPending, "B pending");
  await act(async () => loadB.resolve(routeData(scenario.snapshotB, true)));
  expect(router.state.revalidation).toBe("idle");
  expectView(scenario.afterB, "B committed");

  if (!scenario.publishedA) {
    await act(async () => loadA.resolve(routeData(scenario.initial)));
    expectView(scenario.afterB, "superseded A returned");
  }

  const resumeRevalidation = scenario.resume ? vi.spyOn(router, "revalidate") : null;
  sendAt("after B");
  if (resumeRevalidation) {
    if (scenario.phase !== "after B") send("upsert");
    expect(resumeRevalidation).toHaveBeenCalledTimes(1);
    await act(async () => {
      loadResume.resolve(routeData(resumedMatch, true));
      await resumeRevalidation.mock.results[0]!.value;
    });
    resumeRevalidation.mockRestore();
    expectView(resumedMatch, "fresh resume snapshot");
  }
  expect(loader).toHaveBeenCalledTimes(scenario.resume ? 4 : 3);
});
