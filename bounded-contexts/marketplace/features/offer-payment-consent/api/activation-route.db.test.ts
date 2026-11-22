import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { ResolvedActor } from "@chase-sets/auth-context";
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
import { createPolicyRuntime, type PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { DeploymentEnvironment } from "@chase-sets/platform-runtime/config-schema";
import { createId } from "@chase-sets/primitives/typed-ids";
import { buildMarketplaceApi, type MarketplaceApiEnv } from "../../../api";
import { module as marketplaceModule } from "../../../index";
import { createMarketplaceServices } from "../../../support/runtime-support/services";
import {
  OFFER_AUTOMATIC_CHARGE_V1,
  OFFER_PAYMENT_CONSENT_POLICY_KEY,
  offerPaymentConsentPublications,
  type OfferPaymentConsentPublications,
} from "../domain/consent-text";
import { marketplaceOfferPaymentConsentPolicy } from "../domain/policy";
import { resolveOfferPaymentEnforcement } from "./enforcement";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for Offer consent activation tests.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const path = "/api/marketplace/policies/offer-payment-consent";
const now = new Date("2026-11-21T16:00:00.000Z");
const context: EventStoreContext = {
  tenantId: createId("tnt"),
  audit: { performedByUserId: createId("usr"), forAccountId: createId("acc") },
};
const operator: ResolvedActor = {
  sessionId: "synthetic-offer-consent-session",
  membershipId: "synthetic-offer-consent-membership",
  tenantId: context.tenantId,
  userId: context.audit.performedByUserId,
  accountId: context.audit.forAccountId,
  roleKey: "platform-admin",
  permissions: ["platform-policy.manage"],
  authenticatedAt: now.toISOString(),
};
const v1 = offerPaymentConsentPublications[OFFER_AUTOMATIC_CHARGE_V1]!;
const v2 = { ...v1, version: "offer-automatic-charge-v2", contentFingerprint: `sha256:${"2".repeat(64)}` };
const v3 = { ...v1, version: "offer-automatic-charge-v3", contentFingerprint: `sha256:${"3".repeat(64)}` };
const syntheticPublications = { ...offerPaymentConsentPublications, [v2.version]: v2, [v3.version]: v3 };

describeDb("Offer payment consent activation through Marketplace HTTP and PostgreSQL", () => {
  let pools: Readonly<Record<"marketplace", PgTransactionalPool>>;
  let store: EventStore;
  let policies: PolicyRuntime;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["marketplace"], "offer_consent_11740");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.marketplace.query(marketplaceModule.schemaSql);
    store = createPostgresEventStore({ pool: pools.marketplace });
    policies = runtime(store);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  function runtime(eventStore: EventStore) {
    return createPolicyRuntime({ eventStore, db: pools.marketplace, now: () => now });
  }

  function app(
    options: {
      deploymentEnvironment?: DeploymentEnvironment;
      actor?: ResolvedActor | null;
      requestContext?: EventStoreContext;
      publications?: OfferPaymentConsentPublications;
      policies?: PolicyRuntime;
    } = { deploymentEnvironment: "test" },
  ) {
    const mounted = new Hono<MarketplaceApiEnv>();
    mounted.use("*", async (c, next) => {
      c.set("actor", options.actor === undefined ? operator : options.actor);
      c.set("context", options.requestContext ?? context);
      await next();
    });
    const services = createMarketplaceServices(pools.marketplace, {
      deploymentEnvironment: options.deploymentEnvironment,
    });
    mounted.route(
      "/api/marketplace",
      buildMarketplaceApi(
        { ...services, policies: options.policies ?? services.policies },
        { publications: options.publications, now: () => now },
      ),
    );
    return mounted;
  }

  async function createDocument(approvedConsentVersion: string | null, day = 21) {
    const { documentId } = await policies.createPolicyDocument(
      marketplaceOfferPaymentConsentPolicy,
      {
        value: { approvedConsentVersion },
        status: "active",
        effectiveFrom: `2026-11-${day}T00:00:00.000Z`,
        effectiveUntil: `2026-11-${day + 1}T00:00:00.000Z`,
        actorUserId: operator.userId,
      },
      context,
    );
    return documentId;
  }

  const input = (documentId: string, publication = v1) => ({
    documentId,
    version: publication.version,
    contentFingerprint: publication.contentFingerprint,
  });
  const post = (mounted: Hono<MarketplaceApiEnv>, body: unknown, action = "activate") =>
    mounted.request(`${path}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const authorityStream = () => policies.consentActivation.streamIdFor(OFFER_PAYMENT_CONSENT_POLICY_KEY);
  const authority = () => policies.consentActivation.read(OFFER_PAYMENT_CONSENT_POLICY_KEY);
  const authorityEvents = () => store.readStream({ streamId: authorityStream() });
  const documentEvents = (id: string) => store.readStream({ streamId: `platform-policy.document-${id}` });

  async function expectRefusal(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: { code } });
  }

  async function expectActivation(response: Response, activeVersion: string, authorityVersion: number) {
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ activeVersion, authorityVersion, isActive: true });
  }

  it("activates matching pending consent in test, then refuses an exact repeat without moving authority", async () => {
    const documentId = await createDocument(v1.version);
    const request = input(documentId);
    expect((await resolveOfferPaymentEnforcement(policies.consentActivation)).version).toBeNull();
    await expectActivation(await post(app(), request), v1.version, 2);
    expect(await resolveOfferPaymentEnforcement(policies.consentActivation)).toEqual({
      version: v1.version,
      snapshot: await authority(),
    });
    const events = await authorityEvents();
    await expectRefusal(await post(app(), request), 409, "version_not_newer");
    expect(await authorityEvents()).toEqual(events);
    expect(await documentEvents(documentId)).toHaveLength(1);
  });

  it("refuses null and undeclared document values, an undeclared request and mismatched copy before writing", async () => {
    const noVersion = await createDocument(null, 20);
    const undeclaredVersion = "offer-automatic-charge-v99";
    const undeclared = await createDocument(undeclaredVersion, 21);
    const matching = await createDocument(v1.version, 22);
    const mounted = app();
    await expectRefusal(await post(mounted, input(noVersion)), 409, "document_invalid");
    await expectRefusal(await post(mounted, input(undeclared)), 409, "document_invalid");
    await expectRefusal(
      await post(mounted, { ...input(undeclared), version: undeclaredVersion }),
      409,
      "publication_version_mismatch",
    );
    await expectRefusal(
      await post(mounted, { ...input(matching), contentFingerprint: v2.contentFingerprint }),
      409,
      "publication_fingerprint_mismatch",
    );
    await expectRefusal(await post(mounted, { ...input(matching), extra: true }), 400, "invalid_activation_input");
    expect(await authorityEvents()).toEqual([]);
  });

  it("requires a matching authenticated actor, platform-policy.manage and authentication within 15 minutes", async () => {
    const request = input(await createDocument(v1.version));
    for (const [actor, status, code] of [
      [null, 401, "authentication_required"],
      [{ ...operator, userId: createId("usr") }, 403, "actor_context_mismatch"],
      [{ ...operator, accountId: createId("acc") }, 403, "actor_context_mismatch"],
      [{ ...operator, tenantId: createId("tnt") }, 403, "actor_context_mismatch"],
      [{ ...operator, permissions: [] }, 403, "permission_required"],
      [{ ...operator, authenticatedAt: null }, 403, "recent_authentication_required"],
      [
        { ...operator, authenticatedAt: new Date(now.getTime() - 15 * 60_000 - 1).toISOString() },
        403,
        "recent_authentication_required",
      ],
    ] as const) {
      await expectRefusal(await post(app({ deploymentEnvironment: "test", actor }), request), status, code);
    }
    expect(await authorityEvents()).toEqual([]);
  });

  it("advances from A to B and does not expose a deactivation route", async () => {
    const mounted = app({ deploymentEnvironment: "test", publications: syntheticPublications });
    await expectActivation(await post(mounted, input(await createDocument(v1.version, 20))), v1.version, 2);
    const second = input(await createDocument(v2.version, 21), v2);
    await expectActivation(await post(mounted, second), v2.version, 3);
    const events = await authorityEvents();
    expect((await post(mounted, {}, "deactivate")).status).toBe(404);
    expect(await authority()).toMatchObject({ activeVersion: v2.version, activationCount: 2 });
    expect(await authorityEvents()).toEqual(events);
  });

  it("rejects B if C commits after B reads A, then rejects B as older on retry", async () => {
    const options = { deploymentEnvironment: "test", publications: syntheticPublications } as const;
    const mounted = app(options);
    const a = input(await createDocument(v1.version, 20));
    const b = input(await createDocument(v2.version, 21), v2);
    const c = input(await createDocument(v3.version, 22), v3);
    await expectActivation(await post(mounted, a), v1.version, 2);
    const bDocumentEvents = await documentEvents(b.documentId);
    let intercepted = false;
    const racedStore: EventStore = {
      ...store,
      async appendToStreams(inputs) {
        expect(inputs[0]).toMatchObject({
          streamId: `platform-policy.document-${b.documentId}`,
          expectedVersion: 1,
          events: [],
        });
        expect(inputs[1]).toMatchObject({
          streamId: authorityStream(),
          expectedVersion: 2,
          events: [{ payload: { activation: { version: v2.version } } }],
        });
        intercepted = true;
        await expectActivation(await post(mounted, c), v3.version, 3);
        return store.appendToStreams!(inputs);
      },
    };
    await expectRefusal(
      await post(app({ ...options, policies: runtime(racedStore) }), b),
      409,
      "activation_concurrency_conflict",
    );
    expect(intercepted).toBe(true);
    expect(await documentEvents(b.documentId)).toEqual(bDocumentEvents);
    expect(await authority()).toMatchObject({ activeVersion: v3.version, authorityVersion: 3, activationCount: 2 });
    const events = await authorityEvents();
    expect(events).toHaveLength(3);
    expect(events[2]?.payload).toMatchObject({ activation: { version: v3.version } });
    await expectRefusal(await post(mounted, b), 409, "version_not_newer");
    expect(await authorityEvents()).toEqual(events);
  });

  it("fails closed on pending copy outside test and staging, in publication refusal order", async () => {
    const documentId = await createDocument(v1.version);
    const request = input(documentId);
    const events = await documentEvents(documentId);
    for (const deploymentEnvironment of ["production", undefined, "dev", "local", "preview", "remote-dev"] as const) {
      await expectRefusal(await post(app({ deploymentEnvironment }), request), 409, "publication_not_activatable");
    }
    const badFingerprint = { ...request, contentFingerprint: v2.contentFingerprint };
    const mismatched = { ...v1, version: v2.version };
    await expectRefusal(
      await post(
        app({
          deploymentEnvironment: "production",
          publications: { [v1.version]: { ...mismatched, policyKey: "wrong.key" } },
        }),
        badFingerprint,
      ),
      409,
      "publication_key_mismatch",
    );
    await expectRefusal(
      await post(
        app({ deploymentEnvironment: "production", publications: { [v1.version]: mismatched } }),
        badFingerprint,
      ),
      409,
      "publication_not_activatable",
    );
    await expectRefusal(
      await post(app({ deploymentEnvironment: "staging", publications: { [v1.version]: mismatched } }), badFingerprint),
      409,
      "publication_version_mismatch",
    );
    expect(await authorityEvents()).toEqual([]);
    expect(await documentEvents(documentId)).toEqual(events);
    await expectActivation(await post(app({ deploymentEnvironment: "staging" }), request), v1.version, 2);
  });

  it("allows an exact counsel-approved publication in production", async () => {
    const request = input(await createDocument(v1.version));
    const approved = {
      ...v1,
      counselApprovalReference: "SYNTHETIC-COUNSEL-REFERENCE",
      consentActivatable: true,
    };
    const mounted = app({ deploymentEnvironment: "production", publications: { [v1.version]: approved } });
    await expectActivation(await post(mounted, request), v1.version, 2);
    expect((await resolveOfferPaymentEnforcement(policies.consentActivation)).version).toBe(v1.version);
  });
});
