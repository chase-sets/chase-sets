import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import {
  bootstrapContextDatabase,
  drainContextRuntime,
  loadProjectionGroupGeneration,
  rebuildProjectionGroup,
  resetProjectionGroup,
  syncProjectionGroup,
  type ContextProjectionGroup,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createAccountUserTestActor,
  createMountedContextTestRuntime,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  createTestApp,
  createTestEventStoreContext,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { readApiErrorCode } from "@chase-sets/http/responses";
import { module as orderingModule } from "@chase-sets/ordering";
import { createOrderingRequestApiClient } from "@chase-sets/ordering/server";
import { createId } from "@chase-sets/primitives/typed-ids";
import { isCanonicalMoneyAmount } from "@chase-sets/primitives/money";
import type { JsonObject } from "@chase-sets/primitives/json";
import { module as checkoutModule } from "../../../index";
import type { CheckoutApiEnv } from "../../../api";
import { createCheckoutRequestApiClient } from "../../../support/request-support/api-client";
import type { CheckoutServices } from "../../../support/runtime-support/services";
import { action, loader } from "../../../routes/checkout-session";
import { evolveCheckoutSession, initialCheckoutSessionState, type CheckoutSessionEvent } from "../domain/domain";
import { getCheckoutSession } from "./queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const sourceNames = ["catalog", "marketplace", "inventory"] as const;
const contextNames = ["checkout", "ordering", ...sourceNames] as const;
const origin = "https://checkout-preview-probe.test";
const actor = createAccountUserTestActor({
  accountId: createId("acc"),
  permissions: ["orders.view", "orders.manage"],
});
const context = createTestEventStoreContext(actor);
const catalogItemId = createId("cat");
const listingId = createId("lst");
const unresolvedListingId = createId("lst");
const inventoryItemId = createId("inv");
const sellerAccountId = createId("acc");
const productId = `${catalogItemId}::`;
const shippingAddress = {
  name: "Synthetic buyer",
  line1: "123 Test Street",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
};
const candidates = [
  "idle",
  "reload",
  "optimization-goal",
  "shipping-option",
  "shipping-address",
  "authenticity-opt-in",
  "refresh",
  "projection-rebuild",
] as const;
type Candidate = (typeof candidates)[number];
type Loaded = Awaited<ReturnType<typeof loader>>;
type Observation = Readonly<{
  case: string;
  step: string;
  sessionId: string;
  status: "reached" | "blocked";
  events: readonly string[];
  aggregatePreview: boolean;
  aggregateRevision: string | null;
  projectionRow: boolean;
  projectionPreview: boolean;
  projectionRevision: string | null;
  loaderPreview: boolean;
  totalAmount: string | null;
  unavailableReasons: readonly string[];
  priced: boolean;
  previewError: boolean;
  generation: string | null;
  refresh?: Readonly<{ redirect: boolean; location: string | null; previewRecorded: boolean; priced: boolean }>;
  elapsedMs?: number;
}>;

// Only the read-side dependencies used by this probe are mounted. The production
// services, API routers, projection definitions and handlers remain unchanged.
const checkoutProjectionNames = new Set([
  "checkout.cart-projection",
  "checkout.session-projection",
  "checkout-catalog-item-projection",
  "checkout-marketplace-listing-options-projection",
  "checkout-inventory-supply-projection",
]);
const orderingProjectionNames = new Set([
  "ordering-marketplace-supply-input-projection",
  "ordering-inventory-supply-input-projection",
]);
const probeCheckoutModule = {
  ...checkoutModule,
  eventSubscriptions: checkoutModule.eventSubscriptions!.filter((entry) =>
    checkoutProjectionNames.has(entry.projectionName),
  ),
  projectionGroups: checkoutModule.projectionGroups!.filter((group) =>
    checkoutProjectionNames.has(group.projectionName),
  ),
  projectionHandlerSets: (services: CheckoutServices) =>
    checkoutModule.projectionHandlerSets!(services).filter((set) => checkoutProjectionNames.has(set.projectionName)),
  buildSubscriptions: (services: CheckoutServices) =>
    checkoutModule.buildSubscriptions!(services).filter((entry) => checkoutProjectionNames.has(entry.projectionName)),
};
const probeOrderingModule = {
  ...orderingModule,
  eventSubscriptions: orderingModule.eventSubscriptions!.filter((entry) =>
    orderingProjectionNames.has(entry.projectionName),
  ),
  projectionGroups: orderingModule.projectionGroups!.filter((group) =>
    orderingProjectionNames.has(group.projectionName),
  ),
  eventReactions: [],
  projectionHandlerSets: () => [],
  buildSubscriptions: (services: Parameters<NonNullable<typeof orderingModule.buildSubscriptions>>[0]) =>
    orderingModule.buildSubscriptions!(services).filter((entry) => orderingProjectionNames.has(entry.projectionName)),
};
const sourceModules = sourceNames.map((contextName) =>
  defineBoundedContextModule({
    manifest: { contextName, apiBasePath: `/${contextName}`, streamPrefix: `${contextName}.` },
    schemaSql: "",
    createServices: () => ({}),
    buildApis: () => [],
  }),
);

let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;
let runtime: ReturnType<typeof createMountedContextTestRuntime>;
let services: CheckoutServices;
let sessionGroup: ContextProjectionGroup;
let records: Observation[] = [];
let requests: Array<
  Readonly<{
    path: string;
    status: number;
    code: string | null;
    revisionInput?: "absent" | "calculated";
    calculatedPreview?: Readonly<{ revision: string | null; priced: boolean }>;
  }>
> = [];
let caseName = "setup";
let activeSessionId = "not-started";
let activeStep = "setup";

function checkoutPool() {
  if (!pools) throw new Error("Probe databases are not initialized.");
  return pools.checkout;
}

function request(sessionId = activeSessionId) {
  return new Request(`${origin}/checkout/buy/session/${sessionId}`);
}

function priced(data: Loaded) {
  const amount = data.paymentPreview?.amount;
  return (
    data.fulfillmentPreview !== null &&
    typeof amount === "string" &&
    isCanonicalMoneyAmount(amount) &&
    Number(amount) > 0 &&
    data.paymentPreview?.can_start_payment === true
  );
}

async function load(sessionId = activeSessionId) {
  const routeRequest = request(sessionId);
  return loader({
    request: routeRequest,
    params: { sessionId },
    context: {},
    url: new URL(routeRequest.url),
    pattern: "/checkout/buy/session/:sessionId",
  });
}

async function observe(step: string, options: Pick<Observation, "refresh" | "elapsedMs"> = {}) {
  activeStep = step;
  const events = await readCompleteStream(createPostgresEventStore({ pool: checkoutPool() }), {
    streamId: `checkout.session-${activeSessionId}`,
  });
  const aggregate = events.reduce(
    (state, event) =>
      evolveCheckoutSession(state, {
        type: event.eventType,
        data: event.payload,
      } as CheckoutSessionEvent),
    initialCheckoutSessionState,
  );
  const row = await getCheckoutSession(checkoutPool(), activeSessionId, actor.accountId);
  const data = await load();
  const generation = await loadProjectionGroupGeneration(checkoutPool(), {
    targetContextName: "checkout",
    projectionName: "checkout.session-projection",
  });
  const record: Observation = {
    case: caseName,
    step,
    sessionId: activeSessionId,
    status: "reached",
    events: events.map((event) => event.eventType),
    aggregatePreview: aggregate.fulfillmentPreviewSnapshot !== null,
    aggregateRevision: aggregate.fulfillmentPreviewRevision,
    projectionRow: row !== null,
    projectionPreview: row?.fulfillment_preview_snapshot != null,
    projectionRevision: row?.fulfillment_preview_revision ?? null,
    loaderPreview: data.fulfillmentPreview !== null,
    totalAmount: data.fulfillmentPreview?.totals.totalAmount ?? null,
    unavailableReasons: data.fulfillmentPreview?.unavailableLines.map((line) => line.reason) ?? [],
    priced: priced(data),
    previewError: data.previewError !== null,
    generation: generation?.state ?? null,
    ...options,
  };
  records.push(record);
  return record;
}

function requirePricedBaseline(record: Observation) {
  expect(record.aggregatePreview, "Baseline aggregate must contain a preview").toBe(true);
  expect(record.aggregateRevision, "Baseline must have a revision").toBeTruthy();
  expect(record.projectionRow, "Baseline must have a projected row").toBe(true);
  expect(record.projectionPreview, "Baseline projection must contain a preview").toBe(true);
  expect(record.projectionRevision).toBe(record.aggregateRevision);
  expect(record.priced, "Baseline real loader must expose priced payment totals").toBe(true);
  expect(record.previewError).toBe(false);
}

function recovered(baseline: Observation, result: Observation) {
  return (
    baseline.aggregatePreview &&
    baseline.priced &&
    Boolean(baseline.aggregateRevision) &&
    result.aggregatePreview &&
    result.projectionRow &&
    result.projectionPreview &&
    result.priced &&
    result.refresh?.previewRecorded === true
  );
}

function recordedCalculatedRevision(
  invalidated: Observation,
  result: Observation,
  calculatedRevision: string | null | undefined,
  error: unknown,
) {
  return (
    error === undefined &&
    !invalidated.aggregatePreview &&
    Boolean(calculatedRevision) &&
    result.events.length === invalidated.events.length + 1 &&
    result.events.at(-1) === "checkout.session.fulfillment-preview-recorded" &&
    result.aggregateRevision === calculatedRevision &&
    result.projectionRevision === calculatedRevision &&
    result.priced
  );
}

function fullNegative(results: ReadonlyMap<Candidate, boolean>) {
  return candidates.every((candidate) => results.get(candidate) === true);
}

async function appendSource(
  contextName: (typeof sourceNames)[number],
  streamId: string,
  events: readonly Readonly<{ eventType: string; payload: JsonObject }>[],
) {
  if (!pools) throw new Error("Probe databases are not initialized.");
  await createPostgresEventStore({ pool: pools[contextName] }).appendToStream({
    streamId,
    expectedVersion: "no_stream",
    context,
    events,
  });
}

async function seedSourceHistory() {
  await appendSource("catalog", `catalog.item-${catalogItemId}`, [
    {
      eventType: "catalog.catalog-item.created",
      payload: { itemId: catalogItemId, title: "Synthetic card", subtitle: null },
    },
    { eventType: "catalog.catalog-item.published", payload: {} },
  ]);
  await appendSource("inventory", `inventory.item-${inventoryItemId}`, [
    {
      eventType: "inventory.item.created",
      payload: {
        itemId: inventoryItemId,
        accountId: sellerAccountId,
        catalogItemId,
        productId,
        selectedOptions: [],
        storageLocationId: createId("loc"),
        totalQuantity: 5,
      },
    },
  ]);
  await appendSource("marketplace", `marketplace.listing-${listingId}`, [
    {
      eventType: "marketplace.listing.created",
      payload: {
        listingId,
        accountId: sellerAccountId,
        inventoryItemId,
        catalogItemId,
        productId,
        itemTitle: "Synthetic card",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        storageLocationName: "Synthetic shelf",
        shipFromCode: "CHI",
        shipFromAddress: shippingAddress,
        priceAmount: "20.00",
        priceCurrencyCode: "USD",
        quantityCap: 5,
        marketplaceSalesFeeUnitAmount: "1.00",
        sellerNetUnitAmount: "19.00",
        termsScheduleId: null,
        termsAgreementId: null,
        termsResolvedAt: "2026-10-05T00:00:00.000Z",
        productMeasureSnapshot: {
          catalogItemId,
          productId,
          selectedOptions: [],
          measureVersion: "synthetic-raw-card-v1",
          unitLengthInches: 3.5,
          unitWidthInches: 2.5,
          unitHeightInches: 0.02,
          unitWeightOunces: 0.08,
          physicalFlags: ["raw-card"],
          stackBehavior: "stackable-thickness",
          source: "profile",
          confidence: "measured",
        },
      },
    },
    { eventType: "marketplace.listing.published", payload: {} },
  ]);
  const listingEvents = await readCompleteStream(createPostgresEventStore({ pool: pools!.marketplace }), {
    streamId: `marketplace.listing-${listingId}`,
  });
  await appendSource("marketplace", `marketplace.listing-${unresolvedListingId}`, [
    {
      eventType: "marketplace.listing.created",
      payload: { ...listingEvents[0]!.payload, listingId: unresolvedListingId, termsResolvedAt: null },
    },
    { eventType: "marketplace.listing.published", payload: {} },
  ]);
  await drainContextRuntime(runtime);
}

async function baseline() {
  activeStep = "cart-to-priced-payment-step";
  await services.cart.addLine(
    {
      accountId: actor.accountId as never,
      catalogItemId,
      productId,
      itemTitle: "Synthetic card",
      itemSubtitle: null,
      itemImageUrl: null,
      selectedOptions: [],
      productSummary: null,
      quantity: 1,
      fulfillmentMode: "locked-listing",
      lockedListingId: listingId,
    },
    context,
  );
  await drainContextRuntime(runtime);
  const readiness = await services.cart.createReadinessSnapshot({ accountId: actor.accountId });
  expect(readiness.status, "Real cart readiness must admit the source fixture").toBe("ready");
  const started = await createCheckoutRequestApiClient(request()).createCheckoutSession({
    source: {
      type: "cart",
      readinessSnapshotId: readiness.snapshotId,
      readinessSourceRevision: readiness.sourceRevision,
    },
    shippingOption: "standard",
  });
  activeSessionId = started.session_id;
  await drainContextRuntime(runtime);
  const record = await observe("priced-baseline");
  requirePricedBaseline(record);
  return record;
}

async function submitReviewAction(step: string, fields: Readonly<Record<string, string>>) {
  activeStep = `real-${step}-action`;
  const before = (await observe(`before-${step}`)).events.length;
  const form = new FormData();
  for (const [key, value] of Object.entries({
    shippingName: shippingAddress.name,
    shippingLine1: shippingAddress.line1,
    shippingCity: shippingAddress.city,
    shippingState: shippingAddress.state,
    shippingPostalCode: shippingAddress.postalCode,
    shippingCountry: shippingAddress.country,
    shippingOption: "standard",
    authenticityCheckOptIn: "false",
    ...fields,
  }))
    form.set(key, value);
  const response = await action({
    request: new Request(request().url, { method: "POST", body: form }),
    params: { sessionId: activeSessionId },
    context: {},
  });
  await drainContextRuntime(runtime);
  const data = await load();
  const events = await readCompleteStream(createPostgresEventStore({ pool: checkoutPool() }), {
    streamId: `checkout.session-${activeSessionId}`,
  });
  return observe(`after-${step}`, {
    refresh: {
      redirect: response instanceof Response && response.status === 302,
      location: response instanceof Response ? response.headers.get("Location") : null,
      previewRecorded: events
        .slice(before)
        .some((event) => event.eventType === "checkout.session.fulfillment-preview-recorded"),
      priced: priced(data),
    },
  });
}

function refresh() {
  return submitReviewAction("refresh", { intent: "refresh-checkout-preview" });
}

describeDb("checkout preview lifecycle", () => {
  beforeAll(async () => {
    if (!databaseBaseUrl) throw new Error("TEST_DATABASE_URL is required for lifecycle execution.");
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl, contextNames, "checkout_preview_lifecycle");
    await ensureMultiContextTestDatabases(databaseBaseUrl, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async (test) => {
    records = [];
    requests = [];
    activeSessionId = "not-started";
    activeStep = "setup";
    caseName = test.task.name;
    if (!pools) throw new Error("Probe databases are not initialized.");
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(checkoutModule, pools.checkout);
    await bootstrapContextDatabase(orderingModule, pools.ordering);
    for (const module of sourceModules) {
      await bootstrapContextDatabase(module, pools[module.contextName as (typeof sourceNames)[number]]);
    }
    runtime = createMountedContextTestRuntime([
      ...sourceModules.map((module) => ({
        contextName: module.contextName,
        mountRole: "source-only" as const,
        module,
        pool: pools![module.contextName as (typeof sourceNames)[number]],
        ports: {},
      })),
      {
        contextName: "ordering",
        module: probeOrderingModule,
        pool: pools.ordering,
        ports: { inventoryCleanupAuthority: { kind: "not-mounted" as const } },
      },
      { contextName: "checkout", module: probeCheckoutModule, pool: pools.checkout, ports: {} },
    ]);
    services = runtime.services.checkout as CheckoutServices;
    sessionGroup = runtime.projectionGroups.find((group) => group.projectionName === "checkout.session-projection")!;
    const orderingServices = runtime.services.ordering as Parameters<typeof orderingModule.buildApis>[0];
    const app = createTestApp<CheckoutApiEnv>({
      actor,
      context,
      routes: (app) => {
        app.get("/api/auth/session", (c) => c.json({ actor }));
        for (const api of checkoutModule.buildApis(services)) app.route(api.mountPath, api.router as Hono);
        for (const api of orderingModule.buildApis(orderingServices)) app.route(api.mountPath, api.router as Hono);
      },
    });
    vi.stubEnv("CHASE_SETS_INTERNAL_API_ORIGIN", origin);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const forwarded = new Request(input, init);
      const url = new URL(forwarded.url);
      if (url.origin !== origin) throw new Error("Probe cannot call an external surface.");
      const body =
        forwarded.method === "POST"
          ? await forwarded
              .clone()
              .json()
              .catch(() => null)
          : null;
      const response = await app.fetch(forwarded);
      const result = await response
        .clone()
        .json()
        .catch(() => null);
      requests.push({
        path: url.pathname,
        status: response.status,
        code: readApiErrorCode(result),
        ...(url.pathname.endsWith("/purchases/checkout/preview")
          ? {
              calculatedPreview: {
                revision: typeof result?.revision === "string" ? result.revision : null,
                priced: Number(result?.totals?.totalAmount) > 0,
              },
            }
          : {}),
        ...(url.pathname.endsWith("/fulfillment-preview")
          ? {
              revisionInput: body?.fulfillmentPreviewRevision ? ("calculated" as const) : ("absent" as const),
            }
          : {}),
      });
      return response;
    });
    await seedSourceHistory();
  });

  afterEach((test) => {
    if (test.task.result?.state === "fail") {
      console.info(
        "CHECKOUT_PREVIEW_BLOCKED " + JSON.stringify({ case: caseName, sessionId: activeSessionId, step: activeStep }),
      );
    }
    for (const record of records) console.info("CHECKOUT_PREVIEW_STEP " + JSON.stringify(record));
    console.info("CHECKOUT_PREVIEW_REQUESTS " + JSON.stringify({ case: caseName, requests }));
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it("discriminates unresolved source terms from the priced source fixture through real Ordering", async () => {
    activeStep = "source-terms-fixture-control";
    const api = createOrderingRequestApiClient(request());
    const checkoutSessionId = createId("chk");
    const cartLineId = createId("cli");
    const preview = (lockedListingId: string) =>
      api.previewCheckoutFulfillment({
        checkoutSessionId,
        sourceType: "cart-checkout",
        shippingOption: "standard",
        lines: [
          {
            listingId: lockedListingId,
            lockedListingId,
            fulfillmentMode: "locked-listing",
            cartLineId,
            catalogItemId,
            productId,
            itemTitle: "Synthetic card",
            itemSubtitle: null,
            selectedOptions: [],
            productSummary: null,
            quantity: 1,
          },
        ],
      });
    const unresolved = await preview(unresolvedListingId);
    const resolved = await preview(listingId);
    console.info(
      "CHECKOUT_PREVIEW_FIXTURE_CONTROL " +
        JSON.stringify({
          case: caseName,
          syntheticSourceHistory: true,
          unresolved: {
            totalAmount: unresolved.totals.totalAmount,
            readyLines: unresolved.readyLineKeys.length,
            unavailableReasons: unresolved.unavailableLines.map((line) => line.reason),
          },
          resolved: {
            totalAmount: resolved.totals.totalAmount,
            readyLines: resolved.readyLineKeys.length,
            unavailableReasons: resolved.unavailableLines.map((line) => line.reason),
          },
        }),
    );
    expect(unresolved.readyLineKeys).toEqual([]);
    expect(unresolved.totals.totalAmount).toBe("0.00");
    expect(unresolved.unavailableLines.map((line) => line.reason)).toEqual(["Locked listing is unavailable."]);
    expect(resolved.readyLineKeys).toHaveLength(1);
    expect(resolved.unavailableLines).toEqual([]);
    expect(Number(resolved.totals.totalAmount)).toBeGreaterThan(0);
  });

  it.each(candidates)("independent priced baseline: %s", async (candidate) => {
    const initial = await baseline();
    const api = createCheckoutRequestApiClient(request());
    if (candidate === "idle" || candidate === "reload") {
      const started = performance.now();
      if (candidate === "idle") await new Promise((resolve) => setTimeout(resolve, 100));
      else await load();
      const result = await observe(candidate, { elapsedMs: Math.round(performance.now() - started) });
      expect(result.events).toEqual(initial.events);
      expect(result.aggregateRevision).toBe(initial.aggregateRevision);
      expect(result.projectionRevision).toBe(initial.projectionRevision);
      requirePricedBaseline(result);
      return;
    }
    if (candidate === "projection-rebuild") {
      await resetProjectionGroup(sessionGroup);
      const pending = await observe("rebuild-reset-pending-replay");
      expect(pending.projectionRow).toBe(false);
      expect(pending.aggregatePreview).toBe(true);
      expect(pending.generation).toBe("rebuilding");
      await syncProjectionGroup(sessionGroup);
      const completed = await observe("rebuild-completed");
      expect(completed.events).toEqual(initial.events);
      expect(completed.generation).toBe("active");
      requirePricedBaseline(completed);
      await rebuildProjectionGroup(sessionGroup);
      requirePricedBaseline(await observe("rebuild-steady-state"));
      return;
    }
    const expectedEvent = {
      "optimization-goal": "checkout.session.optimization-goal-selected",
      "shipping-option": "checkout.session.shipping-option-selected",
      "shipping-address": "checkout.session.shipping-address-set",
      "authenticity-opt-in": "checkout.session.authenticity-check-opt-in-selected",
      refresh: "checkout.session.shipping-option-selected",
    }[candidate];
    if (candidate === "optimization-goal")
      await api.selectOptimizationGoal(activeSessionId, { optimizationGoal: "fewest-shipments" });
    if (candidate === "shipping-option")
      await api.selectShippingOption(activeSessionId, { shippingOption: "priority" });
    if (candidate === "shipping-address") await api.selectShippingAddress(activeSessionId, { shippingAddress });
    if (candidate === "authenticity-opt-in") {
      const offer = (await load()).fulfillmentPreview?.authenticityCheckOffer;
      if (!offer?.eligible) {
        console.info(
          "CHECKOUT_PREVIEW_CANDIDATE_BLOCKED " +
            JSON.stringify({
              case: caseName,
              candidate: "authenticity-opt-in-selected=true",
              status: "blocked",
              prerequisite: "eligible authenticity-check offer in the calculated preview",
              owner: "authenticity",
              reachedControl: "real authenticity selection with selected=false",
            }),
        );
      }
      await api.selectAuthenticityCheckOptIn(activeSessionId, {
        selected: offer?.eligible === true,
        quoteFingerprint: offer?.eligible ? offer.quote_fingerprint : null,
      });
    }
    if (candidate !== "refresh") {
      await drainContextRuntime(runtime);
      const invalidated = await observe("selection-invalidated-preview");
      expect(invalidated.events.slice(initial.events.length)).toEqual([expectedEvent]);
      expect(invalidated.aggregatePreview).toBe(false);
      expect(invalidated.aggregateRevision).toBeNull();
      expect(invalidated.projectionPreview).toBe(false);
      expect(invalidated.projectionRevision).toBeNull();
      expect(invalidated.priced).toBe(false);
    }
    const result = await refresh();
    expect(result.events[initial.events.length]).toBe(expectedEvent);
    expect(result.refresh?.redirect).toBe(true);
    expect(
      recovered(initial, result),
      "Real refresh must record a preview and restore priced loader totals; redirect alone is not recovery",
    ).toBe(true);
  });

  it("discriminates omitted revision from the real calculated revision without supplying a snapshot", async () => {
    const initial = await baseline();
    const refreshed = await refresh();
    const session = (await load()).session;
    const reviewInput = { shippingOption: session.shipping_option, shippingAddress: session.shipping_address };
    const orderingPreview = await createOrderingRequestApiClient(request()).previewCheckoutFulfillment({
      checkoutSessionId: activeSessionId,
      sourceType: "cart-checkout",
      ...reviewInput,
      optimizationGoal: session.optimization_goal,
      lines: session.lines,
    });
    expect(orderingPreview.revision).toBeTruthy();
    expect(Number(orderingPreview.totals.totalAmount)).toBeGreaterThan(0);
    const api = createCheckoutRequestApiClient(request());
    await api.recordFulfillmentPreview(activeSessionId, {
      ...reviewInput,
      fulfillmentPreviewRevision: orderingPreview.revision,
    });
    await drainContextRuntime(runtime);
    const supplied = await observe("control-explicit-calculated-revision");
    requirePricedBaseline(supplied);
    expect(supplied.events.at(-1)).toBe("checkout.session.fulfillment-preview-recorded");
    expect(supplied.aggregateRevision).toBe(orderingPreview.revision);
    await api.selectShippingOption(activeSessionId, { shippingOption: session.shipping_option });
    await drainContextRuntime(runtime);
    const invalidated = await observe("control-reset-before-omitted-revision");
    expect(invalidated.aggregatePreview).toBe(false);
    activeStep = "control-omitted-revision";
    const requestsBeforeOmitted = requests.length;
    let omittedError: unknown;
    try {
      await api.recordFulfillmentPreview(activeSessionId, reviewInput);
    } catch (error) {
      omittedError = error;
    }
    await drainContextRuntime(runtime);
    const omitted = await observe("control-omitted-revision");
    const omittedCalculatedRevision = requests
      .slice(requestsBeforeOmitted)
      .filter((entry) => entry.path.endsWith("/purchases/checkout/preview"))
      .at(-1)?.calculatedPreview?.revision;
    const omittedRecorded = recordedCalculatedRevision(invalidated, omitted, omittedCalculatedRevision, omittedError);
    console.info(
      "CHECKOUT_PREVIEW_DISCRIMINATOR " +
        JSON.stringify({
          case: caseName,
          omittedRejected: omittedError !== undefined,
          omittedRecordedCalculatedRevision: omittedRecorded,
          calculatedPreviewPriced: Number(orderingPreview.totals.totalAmount) > 0,
          explicitCalculatedRevisionRecorded: supplied.aggregateRevision === orderingPreview.revision,
          refreshRecovered: recovered(initial, refreshed),
        }),
    );
    expect(omittedError, "Omitted-revision review input must not be rejected").toBeUndefined();
    expect(
      omittedRecorded,
      "Omitted revision must append one preview event carrying the freshly calculated Ordering revision",
    ).toBe(true);
    requirePricedBaseline(omitted);
    expect(
      recovered(initial, refreshed),
      "Real refresh must record a preview and restore priced loader totals; redirect alone is not recovery",
    ).toBe(true);
  });

  it.each<Readonly<{ trigger: string; fields: Readonly<Record<string, string>>; quote: string | null }>>([
    { trigger: "missing-fee-quote", fields: {}, quote: "required" },
    {
      trigger: "visible-review-change",
      fields: { marketplaceCheckoutFeeQuoteFingerprint: "synthetic-fee-quote", reviewedShippingOption: "priority" },
      quote: null,
    },
  ])("real confirm-checkout review refresh restores priced preview: $trigger", async ({ fields, quote }) => {
    const initial = await baseline();
    const result = await submitReviewAction("confirm-review-refresh", { intent: "confirm-checkout", ...fields });
    const appended = result.events.slice(initial.events.length);
    const location = new URL(result.refresh?.location ?? "/", origin);
    expect(result.refresh?.redirect).toBe(true);
    expect(location.searchParams.get("review")).toBe("updated");
    expect(location.searchParams.get("quote")).toBe(quote);
    expect(
      requests.some((entry) => entry.path.endsWith("/confirm")),
      "Review refresh must return before confirmation or payment",
    ).toBe(false);
    expect(appended[0], "Review selection must invalidate the preview before recording").toBe(
      "checkout.session.shipping-option-selected",
    );
    expect(appended.at(-1)).toBe("checkout.session.fulfillment-preview-recorded");
    expect(
      recovered(initial, result),
      "Confirm review refresh must record a preview and restore priced loader totals; redirect alone is not recovery",
    ).toBe(true);
  });

  it("rejects null-baseline, omitted-refresh and missing-candidate negative evidence", async () => {
    const initial = await baseline();
    await createCheckoutRequestApiClient(request()).selectShippingOption(activeSessionId, {
      shippingOption: "priority",
    });
    await drainContextRuntime(runtime);
    const noRefresh = await observe("control-omitted-refresh");
    expect(recovered(initial, noRefresh)).toBe(false);
    const nullBaseline = { ...initial, aggregatePreview: false, aggregateRevision: null, priced: false };
    const syntheticRecovered = {
      ...initial,
      refresh: { redirect: true, location: null, previewRecorded: true, priced: true },
    };
    expect(recovered(nullBaseline, syntheticRecovered)).toBe(false);
    expect(recovered(initial, { ...syntheticRecovered, projectionRow: false })).toBe(false);
    const syntheticRevision = "synthetic-calculated-revision";
    const syntheticRecorded = {
      ...initial,
      events: [...noRefresh.events, "checkout.session.fulfillment-preview-recorded"],
      aggregateRevision: syntheticRevision,
      projectionRevision: syntheticRevision,
    };
    expect(recordedCalculatedRevision(noRefresh, syntheticRecorded, syntheticRevision, undefined)).toBe(true);
    expect(
      recordedCalculatedRevision(noRefresh, noRefresh, syntheticRevision, new Error("synthetic omitted rejection")),
    ).toBe(false);
    expect(
      recordedCalculatedRevision(
        noRefresh,
        syntheticRecorded,
        syntheticRevision,
        new Error("synthetic omitted rejection"),
      ),
    ).toBe(false);
    expect(recordedCalculatedRevision(noRefresh, syntheticRecorded, "synthetic-other-revision", undefined)).toBe(false);
    expect(recordedCalculatedRevision(initial, syntheticRecorded, syntheticRevision, undefined)).toBe(false);
    const all = new Map<Candidate, boolean>(candidates.map((candidate) => [candidate, true]));
    expect(fullNegative(all)).toBe(true);
    for (const candidate of candidates) {
      const missing = new Map(all);
      missing.delete(candidate);
      expect(fullNegative(missing)).toBe(false);
    }
    console.info(
      "CHECKOUT_PREVIEW_NEGATIVE_CONTROLS " +
        JSON.stringify({
          case: caseName,
          syntheticClassifierInputs: true,
          nullBaselineRejected: true,
          omittedRefreshRejected: true,
          missingProjectionRowRejected: true,
          omittedRevisionRejectionRejected: true,
          everyMissingCandidateRejected: true,
        }),
    );
  });
});
