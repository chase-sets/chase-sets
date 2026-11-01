// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider, useRouteLoaderData, type ActionFunctionArgs } from "react-router";
import { ChaseRoot } from "@chase-sets/design-system";
import MatchListRoute, { loader as listLoader } from "../routes/account-offer-matches";
import MatchRoute, { action as matchAction, loader as matchLoader } from "../routes/account-offer-match";
import { OfferMatchDeclineAttemptProvider } from "../web";

const ATTEMPT_ID = /^[A-Za-z0-9_-]{22,128}$/;
const LIST_PATH = "/account/offers/matches";

type Actor = Readonly<{
  sessionId: string;
  tenantId: string;
  userId: string;
  accountId: string;
  membershipId: string;
  roleKey: string;
  permissions: readonly string[];
}>;

const seller: Actor = {
  sessionId: "ses_seller",
  tenantId: "tnt_test",
  userId: "usr_seller",
  accountId: "acc_seller",
  membershipId: "mem_seller",
  roleKey: "owner",
  permissions: ["offers.view", "offers.manage", "listings.view"],
};

function offerMatch(offerId: string, status = "submitted") {
  return {
    offer_id: offerId,
    buyer_account_id: "acc_buyer",
    catalog_catalog_item_id: "cat_one",
    product_id: "cat_one::",
    item_title: `Item ${offerId}`,
    item_subtitle: null,
    selected_options: [],
    product_summary: null,
    price_amount: "10.00",
    price_currency_code: "USD",
    last_stream_version: 1,
    quantity_requested: 1,
    status,
    accepted_seller_account_id: null,
    accepted_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    listing_id: `lst_${offerId}`,
    listing_price_amount: "10.00",
    listing_price_currency_code: "USD",
    listing_stream_version: 2,
    listing_quantity_cap: 1,
    listing_visible_quantity: 1,
    offer_price_gap_amount: "0.00",
    offer_to_listing_price_bps: 10000,
    buyer_display_name: "Buyer",
    seller_available_quantity: 1,
    seller_listing_availability_status: "available",
    can_fulfill: true,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

class InertEventSource {
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

type DeclineSent = Readonly<{ path: string; offerId: string; attemptId: string }>;

// Test-owned Marketplace and Auth API: the real routes' loaders and action call it through fetch.
function marketplaceApi() {
  const api = {
    actor: seller as Actor,
    items: [offerMatch("off_1"), offerMatch("off_2")],
    declines: [] as DeclineSent[],
    declineArrivals: [] as ReturnType<typeof deferred<DeclineSent>>[],
    respondToDecline: ((sent) => json({ offerId: sent.offerId, version: 2 })) as (
      sent: DeclineSent,
      index: number,
    ) => Promise<Response> | Response,
    declineArrived(index: number) {
      api.declineArrivals[index] ??= deferred<DeclineSent>();
      return api.declineArrivals[index]!.promise;
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost");
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (url.pathname.endsWith("/api/auth/session")) return json({ actor: api.actor });
      if (method === "POST" && url.pathname.endsWith("/decline")) {
        const sent = {
          path: url.pathname,
          offerId: url.pathname.split("/").at(-2)!,
          attemptId: String(JSON.parse(String(init?.body)).attemptId),
        };
        const index = api.declines.push(sent) - 1;
        api.declineArrivals[index] ??= deferred<DeclineSent>();
        api.declineArrivals[index]!.resolve(sent);
        return api.respondToDecline(sent, index);
      }
      if (url.pathname.endsWith("terms-preview")) return json(null);
      if (url.pathname.endsWith(LIST_PATH))
        return json({ items: api.items, total: api.items.length, count: api.items.length });
      const item = api.items.find((candidate) => candidate.offer_id === url.pathname.split("/").at(-1));
      return item ? json(item) : json({ error: { code: "not_found", message: "Offer match not found" } }, 404);
    }),
  );
  return api;
}

function SignedInLayout() {
  const rootData = useRouteLoaderData("root") as { actor: Actor | null };
  return (
    <OfferMatchDeclineAttemptProvider
      sessionId={rootData.actor?.sessionId ?? null}
      accountId={rootData.actor?.accountId ?? null}
    >
      <Outlet />
    </OfferMatchDeclineAttemptProvider>
  );
}

function mountOfferMatches(api: ReturnType<typeof marketplaceApi>) {
  const actionSignals: AbortSignal[] = [];
  const router = createMemoryRouter(
    [
      {
        id: "root",
        path: "/",
        loader: () => ({ actor: api.actor }),
        Component: SignedInLayout,
        children: [
          { path: "account/offers/matches", loader: listLoader, Component: MatchListRoute },
          {
            id: "offer-match",
            path: "account/offers/matches/:offerId",
            loader: matchLoader,
            action: (args: ActionFunctionArgs) => {
              actionSignals.push(args.request.signal);
              return matchAction(args);
            },
            Component: MatchRoute,
          },
        ],
      },
    ],
    { initialEntries: [LIST_PATH] },
  );
  const view = render(
    <ChaseRoot>
      <RouterProvider router={router} />
    </ChaseRoot>,
  );
  return { router, actionSignals, container: view.container };
}

type MountedRouter = ReturnType<typeof mountOfferMatches>["router"];

async function settleAt(router: MountedRouter, pathname: string) {
  const settled = (state: MountedRouter["state"]) =>
    state.initialized &&
    state.navigation.state === "idle" &&
    state.revalidation === "idle" &&
    state.location.pathname === pathname;
  await act(async () => {
    await new Promise<void>((resolve) => {
      if (settled(router.state)) return resolve();
      const unsubscribe = router.subscribe((state) => {
        if (!settled(state)) return;
        unsubscribe();
        resolve();
      });
    });
  });
  expect(router.state.location.pathname).toBe(pathname);
}

function listDeclineForm(container: HTMLElement, layout: "card" | "table", offerId: string) {
  const root = container.querySelector(layout === "card" ? '[role="list"]' : "table");
  const form = root?.querySelector<HTMLFormElement>(`form[action$="${LIST_PATH}/${offerId}"]`);
  expect(form, `${layout} decline form for ${offerId}`).toBeTruthy();
  return form!;
}

function attemptIdIn(form: HTMLFormElement) {
  const attemptId = String(new FormData(form).get("attemptId"));
  expect(attemptId).toMatch(ATTEMPT_ID);
  return attemptId;
}

function listAttemptId(container: HTMLElement, offerId: string) {
  const card = attemptIdIn(listDeclineForm(container, "card", offerId));
  expect(attemptIdIn(listDeclineForm(container, "table", offerId)), `card and table hold one id for ${offerId}`).toBe(
    card,
  );
  return card;
}

function detailDeclineForm(container: HTMLElement) {
  const forms = [...container.querySelectorAll<HTMLFormElement>("form")].filter((form) =>
    form.querySelector('input[name="attemptId"]'),
  );
  expect(forms, "one decline form on the detail route").toHaveLength(1);
  return forms[0]!;
}

function submit(form: HTMLFormElement) {
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  expect(button?.disabled, "decline is enabled").toBe(false);
  fireEvent.click(button!);
}

describe("Offer Match decline attempt identity through the real routes", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("EventSource", InertEventSource);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("reuses one id after list action abort and route retry", async () => {
    const api = marketplaceApi();
    const releaseFirstDecline = deferred();
    api.respondToDecline = async (sent, index) => {
      if (index === 0) await releaseFirstDecline.promise;
      return json({ offerId: sent.offerId, version: 2 });
    };
    const { router, actionSignals, container } = mountOfferMatches(api);
    await settleAt(router, LIST_PATH);
    const heldAttempt = listAttemptId(container, "off_1");
    const otherAttempt = listAttemptId(container, "off_2");
    expect(otherAttempt).not.toBe(heldAttempt);

    submit(listDeclineForm(container, "card", "off_1"));
    await act(async () => {
      await api.declineArrived(0);
    });

    await act(async () => {
      await router.navigate(`${LIST_PATH}/off_1`);
    });
    await settleAt(router, `${LIST_PATH}/off_1`);
    expect(actionSignals[0]?.aborted).toBe(true);
    expect(attemptIdIn(detailDeclineForm(container))).toBe(heldAttempt);

    await act(async () => {
      await router.navigate(-1);
    });
    await settleAt(router, LIST_PATH);
    expect(listAttemptId(container, "off_1")).toBe(heldAttempt);
    expect(listAttemptId(container, "off_2")).toBe(otherAttempt);

    submit(listDeclineForm(container, "table", "off_1"));
    await act(async () => {
      await api.declineArrived(1);
    });
    await settleAt(router, LIST_PATH);
    expect(api.declines.map(({ offerId, attemptId }) => ({ offerId, attemptId }))).toEqual([
      { offerId: "off_1", attemptId: heldAttempt },
      { offerId: "off_1", attemptId: heldAttempt },
    ]);

    releaseFirstDecline.resolve();
    await act(async () => {
      await releaseFirstDecline.promise;
    });
  });

  it("reuses one id after realtime keyed list remount", async () => {
    const api = marketplaceApi();
    const releaseFirstDecline = deferred();
    api.respondToDecline = async (sent, index) => {
      if (index === 0) await releaseFirstDecline.promise;
      return json({ offerId: sent.offerId, version: 2 });
    };
    const { router, actionSignals, container } = mountOfferMatches(api);
    await settleAt(router, LIST_PATH);
    const heldAttempt = listAttemptId(container, "off_1");
    const otherAttempt = listAttemptId(container, "off_2");
    const formBeforeRemount = listDeclineForm(container, "card", "off_1");

    submit(formBeforeRemount);
    await act(async () => {
      await api.declineArrived(0);
    });

    // A changed total and Offer list changes the realtime view's key, so the view remounts.
    api.items = [...api.items, offerMatch("off_3")];
    await act(async () => {
      await router.navigate(LIST_PATH);
    });
    await settleAt(router, LIST_PATH);
    expect(actionSignals[0]?.aborted).toBe(true);
    const formAfterRemount = listDeclineForm(container, "card", "off_1");
    expect(formAfterRemount.isConnected).toBe(true);
    expect(formBeforeRemount.isConnected, "the keyed realtime view remounted").toBe(false);
    expect(listAttemptId(container, "off_1")).toBe(heldAttempt);
    expect(listAttemptId(container, "off_2")).toBe(otherAttempt);
    expect(new Set([heldAttempt, otherAttempt, listAttemptId(container, "off_3")]).size).toBe(3);

    // The replaced view's unmount has run; re-rendering the remounted view (same key) must still find the held id.
    await act(async () => {
      await router.revalidate();
    });
    await settleAt(router, LIST_PATH);
    expect(formAfterRemount.isConnected, "an unchanged list re-renders without remounting").toBe(true);
    expect(listAttemptId(container, "off_1"), "the held id outlives the replaced view's unmount").toBe(heldAttempt);

    submit(formAfterRemount);
    await act(async () => {
      await api.declineArrived(1);
    });
    await settleAt(router, LIST_PATH);
    expect(api.declines.map(({ attemptId }) => attemptId)).toEqual([heldAttempt, heldAttempt]);

    releaseFirstDecline.resolve();
    await act(async () => {
      await releaseFirstDecline.promise;
    });
  });

  it("forwards the held id through the real decline action", async () => {
    const api = marketplaceApi();
    const { router, container } = mountOfferMatches(api);
    await settleAt(router, LIST_PATH);
    const heldAttempt = listAttemptId(container, "off_1");
    const otherAttempt = listAttemptId(container, "off_2");

    await act(async () => {
      await router.navigate(`${LIST_PATH}/off_1`);
    });
    await settleAt(router, `${LIST_PATH}/off_1`);
    api.items = [offerMatch("off_1", "declined"), offerMatch("off_2")];
    submit(detailDeclineForm(container));
    await act(async () => {
      await api.declineArrived(0);
    });
    await settleAt(router, LIST_PATH);

    expect(api.declines).toEqual([
      { path: "/api/marketplace/account/offers/matches/off_1/decline", offerId: "off_1", attemptId: heldAttempt },
    ]);
    for (const layout of ["card", "table"] as const) {
      const declined = listDeclineForm(container, layout, "off_1");
      expect(attemptIdIn(declined)).not.toBe(heldAttempt);
      expect(declined.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    }
    expect(listAttemptId(container, "off_2")).toBe(otherAttempt);
  });

  it("retains the id after a failed-safe decline and retries it from the detail route", async () => {
    const api = marketplaceApi();
    api.respondToDecline = (sent, index) =>
      index === 0
        ? json({ error: { code: "offer_not_declinable", message: "Offer is changing" } }, 422)
        : json({ offerId: sent.offerId, version: 2 });
    const { router, container } = mountOfferMatches(api);
    await settleAt(router, LIST_PATH);
    const heldAttempt = listAttemptId(container, "off_1");

    submit(listDeclineForm(container, "card", "off_1"));
    await act(async () => {
      await api.declineArrived(0);
    });
    await settleAt(router, `${LIST_PATH}/off_1`);
    expect(router.state.actionData).toMatchObject({ "offer-match": { recovery: "failed-safe" } });
    expect(attemptIdIn(detailDeclineForm(container))).toBe(heldAttempt);

    submit(detailDeclineForm(container));
    await act(async () => {
      await api.declineArrived(1);
    });
    await settleAt(router, LIST_PATH);
    expect(api.declines.map(({ attemptId }) => attemptId)).toEqual([heldAttempt, heldAttempt]);
  });

  it("gives an account switch, a switch back and a new same-account session a new id", async () => {
    const api = marketplaceApi();
    const { router, container } = mountOfferMatches(api);
    await settleAt(router, LIST_PATH);
    const sellerAttempt = listAttemptId(container, "off_1");
    const actorAs = async (actor: Actor) => {
      api.actor = actor;
      await act(async () => {
        await router.revalidate();
      });
      await settleAt(router, LIST_PATH);
      return listAttemptId(container, "off_1");
    };

    expect(await actorAs({ ...seller }), "an unchanged session and account keep their id").toBe(sellerAttempt);

    const switchedAttempt = await actorAs({ ...seller, accountId: "acc_other" });
    expect(switchedAttempt).not.toBe(sellerAttempt);

    const switchedBackAttempt = await actorAs(seller);
    expect(switchedBackAttempt, "switching back clears the earlier account's id").not.toBe(sellerAttempt);
    expect(switchedBackAttempt).not.toBe(switchedAttempt);

    const nextSessionAttempt = await actorAs({ ...seller, sessionId: "ses_next" });
    expect(new Set([sellerAttempt, switchedAttempt, switchedBackAttempt, nextSessionAttempt]).size).toBe(4);
  });
});
