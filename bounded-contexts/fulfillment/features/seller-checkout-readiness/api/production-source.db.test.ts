import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as fulfillmentModule } from "../../../index";
import { createSellerCheckoutReadinessReader, createSellerShippingSetupServices } from "../../../server";
import { actor, accountOwner, anonymousOwner, context, grantedAuthority, initialize, setup } from "./test-support";
import type { SellerCheckoutReadinessKey } from "../domain/contract";
import type { JsonObject } from "@chase-sets/primitives/json";
import { seedFulfillmentDatabase, inspectFulfillmentSeedState } from "../../../support/runtime-support/seed";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for seller shipping production source tests in CI.");
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("seller shipping composed production source", () => {
  let pools: Readonly<Record<"fulfillment", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl!, ["fulfillment"], "seller_shipping_source");
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.fulfillment;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(fulfillmentModule, pool);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  function services() {
    return fulfillmentModule.createServices(pool, { operatorAuthority: grantedAuthority }).sellerShippingSetup;
  }
  async function supportApi(input: unknown) {
    const runtime = fulfillmentModule.createServices(pool, { operatorAuthority: grantedAuthority });
    const app = new Hono<AuthenticatedApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", actor);
      c.set("context", context);
      await next();
    });
    const router = fulfillmentModule.buildApis(runtime)[0]!.router;
    if (!(router instanceof Hono)) throw new Error("The Fulfillment API must register a Hono router.");
    app.route("/api/marketplace", router);
    return app.request("/api/marketplace/operations/seller-shipping-support", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  async function ready(
    owner = accountOwner,
    labelPreference: "prepaid-label" | "seller-label-later" = "prepaid-label",
  ) {
    const source = services();
    await source.saveSetup(owner, { ...setup, labelPreference }, context);
    await source.changeSupport(
      actor,
      { ...initialize, owner, operationId: `initialize_${owner.kind}_${labelPreference}` },
      context,
    );
    const resolved = await source.resolveOrigin(owner, { ...setup, labelPreference });
    if (resolved.status !== "accepted") throw new Error("Production resolver did not bind the saved origin.");
    return resolved.key;
  }

  it.each(["account", "anonymous"] as const)(
    "binds %s API -> operations -> committed store -> server reader across restart for both preferences",
    async (kind) => {
      const owner = kind === "account" ? accountOwner : anonymousOwner;
      const runtime = fulfillmentModule.createServices(pool, { operatorAuthority: grantedAuthority });
      const api = fulfillmentModule.buildApis(runtime)[0]!.router;
      if (!(api instanceof Hono)) throw new Error("The Fulfillment API must register a Hono router.");
      const app = new Hono<AuthenticatedApiEnv>();
      app.use("*", async (c, next) => {
        c.set("actor", kind === "account" ? { ...actor, accountId: accountOwner.accountId } : null);
        c.set("context", context);
        await next();
      });
      app.route("/api/marketplace", api);
      const headers = {
        "Content-Type": "application/json",
        ...(kind === "anonymous" ? { "x-checkout-anonymous-sell-list-id": anonymousOwner.anonymousSellListId } : {}),
      };
      for (const labelPreference of ["prepaid-label", "seller-label-later"] as const) {
        const choices = { ...setup, labelPreference };
        const response = await app.request(
          `/api/marketplace/${kind === "account" ? "account" : "guest"}/seller-shipping-setup`,
          { method: "PUT", headers, body: JSON.stringify(choices) },
        );
        expect(response.status).toBe(200);
        if (labelPreference === "prepaid-label") expect((await supportApi({ ...initialize, owner })).status).toBe(200);
        const resolved = await services().resolveOrigin(owner, choices);
        if (resolved.status !== "accepted") throw new Error("Missing production source binding");
        const result = await createSellerCheckoutReadinessReader(pool)(resolved.key);
        expect(result).toMatchObject({
          label: { status: "ready" },
          provider: { status: "ready" },
          sourceRevision: labelPreference === "prepaid-label" ? 2 : 3,
        });
        const actual = await pool.query<{ current_version: string; recorded_at: Date }>(
          `SELECT s.current_version, e.recorded_at FROM event_store_streams s JOIN event_store_events e ON e.stream_id=s.stream_id AND e.stream_version=s.current_version WHERE s.stream_id=$1`,
          [
            `fulfillment.seller-shipping-${kind}:${kind === "account" ? accountOwner.accountId : anonymousOwner.anonymousSellListId}`,
          ],
        );
        expect(result.sourceRevision).toBe(Number(actual.rows[0]!.current_version));
        expect(result.sourceTimestamp).toBe(actual.rows[0]!.recorded_at.toISOString());
        const reload = await app.request(
          `/api/marketplace/${kind === "account" ? "account" : "guest"}/seller-shipping-setup`,
          { headers },
        );
        expect(await reload.json()).toMatchObject({
          setup: { origin: setup.origin, labelPreference },
          supportStatus: "enabled",
          revision: result.sourceRevision,
        });
        await bootstrapContextDatabase(fulfillmentModule, pool);
        expect(await createSellerCheckoutReadinessReader(pool)(resolved.key)).toEqual(result);
        expect(JSON.stringify(result)).not.toContain(setup.origin.line1);
      }
    },
  );

  it("blocks omitted source, empty/setup-only/support-only states; boot/read never initializes support", async () => {
    const source = services();
    const absentKey: SellerCheckoutReadinessKey = {
      owner: accountOwner,
      shipFromLocationId: "sfl_absent",
      labelPreference: setup.labelPreference,
    };
    expect((await createSellerCheckoutReadinessReader(pool)(absentKey)).sourceRevision).toBeNull();
    const saved = await source.saveSetup(accountOwner, setup, context);
    const key = { ...absentKey, shipFromLocationId: saved.setup!.shipFromLocationId };
    expect((await createSellerCheckoutReadinessReader(pool)(key)).label).toMatchObject({
      status: "blocked",
      fact: "missing",
    });
    await bootstrapContextDatabase(fulfillmentModule, pool);
    expect(await services().readSetup(accountOwner)).toEqual(saved);
    await source.changeSupport(actor, { ...initialize, owner: anonymousOwner }, context);
    expect(
      (await createSellerCheckoutReadinessReader(pool)({ ...key, owner: anonymousOwner })).sourceRevision,
    ).toBeNull();
    await source.changeSupport(actor, initialize, context);
    expect((await createSellerCheckoutReadinessReader(pool)(key)).label.status).toBe("ready");
    const { readSellerCheckoutReadiness } = await import("../read-model/queries");
    expect((await readSellerCheckoutReadiness(async () => null, key)).label.status).toBe("blocked");
  });

  it("atomically records support/audit once on concurrent identical retries; conflicts do not write", async () => {
    const source = services();
    const results = await Promise.all([
      source.changeSupport(actor, initialize, context),
      services().changeSupport(actor, initialize, context),
    ]);
    expect(results[0]).toEqual(results[1]);
    await expect(source.changeSupport(actor, { ...initialize, reason: "conflict" }, context)).rejects.toThrow(
      "conflicting-operation",
    );
    await expect(source.changeSupport(actor, { ...initialize, owner: anonymousOwner }, context)).rejects.toThrow(
      "conflicting-operation",
    );
    const events = await pool.query<{ payload: { audit: unknown }; performed_by_user_id: string; recorded_at: Date }>(
      "SELECT payload, performed_by_user_id, recorded_at FROM event_store_events WHERE event_type='fulfillment.seller-shipping.support-recorded.v1'",
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.payload.audit).toMatchObject({
      userId: actor.userId,
      membershipId: actor.membershipId,
      before: null,
      after: results[0]!.support,
      operationId: initialize.operationId,
      revision: 1,
    });
    expect(events.rows[0]!.performed_by_user_id).toBe(actor.userId);
    expect(events.rows[0]!.recorded_at.toISOString()).toBe(results[0]!.recordedAt);
  });

  it("denies missing/throwing/stale authority before any durable write, regardless of posted roles", async () => {
    for (const authority of [
      undefined,
      async () => {
        throw new Error("offline");
      },
      async () => ({ kind: "denied" as const, reason: "not-platform-admin" as const }),
      async () => ({
        kind: "granted" as const,
        membershipId: "mem_stale",
        roleKey: "platform-admin" as const,
        rolePermissions: [],
      }),
    ]) {
      const source = createSellerShippingSetupServices({ pool, operatorAuthority: authority });
      await expect(source.changeSupport(actor, initialize, context)).rejects.toThrow();
    }
    expect(
      (await pool.query("SELECT event_id FROM event_store_events WHERE stream_id LIKE 'fulfillment.seller-shipping-%'"))
        .rows,
    ).toHaveLength(0);
  });

  it("retains revocation through restart, delayed initialization retry, projection replay and rejected old-version work", async () => {
    const key = await ready();
    const source = services();
    const previous = await pool.query<{ payload: JsonObject }>(
      "SELECT payload FROM event_store_events WHERE stream_id=$1 AND stream_version=2",
      ["fulfillment.seller-shipping-account:acc_seller"],
    );
    await source.changeSupport(
      actor,
      { ...initialize, action: "revoke", labelPreference: setup.labelPreference, operationId: "revoke" },
      context,
    );
    const revoked = await source.readReadiness(key);
    expect(revoked.label).toMatchObject({ status: "blocked", fact: "unavailable" });
    await services().changeSupport(actor, { ...initialize, operationId: "initialize_account_prepaid-label" }, context);
    await bootstrapContextDatabase(fulfillmentModule, pool);
    await seedFulfillmentDatabase(pool);
    await inspectFulfillmentSeedState(pool);
    // Projection resets/replay cannot rewrite the canonical owner stream.
    for (const projector of fulfillmentModule.createServices(pool, {}).projectors)
      expect(projector.projectionName).not.toContain("seller-shipping");
    expect(await services().readReadiness(key)).toEqual(revoked);
    const store = createPostgresEventStore({ pool });
    await expect(
      store.appendToStream({
        streamId: "fulfillment.seller-shipping-account:acc_seller",
        expectedVersion: 2,
        context,
        events: [{ eventType: "fulfillment.seller-shipping.support-recorded.v1", payload: previous.rows[0]!.payload }],
      }),
    ).rejects.toThrow();
    expect(await services().readReadiness(key)).toEqual(revoked);
    await source.changeSupport(
      actor,
      { ...initialize, action: "enable", labelPreference: setup.labelPreference, operationId: "reenable" },
      context,
    );
    expect((await source.readReadiness(key)).label.status).toBe("ready");
  });

  it("rolls back the support event and audit together after an append failure, then retries exactly once", async () => {
    const saved = await services().saveSetup(accountOwner, setup, context);
    const store = createPostgresEventStore({ pool });
    const crashing = createSellerShippingSetupServices({
      pool,
      operatorAuthority: grantedAuthority,
      eventStore: {
        ...store,
        appendToStreamInTransaction: async (client, input) => {
          await store.appendToStreamInTransaction(client, input);
          throw new Error("Synthetic crash after append, before commit");
        },
      },
    });
    await expect(crashing.changeSupport(actor, initialize, context)).rejects.toThrow("Synthetic crash");
    expect(await services().readSetup(accountOwner)).toEqual(saved);
    expect(
      (
        await pool.query(
          "SELECT event_id FROM event_store_events WHERE event_type='fulfillment.seller-shipping.support-recorded.v1'",
        )
      ).rows,
    ).toHaveLength(0);
    const result = await services().changeSupport(actor, initialize, context);
    expect(await services().changeSupport(actor, initialize, context)).toEqual(result);
    expect(
      (
        await pool.query(
          "SELECT event_id FROM event_store_events WHERE event_type='fulfillment.seller-shipping.support-recorded.v1'",
        )
      ).rows,
    ).toHaveLength(1);
  });

  it.each(["prepaid-label", "seller-label-later"] as const)(
    "keeps %s revocation through a racing setup edit and boot/reconciliation",
    async (labelPreference) => {
      const key = await ready(accountOwner, labelPreference);
      await Promise.all([
        services().saveSetup(
          accountOwner,
          { ...setup, labelPreference, origin: { ...setup.origin, line1: "2 Main St" } },
          context,
        ),
        services().changeSupport(
          actor,
          { ...initialize, action: "revoke", labelPreference, operationId: "race_revoke" },
          context,
        ),
      ]);
      const selected = { ...setup, labelPreference, origin: { ...setup.origin, line1: "2 Main St" } };
      const resolved = await services().resolveOrigin(accountOwner, selected);
      if (resolved.status !== "accepted") throw new Error("Expected current edited setup");
      const revoked = await services().readReadiness(resolved.key);
      expect(revoked.label).toMatchObject({ status: "blocked", fact: "unavailable" });
      expect((await services().readReadiness(key)).sourceRevision).toBeNull();
      await bootstrapContextDatabase(fulfillmentModule, pool);
      await seedFulfillmentDatabase(pool);
      expect(await services().readReadiness(resolved.key)).toEqual(revoked);
    },
  );

  it("persists empty and historical-location tombstones across restart without copying account support", async () => {
    const source = services();
    const emptyOwner = { kind: "anonymous", anonymousSellListId: "anon_empty" } as const;
    const emptyInput = { owner: emptyOwner, targetAccountId: accountOwner.accountId };
    const empty = await source.invalidateAnonymousOwner(emptyInput, context);
    await bootstrapContextDatabase(fulfillmentModule, pool);
    expect(await services().invalidateAnonymousOwner(emptyInput, context)).toEqual(empty);
    await expect(services().saveSetup(emptyOwner, setup, context)).rejects.toThrow("invalidated");
    const keys: SellerCheckoutReadinessKey[] = [];
    await source.changeSupport(actor, { ...initialize, owner: anonymousOwner }, context);
    for (const line1 of ["1 Main St", "2 Main St"]) {
      const saved = await source.saveSetup(anonymousOwner, { ...setup, origin: { ...setup.origin, line1 } }, context);
      const key = {
        owner: anonymousOwner,
        shipFromLocationId: saved.setup!.shipFromLocationId,
        labelPreference: setup.labelPreference,
      };
      expect((await source.readReadiness(key)).label.status).toBe("ready");
      keys.push(key);
    }
    await source.invalidateAnonymousOwner({ owner: anonymousOwner, targetAccountId: accountOwner.accountId }, context);
    await bootstrapContextDatabase(fulfillmentModule, pool);
    for (const key of keys) expect((await services().readReadiness(key)).label.status).toBe("blocked");
    await expect(
      services().changeSupport(actor, { ...initialize, owner: anonymousOwner, operationId: "after_merge" }, context),
    ).rejects.toThrow("invalidated");
    expect(await services().readSetup(accountOwner)).toMatchObject({
      setup: null,
      supportStatus: "missing",
      revision: null,
    });
  });

  it("serializes setup/invalidation races and persists the owner-wide fence without touching account facts", async () => {
    const accountKey = await ready();
    const accountBefore = await services().readReadiness(accountKey);
    const owner = anonymousOwner;
    const source = services();
    await Promise.allSettled([
      source.saveSetup(owner, setup, context),
      services().invalidateAnonymousOwner({ owner, targetAccountId: accountOwner.accountId }, context),
    ]);
    const invalidated = await services().readSetup(owner);
    expect(invalidated).toMatchObject({ setup: null, supportStatus: "invalidated" });
    const first = await source.invalidateAnonymousOwner({ owner, targetAccountId: accountOwner.accountId }, context);
    expect(
      await services().invalidateAnonymousOwner({ owner, targetAccountId: accountOwner.accountId }, context),
    ).toEqual(first);
    await expect(source.invalidateAnonymousOwner({ owner, targetAccountId: "acc_other" }, context)).rejects.toThrow(
      "conflicting-operation",
    );
    await expect(services().saveSetup(owner, setup, context)).rejects.toThrow("invalidated");
    for (const shipFromLocationId of ["sfl_old", "sfl_other", "sfl_future"])
      expect(
        (await source.readReadiness({ owner, shipFromLocationId, labelPreference: setup.labelPreference })).label
          .status,
      ).toBe("blocked");
    expect(await services().readReadiness(accountKey)).toEqual(accountBefore);
    await bootstrapContextDatabase(fulfillmentModule, pool);
    expect(await services().readSetup(owner)).toEqual(invalidated);
  });
});
