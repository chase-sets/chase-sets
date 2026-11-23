import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapContextDatabase,
  composeModuleSchemaSql,
  createSubscriptionRunner,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createId } from "@chase-sets/primitives/typed-ids";
import { buildMarketplaceApi } from "../../../api";
import { module } from "../../../index";
import { createMarketplaceServices } from "../../../support/runtime-support/services";
import { hashMarketplaceRequest } from "../../mutation-recovery/api/attempt";
import { OFFER_PAYMENT_CONSENT_POLICY_KEY } from "../../offer-payment-consent/domain/consent-text";
import { createOfferPaymentAuthorization } from "../api/runtime";
import {
  authorizationEvent,
  authorizationResultSchema,
  authorizationStream,
  type AuthorizationRequest,
} from "../domain/contracts";
import {
  buyerPaymentInstrumentMirrored,
  buyerPaymentInstrumentProjectionName,
} from "../integrations/payments/instrument-projection";
import { authorizationProjectionName } from "../read-model/projection";
import {
  activatePolicy,
  balance,
  card,
  identity,
  instrument,
  nextPublication,
  now,
  path,
  post,
  publication,
  publications,
  withActor,
} from "./fixtures";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for Offer Payment Authorization tests.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const buyer = (tenantId = createId("tnt")): EventStoreContext => ({
  tenantId,
  audit: { forAccountId: createId("acc"), performedByUserId: createId("usr") },
});

