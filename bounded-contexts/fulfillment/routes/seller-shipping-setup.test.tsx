import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKOUT_ANONYMOUS_SELL_LIST_COOKIE_NAME } from "@chase-sets/auth-context";
import { createFulfillmentApiClient, FulfillmentApiError } from "../client";
import {
  actor,
  accountOwner,
  anonymousOwner,
  context,
  createShippingTestHarness,
  initialize,
  setup,
} from "../features/seller-checkout-readiness/api/test-support";
import manifest from "../context.json";
import ShippingSetupRoute, { action, loader } from "./seller-shipping-setup";

const path = "/sell/shipping-setup";
const cookie = `${CHECKOUT_ANONYMOUS_SELL_LIST_COOKIE_NAME}=${anonymousOwner.anonymousSellListId}`;
const formValues = { ...setup.origin, line2: "", labelPreference: setup.labelPreference };
let h: ReturnType<typeof createShippingTestHarness>;
let signedIn = true;
let browserCookie: string | null = cookie;
let failRead = false;
let failSave = false;
let writes: { path: string; headers: Headers; body: unknown }[];
let routers: ReturnType<typeof createMemoryRouter>[];

function request(
  method = "GET",
  fields: Record<string, string> = formValues,
  query = "",
  extraHeaders: HeadersInit = {},
) {
  const headers = new Headers(extraHeaders);
  if (browserCookie !== null) headers.set("Cookie", browserCookie);
  if (method !== "GET") {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
    headers.set("Origin", "https://marketplace.test");
  }
  return new Request(`https://marketplace.test${path}${query}`, {
    method,
    headers,
    ...(method === "GET" ? {} : { body: new URLSearchParams(fields) }),
  });
}
const load = (query = "", extraHeaders: HeadersInit = {}) =>
  loader({
    request: request("GET", formValues, query, extraHeaders),
    params: {},
    context: undefined,
    url: new URL(`https://marketplace.test${path}${query}`),
    pattern: path,
  });
const save = (fields: Record<string, string> = formValues, query = "", extraHeaders: HeadersInit = {}) =>
  action({
    request: request("POST", fields, query, extraHeaders),
    params: {},
    context: undefined,
    url: new URL(`https://marketplace.test${path}${query}`),
    pattern: path,
  });

async function settled(router: ReturnType<typeof createMemoryRouter>) {
  if (router.state.initialized && router.state.navigation.state === "idle" && router.state.revalidation === "idle")
    return;
  await new Promise<void>((resolve) => {
    const unsubscribe = router.subscribe((state) => {
      if (state.initialized && state.navigation.state === "idle" && state.revalidation === "idle") {
        unsubscribe();
        resolve();
      }
    });
  });
}
function withBrowserRequest<T extends LoaderFunctionArgs | ActionFunctionArgs>(args: T): T {
  const headers = new Headers(args.request.headers);
  if (browserCookie !== null) headers.set("Cookie", browserCookie);
  return { ...args, request: new Request(args.request, { headers }) };
}
async function routerForSetup() {
  const router = createMemoryRouter(
    [
      {
        id: "setup",
        path,
        Component: ShippingSetupRoute,
        loader: (args) => loader(withBrowserRequest(args)),
        action: (args) => action(withBrowserRequest(args)),
      },
    ],
    { initialEntries: [path] },
  );
  routers.push(router);
  await settled(router);
  return router;
}
const markup = (router: ReturnType<typeof createMemoryRouter>) => renderToString(<RouterProvider router={router} />);
async function submit(router: ReturnType<typeof createMemoryRouter>, fields: Record<string, string> = formValues) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  await router.navigate(path, { formMethod: "post", formData });
  await settled(router);
}

beforeEach(() => {
  h = createShippingTestHarness();
  signedIn = true;
  browserCookie = cookie;
  failRead = false;
  failSave = false;
  writes = [];
  routers = [];
  vi.stubEnv("CHASE_SETS_INTERNAL_API_ORIGIN", "https://api.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const incoming = new Request(input, init);
      const url = new URL(incoming.url);
      if (url.pathname === "/api/auth/session")
        return signedIn ? Response.json({ actor }) : new Response(null, { status: 401 });
      h.setActor(signedIn ? actor : null);
      if (incoming.method === "PUT") {
        writes.push({ path: url.pathname, headers: incoming.headers, body: await incoming.clone().json() });
        if (failSave) return Response.json({ error: { code: "source-unavailable" } }, { status: 503 });
      } else if (failRead) return Response.json({ error: { code: "source-unavailable" } }, { status: 503 });
      return h.app.fetch(incoming);
    }),
  );
});
afterEach(() => {
  for (const router of routers) router.dispose();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("registered seller shipping setup route", () => {
  it("registers the real Fulfillment page", () => {
    expect(
      manifest.deployableContributions.find((entry) => entry.deployable === "marketplace-web")?.routes,
    ).toContainEqual(
      expect.objectContaining({
        routeId: "seller-shipping-setup",
        routePath: "sell/shipping-setup",
        fileExport: "./routes/seller-shipping-setup",
      }),
    );
  });
  it.each(["account", "guest"] as const)(
    "loads/saves/reloads %s through the actual client/API, preserving source stamps",
    async (mode) => {
      signedIn = mode === "account";
      const router = await routerForSetup();
      expect(markup(router)).toContain("Add your current shipping origin");
      await submit(router);
      expect(markup(router)).toContain("awaiting platform shipping support");
      expect(markup(router)).toContain('value="Seller"');
      const beforeReload = router.state.loaderData.setup;
      const persisted = await h.services.readSetup(
        signedIn ? { kind: "account", accountId: actor.accountId } : anonymousOwner,
      );
      expect(persisted.setup?.origin).toEqual(setup.origin);
      expect(writes).toHaveLength(1);
      expect(writes[0]?.body).toEqual(setup);
      expect(writes[0]?.path).toBe(`/api/marketplace/${mode}/seller-shipping-setup`);
      expect(writes[0]?.headers.get("x-checkout-anonymous-sell-list-id")).toBe(
        signedIn ? null : anonymousOwner.anonymousSellListId,
      );
      expect(writes[0]?.headers.get("cookie")).toBe(cookie);
      expect(writes[0]?.headers.get("Chase-Sets-Read-Target-Context")).toBe("fulfillment");
      await router.revalidate();
      await settled(router);
      expect(router.state.loaderData.setup).toEqual(beforeReload);
      expect((await load()).data.result).toEqual(persisted);
      expect((await load()).init?.headers).toEqual({ "Cache-Control": "no-store" });
    },
  );
  it.each([
    null,
    "",
    `${CHECKOUT_ANONYMOUS_SELL_LIST_COOKIE_NAME}=anon_`,
    `${CHECKOUT_ANONYMOUS_SELL_LIST_COOKIE_NAME}=acc_anonymous_sell_list`,
    `${CHECKOUT_ANONYMOUS_SELL_LIST_COOKIE_NAME}=anon_%ZZ`,
    `${CHECKOUT_ANONYMOUS_SELL_LIST_COOKIE_NAME}=anon_with%20spaces`,
  ])("recovers missing/invalid existing identity (%s) without a write or cookie", async (value) => {
    signedIn = false;
    browserCookie = value;
    const loaded = await load("?owner=anon_foreign", { "x-checkout-anonymous-sell-list-id": "anon_foreign" });
    expect(loaded.data).toMatchObject({ missingIdentity: true, result: null });
    expect(loaded.init?.headers).not.toHaveProperty("Set-Cookie");
    await save();
    expect(writes).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    const router = await routerForSetup();
    expect(markup(router)).toContain('href="/account/sell-list"');
    expect(markup(router)).not.toContain("<form");
  });
  it("does not elevate fixed setup inputs with posted authority or nested unknown fields", async () => {
    signedIn = false;
    const before = (await load()).data;
    for (const field of [
      "owner",
      "accountId",
      "anonymousSellListId",
      "ready",
      "support",
      "supportStatus",
      "revision",
      "recordedAt",
      "origin.ready",
      "returnTo",
    ]) {
      expect((await save({ ...formValues, [field]: "forged" })).init?.status).toBe(400);
    }
    expect(writes).toHaveLength(0);
    expect((await load()).data).toEqual(before);
    await save(formValues, "?owner=anon_foreign&ready=true&support=enabled", {
      "x-checkout-anonymous-sell-list-id": "anon_foreign",
    });
    expect(writes[0]?.headers.get("x-checkout-anonymous-sell-list-id")).toBe(anonymousOwner.anonymousSellListId);
    expect((await load()).data.result?.supportStatus).toBe("missing");
    expect((await h.services.readSetup({ kind: "anonymous", anonymousSellListId: "anon_foreign" })).setup).toBeNull();
  });
  it("keeps account/anonymous facts independent during router revalidation and sign-in", async () => {
    signedIn = false;
    const router = await routerForSetup();
    await submit(router, { ...formValues, name: "Guest private address" });
    expect(markup(router)).toContain("Guest private address");
    signedIn = true;
    await router.revalidate();
    await settled(router);
    expect(markup(router)).not.toContain("Guest private address");
    expect(markup(router)).toContain("Add your current shipping origin");
    await submit(router, { ...formValues, name: "Account address" });
    expect(writes.at(-1)?.path).toBe("/api/marketplace/account/seller-shipping-setup");
    expect((await h.services.readSetup(anonymousOwner)).setup?.origin.name).toBe("Guest private address");
    expect((await h.services.readSetup(accountOwner)).setup).toBeNull();
  });
  it("uses returned platform support, including its revocation, rather than save success", async () => {
    const router = await routerForSetup();
    await submit(router);
    expect(markup(router)).toContain("awaiting platform shipping support");
    const owner = { kind: "account", accountId: actor.accountId } as const;
    await h.services.changeSupport(actor, { ...initialize, owner }, context);
    await router.revalidate();
    await settled(router);
    expect(markup(router)).toContain("saved with platform shipping support");
    await h.services.changeSupport(
      actor,
      {
        owner,
        action: "revoke",
        labelPreference: "prepaid-label",
        reason: "Test revocation",
        operationId: "revoke_test",
      },
      context,
    );
    await router.revalidate();
    await settled(router);
    expect(markup(router)).toContain("awaiting platform shipping support");
  });
  it("retains failed save input/error, retries and reports load failure without ready defaults", async () => {
    const router = await routerForSetup();
    failSave = true;
    await submit(router, { ...formValues, name: "Retain me" });
    expect(markup(router)).toContain('value="Retain me"');
    expect(markup(router)).toContain("could not be saved");
    expect(h.events).toHaveLength(0);
    failSave = false;
    await submit(router, { ...formValues, name: "Retain me" });
    expect(markup(router)).toContain("awaiting platform shipping support");
    failRead = true;
    await router.revalidate();
    await settled(router);
    expect(markup(router)).toContain("could not be loaded");
    expect(markup(router)).not.toContain("saved with platform shipping support");
    failRead = false;
    await router.revalidate();
    await settled(router);
    expect(markup(router)).toContain('value="Retain me"');
  });
  it("rejects duplicate choices and cross-origin actions before writes", async () => {
    const duplicate = new URLSearchParams(formValues);
    duplicate.append("name", "Other seller");
    await action({
      request: new Request(`https://marketplace.test${path}`, { method: "POST", headers: { cookie }, body: duplicate }),
      params: {},
      context: undefined,
      url: new URL(`https://marketplace.test${path}`),
      pattern: path,
    });
    const forged = request("POST");
    forged.headers.set("origin", "https://foreign.test");
    expect(
      (await action({ request: forged, params: {}, context: undefined, url: new URL(forged.url), pattern: path })).init
        ?.status,
    ).toBe(403);
    expect((await save(formValues, "", { "sec-fetch-site": "cross-site" })).init?.status).toBe(403);
    expect(writes).toHaveLength(0);
  });
  it("client uses real API errors, never a missing-source fallback", async () => {
    const api = createFulfillmentApiClient({ baseUrl: "https://api.test/api/marketplace" });
    failRead = true;
    await expect(api.getSellerShippingSetup("account")).rejects.toBeInstanceOf(FulfillmentApiError);
    await expect(api.getSellerShippingSetup("account")).rejects.toMatchObject({ status: 503 });
  });
});