describeDb("Offer Payment Authorization with PostgreSQL workers and streams", () => {
  let pools: Readonly<Record<"marketplace" | "payments", PgTransactionalPool>>;
  let store: ReturnType<typeof createPostgresEventStore>;
  let paymentsStore: ReturnType<typeof createPostgresEventStore>;
  let services: ReturnType<typeof createMarketplaceServices>;
  let policies: ReturnType<typeof createPolicyRuntime>;
  let account: EventStoreContext;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["marketplace", "payments"], "offer_auth_8919");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(module, pools.marketplace);
    await pools.payments.query(composeModuleSchemaSql({ schemaSql: "" }));
    store = createPostgresEventStore({ pool: pools.marketplace });
    paymentsStore = createPostgresEventStore({ pool: pools.payments });
    services = createMarketplaceServices(pools.marketplace, { deploymentEnvironment: "test" });
    policies = createPolicyRuntime({ eventStore: store, db: pools.marketplace, now: () => now });
    account = buyer();
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  function app(forBuyer = account, authorization = services.offerPaymentAuthorization) {
    const mounted = withActor(forBuyer);
    mounted.route(
      "/",
      buildMarketplaceApi(
        { ...services, offerPaymentAuthorization: authorization, policies },
        { publications, now: () => now },
      ),
    );
    return mounted;
  }

  function worker(projectionName: string, dependencies = services) {
    const registration = module.buildSubscriptions!(dependencies).find(
      (entry) => entry.projectionName === projectionName,
    )!;
    const runner = createSubscriptionRunner(
      "marketplace",
      pools.marketplace,
      pools[registration.sourceContextName as keyof typeof pools],
      registration,
    );
    return async () => {
      const result = await runner.runOnce();
      expect(result).toMatchObject({ blockedStreams: 0, poisonEvents: 0 });
    };
  }
  const mirror = () => worker(buyerPaymentInstrumentProjectionName)();
  const reconcile = () => worker("marketplace.offer-payment-authorization-reconcile")();
  const project = () => worker(authorizationProjectionName)();
  const events = (forBuyer = account) =>
    store.readStream({ streamId: authorizationStream(forBuyer.audit.forAccountId) });
  const version = async (forBuyer = account) => (await events(forBuyer)).at(-1)?.streamVersion ?? 0;
  const handoffs = () =>
    store.readStream({ streamId: `marketplace.buyer-payment-instrument-mirror-${account.audit.forAccountId}` });

  async function publish(savedCheckoutInstruments: readonly ReturnType<typeof instrument>[]) {
    await paymentsStore.appendToStream({
      streamId: `payments.checkout-affordances-${account.audit.forAccountId}`,
      expectedVersion: "any",
      context: account,
      events: [
        {
          eventType: "payments.checkout-affordances-published",
          payload: {
            accountId: account.audit.forAccountId,
            savedCheckoutInstruments,
            publishedAt: now.toISOString(),
          },
        },
      ],
    });
  }

  async function issue(command: AuthorizationRequest, mounted = app()) {
    const response = await mounted.request(`${path}/commands`, post(command));
    expect(response.status, await response.clone().text()).toBe(200);
    return authorizationResultSchema.parse(await response.json());
  }
  async function prepare(source = card as typeof card | typeof balance, forBuyer = account) {
    const preview = await issue({ ...identity(await version(forBuyer)), type: "preview", source }, app(forBuyer));
    return {
      ...identity(preview.version),
      type: "authorize" as const,
      previewId: preview.preview!.previewId,
      consent: true,
    };
  }
  async function authorize(source = card as typeof card | typeof balance, forBuyer = account) {
    return issue(await prepare(source, forBuyer), app(forBuyer));
  }
  async function expectUnavailable() {
    await reconcile();
    await project();
    const own = await app().request(path);
    expect(await own.json()).toMatchObject({ state: "payment-method-unavailable", eligibleInstruments: [] });
    expect((await events()).filter((event) => event.eventType === authorizationEvent.unavailable)).toHaveLength(1);
  }
  async function ready() {
    await activatePolicy(app(), policies, publication, account);
    await publish([instrument()]);
    await mirror();
    await reconcile();
  }

  it("does not lose removal seen before the mirror commits, with an already-active authorization", async () => {
    await ready();
    await authorize();
    await reconcile();
    const active = await events();
    await publish([]);
    const intercepted = worker(buyerPaymentInstrumentProjectionName, {
      ...services,
      async recordBuyerInstrumentHandoff(db, event) {
        await services.recordBuyerInstrumentHandoff(db, event);
        // A competing worker checks while both the removal and its handoff are still uncommitted.
        expect(await handoffs()).toHaveLength(1);
        await reconcile();
        expect(await events()).toEqual(active);
      },
    });
    await intercepted();
    expect((await handoffs()).map((event) => event.eventType)).toEqual([
      buyerPaymentInstrumentMirrored,
      buyerPaymentInstrumentMirrored,
    ]);
    await expectUnavailable();
    await publish([]);
    await mirror();
    await expectUnavailable();
  });

  it.each(["authorize", "resume"] as const)(
    "reconciles %s when removal commits after validation but before append",
    async (type) => {
      await ready();
      const command = type === "authorize" ? await prepare() : await heldResume();
      let interleaved = false;
      const racedStore: EventStore = {
        ...store,
        async appendToStreams(inputs) {
          interleaved = true;
          await publish([]);
          await mirror();
          await reconcile();
          expect((await events()).some((event) => event.eventType === authorizationEvent.unavailable)).toBe(false);
          return store.appendToStreams!(inputs);
        },
      };
      const runtime = createOfferPaymentAuthorization({ eventStore: racedStore, db: pools.marketplace });
      expect((await issue(command, app(account, runtime))).state).toBe("active");
      expect(interleaved).toBe(true);
      await expectUnavailable();
    },
  );

  it.each(["authorize", "resume"] as const)(
    "reconciles %s when removal commits after append and its first reconcile",
    async (type) => {
      await ready();
      const command = type === "authorize" ? await prepare() : await heldResume();
      expect((await issue(command)).state).toBe("active");
      await reconcile();
      expect((await events()).some((event) => event.eventType === authorizationEvent.unavailable)).toBe(false);
      await publish([]);
      await mirror();
      await expectUnavailable();
    },
  );

  async function heldResume() {
    const authorized = await authorize(balance);
    await services.offerPaymentAuthorization.holdForFailedPayment("ord_hold", authorized.generation, account);
    return { ...identity(await version()), type: "resume" as const, source: card };
  }

  it.each([false, true])(
    "holds only the current generation and an unrecorded order (unavailable: %s)",
    async (unavailable) => {
      await ready();
      const runtime = services.offerPaymentAuthorization;
      const authorized = await authorize();
      if (unavailable) await runtime.markPaymentMethodUnavailable(authorized.generation, card.instrumentId, account);
      const before = await events();
      await runtime.holdForFailedPayment("ord_stale", 0, account);
      expect(await events()).toEqual(before);
      await runtime.holdForFailedPayment("ord_hold", 1, account);
      const held = await events();
      expect(held.at(-1)?.payload).toMatchObject({ state: "held", available: false });
      await runtime.holdForFailedPayment("ord_hold", 1, account);
      await runtime.holdForFailedPayment("ord_other", 1, account);
      expect(await events()).toEqual(held);
      const resumed = await issue({ ...identity(await version()), type: "resume", source: balance });
      const resumedHistory = await events();
      await runtime.holdForFailedPayment("ord_hold", resumed.generation, account);
      await runtime.holdForFailedPayment("ord_other", 1, account);
      await runtime.markPaymentMethodUnavailable(1, card.instrumentId, account);
      await runtime.markPaymentMethodUnavailable(resumed.generation, card.instrumentId, account);
      expect(await events()).toEqual(resumedHistory);
      await issue({ ...identity(await version()), type: "revoke" });
      const revoked = await events();
      await runtime.holdForFailedPayment("ord_new", resumed.generation, account);
      expect(await events()).toEqual(revoked);
    },
  );

  it("rejects a stale Resume when a concurrent Hold wins the buyer version", async () => {
    await ready();
    const authorization = await authorize();
    const runtime = services.offerPaymentAuthorization;
    await runtime.markPaymentMethodUnavailable(authorization.generation, card.instrumentId, account);
    const resume = { ...identity(await version()), type: "resume" as const, source: balance };
    const racedStore: EventStore = {
      ...store,
      async appendToStreams(inputs) {
        await runtime.holdForFailedPayment("ord_won", authorization.generation, account);
        return store.appendToStreams!(inputs);
      },
    };
    const response = await app(
      account,
      createOfferPaymentAuthorization({ eventStore: racedStore, db: pools.marketplace }),
    ).request(`${path}/commands`, post(resume));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "stale_preview" } });
    expect((await events()).at(-1)?.payload).toMatchObject({ state: "held" });
    expect((await issue({ ...resume, ...identity(await version()) })).generation).toBe(2);
  });

  it("discards a Hold that read the old generation when Resume wins the buyer version", async () => {
    await ready();
    const authorization = await authorize();
    await services.offerPaymentAuthorization.markPaymentMethodUnavailable(
      authorization.generation,
      card.instrumentId,
      account,
    );
    const resume = { ...identity(await version()), type: "resume" as const, source: balance };
    let interleaved = false;
    const racedStore: EventStore = {
      ...store,
      async appendToStream(input) {
        interleaved = true;
        await issue(resume);
        return store.appendToStream(input);
      },
    };
    await createOfferPaymentAuthorization({ eventStore: racedStore, db: pools.marketplace }).holdForFailedPayment(
      "ord_lost",
      authorization.generation,
      account,
    );
    expect(interleaved).toBe(true);
    const history = await events();
    expect(history.at(-1)?.payload).toMatchObject({ state: "active" });
    expect(history.some((event) => event.eventType === authorizationEvent.held)).toBe(false);
  });

  it("requires activation rather than a revision and rejects an A Authorize overtaken by B without writing an event or receipt", async () => {
    const initial = await app().request(path);
    expect(await initial.json()).toMatchObject({ state: "none", source: null, policyActivation: { version: null } });
    await activatePolicy(app(), policies, publication, account, false);
    const premature = await app().request(
      `${path}/commands`,
      post({ ...identity(0), type: "authorize", consent: true, previewId: "a".repeat(64) }),
    );
    expect(premature.status).toBe(409);
    expect(await premature.json()).toEqual({ error: { code: "offer_payment_consent_not_approved" } });
    expect(await events()).toEqual([]);
    await activatePolicy(app(), policies, publication, account);
    const other = buyer(account.tenantId);
    const existing = await authorize(balance, other);
    const untouched = await events(other);
    const command = await prepare(balance);
    const stream = await events();
    const racedStore: EventStore = {
      ...store,
      async appendToStreams(inputs) {
        expect(inputs).toContainEqual(
          expect.objectContaining({
            streamId: policies.consentActivation.streamIdFor(OFFER_PAYMENT_CONSENT_POLICY_KEY),
            expectedVersion: 2,
            events: [],
          }),
        );
        await activatePolicy(app(), policies, nextPublication, account);
        return store.appendToStreams!(inputs);
      },
    };
    const response = await app(
      account,
      createOfferPaymentAuthorization({ eventStore: racedStore, db: pools.marketplace }),
    ).request(`${path}/commands`, post(command));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "stale_preview" } });
    expect(await events()).toEqual(stream);
    expect(await events(other)).toEqual(untouched);
    expect(await policies.consentActivation.read(OFFER_PAYMENT_CONSENT_POLICY_KEY)).toMatchObject({
      activeVersion: nextPublication.version,
    });
    const { attemptId, ...request } = command;
    const lookup = await app().request(
      `/mutation-attempts/${attemptId}?${new URLSearchParams({
        kind: "offer-payment-authorization.command",
        target: account.audit.forAccountId,
        requestHash: hashMarketplaceRequest(request),
      })}`,
    );
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({ ownerStatus: "not-observed" });
    await project();
    expect(await (await app(other).request(path)).json()).toMatchObject({
      state: "active",
      consentVersion: existing.consentVersion,
    });
    expect(await (await app().request(path)).json()).toMatchObject({ state: "none", source: null });
    expect(await paymentsStore.readAll()).toEqual([]);
  });
});
