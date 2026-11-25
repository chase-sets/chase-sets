import { createHash } from "node:crypto";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { expect, it } from "vitest";
import { proposeProviderScopeMapping, reviewProviderScopeMappings } from "../../provider-scope-mapping/api/route";
import { CATALOG_PROVIDER_SCOPE_MAPPING_STREAM_PREFIX } from "../../provider-scope-mapping/domain/domain";
import { buildProviderScopeMappingProjectionHandlers } from "../../provider-scope-mapping/read-model/projection";
import { operatorSessionPublicRoutes } from "../api/route";
import { operatorOrigins } from "../domain/extension/protocol";
import { sealedPartHeader } from "../domain/extension/sealed-products/answer-contract";
import { setNameRequestHeader } from "../domain/extension/set-names/request";
import { describeDb, useOperatorSessionDatabase } from "./db-fixture";
import { composeSealedProducts } from "./sealed-product-db-fixture";
import { salvage, sealedPost, sealedRoutePath } from "./sealed-product-observation-fixture";
import { grantBearer, routePath, setNameEntry, setNamePost, testContext } from "./set-name-observation-fixture";

const unit = salvage.cases[0]!;
const detail = unit.detail;
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const origin = operatorOrigins.staging;
const turn = { claimOwnerId: "synthetic-sealed-worker", claimTtlMs: 1_000 };
const complete = (productCount: number, ...partDigests: string[]) =>
  JSON.stringify({ kind: "complete", partDigests, productCount, verifiedEmpty: productCount === 0 });

describeDb("durable Scope Sync sealed requests", () => {
  const db = useOperatorSessionDatabase("durable_sealed_request");
  async function harness() {
    const pool = db();
    const { services, store } = await composeSealedProducts(pool);
    const app = operatorSessionPublicRoutes(services.operatorSession);
    const headers = { Authorization: `Bearer ${grantBearer}`, "Content-Type": "application/json" };
    const scopeId = "scope-sealed-request";
    await pool.query(
      `INSERT INTO catalog_scope_records (scope_record_id, product_domain, scope_kind, reference_type_key,
        reference_record_id, reference_record_key, name, lifecycle_status)
        VALUES ($1, 'magic', 'expansion', 'set', $1, $1, 'Different Catalog name', 'active')`,
      [scopeId],
    );
    const { mappingId } = await proposeProviderScopeMapping(
      services.providerScopeMappings,
      {
        scopeRecordId: scopeId,
        providerKey: "tcgplayer",
        unitKey: unit.unitKey,
        coordinates: { productLineId: String(detail.productLineId), setName: "synthetic-provider-clean-name" },
        autoAccept: true,
      },
      testContext,
    );
    const handlers = buildProviderScopeMappingProjectionHandlers(pool);
    for (const event of await store.readStream({
      streamId: `${CATALOG_PROVIDER_SCOPE_MAPPING_STREAM_PREFIX}${mappingId}`,
    }))
      await handlers[event.eventType]!(toTransportEvent(event));
    const entry = setNameEntry(detail.productLineId, detail.setId, {
      name: detail.setName,
      cleanSetName: "synthetic-provider-clean-name",
    });
    const scope = {
      scopeVersion: "catalog-sync-scope-v2" as const,
      productDomain: "magic",
      reference: { kind: "expansion" as const, scopeRecordId: scopeId },
      providerParticipation: { requiredUnitKeys: [unit.unitKey] },
    };
    const preview = () => services.sourceObservations.previewCatalogSyncScope({ scope, context: testContext });
    expect(await preview()).toMatchObject({
      status: "blocked",
      blockers: [expect.objectContaining({ code: "sealed-request-coordinates-unavailable" })],
    });
    expect(
      (
        await app.request(origin + routePath, {
          method: "POST",
          headers,
          body: JSON.stringify(setNamePost(detail.productLineId, [entry])),
        })
      ).status,
    ).toBe(200);
    expect(await preview()).toMatchObject({
      status: "ready",
      units: [
        {
          childExecutionScope: {
            execution: "extension-sealed-products",
            setId: String(detail.setId),
            setName: detail.setName,
          },
        },
      ],
    });
    const batchInput = { context: testContext, selection: { mode: "ids" as const, scopeRecordIds: [scopeId] } };
    const plan = await services.scopeSyncBatches.preview(batchInput);
    expect(plan).toMatchObject({ status: "ready", providerUnitTotals: { tcgplayer: 1 } });
    const batch = await services.scopeSyncBatches.confirm({ ...batchInput, planFingerprint: plan.planFingerprint });
    await services.sourceObservations.processNextIntegrationJob(turn);
    await services.sourceObservations.processNextIntegrationJob(turn);
    const polled = await app.request(origin + "/observation-requests/current?version=2", { headers });
    const { request } = await polled.json();
    expect(request).toMatchObject({
      kind: "sealed-products",
      productLineId: detail.productLineId,
      setNameId: detail.setId,
      searchName: detail.setName,
    });
    const send = (body: string, partIndex?: number) =>
      app.request(origin + sealedRoutePath, {
        method: "POST",
        body,
        headers: {
          ...headers,
          [setNameRequestHeader]: request.requestId,
          ...(partIndex === undefined ? {} : { [sealedPartHeader]: String(partIndex) }),
        },
      });
    const snapshot = () => services.scopeSyncBatches.get({ batchId: batch.batchId, context: testContext });
    const events = async () =>
      (
        await pool.query(
          `SELECT event_type FROM event_store_events WHERE event_type IN
       ('catalog.source-observation.recorded', 'catalog.merge-candidate.created',
        'catalog.operator-session.sealed-product-observations-admitted') ORDER BY global_position`,
        )
      ).rows;
    async function settle() {
      for (let index = 0; index < 3; index++) await services.sourceObservations.processNextIntegrationJob(turn);
      return snapshot();
    }
    return { pool, send, snapshot, settle, events, mappingId, services, scope };
  }

  it("admits a complete manifest once and settles its mapped child and batch", async () => {
    const h = await harness();
    const part = JSON.stringify(sealedPost());
    const manifest = complete(1, digest(part));
    expect((await h.send(manifest)).status).toBe(409);
    const wrong = sealedPost();
    wrong.products[0]!.setId++;
    expect((await h.send(JSON.stringify(wrong), 0)).status).toBe(409);
    const staged = await h.send(part, 0);
    expect(await staged.json()).toEqual({ kind: "part", partIndex: 0 });
    expect((await h.send(part + " ", 0)).status).toBe(409);
    expect((await h.send(part, 1)).status).toBe(409);
    expect((await h.send(complete(1, digest(part + " ")))).status).toBe(409);
    expect((await h.send(complete(0))).status).toBe(409);
    expect(await h.events()).toEqual([]);
    expect(await h.snapshot()).toMatchObject({ status: "running" });

    await h.pool.query(`CREATE FUNCTION refuse_sealed_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.receipt->>'kind' = 'complete' THEN RAISE EXCEPTION 'synthetic receipt failure'; END IF;
      RETURN NEW; END $$`);
    await h.pool.query(`CREATE TRIGGER refuse_sealed_receipt BEFORE UPDATE ON catalog_set_name_requests
      FOR EACH ROW EXECUTE FUNCTION refuse_sealed_receipt()`);
    expect((await h.send(manifest)).status).toBe(503);
    expect(await h.events()).toEqual([]);
    await h.pool.query("DROP TRIGGER refuse_sealed_receipt ON catalog_set_name_requests");
    const acks = await Promise.all([h.send(manifest), h.send(manifest)]);
    expect(acks.map((ack) => ack.status)).toEqual([200, 200]);
    const [first, replay] = await Promise.all(acks.map((ack) => ack.json()));
    expect(first).toMatchObject({ kind: "complete", productCount: 1, recorded: 1, candidateCount: 1, exclusions: [] });
    expect(replay).toEqual(first);
    expect(await (await h.send(part, 0)).json()).toEqual({ kind: "part", partIndex: 0 });
    expect((await h.send(manifest + " ")).status).toBe(409);
    expect(await h.events()).toHaveLength(3);
    expect(await h.settle()).toMatchObject({ status: "completed", units: [{ state: "completed" }] });
    expect(
      await h.services.sourceObservations.previewCatalogSyncScope({ scope: h.scope, context: testContext }),
    ).toMatchObject({ status: "ready" });
  });

  it("settles verified empty without writing observations or candidates", async () => {
    const h = await harness();
    expect((await h.send(JSON.stringify({ ...JSON.parse(complete(0)), verifiedEmpty: false }))).status).toBe(400);
    expect(await (await h.send(complete(0))).json()).toMatchObject({
      kind: "complete",
      productCount: 0,
      verifiedEmpty: true,
    });
    expect(await h.events()).toEqual([]);
    expect(await h.settle()).toMatchObject({ status: "completed", units: [{ state: "completed" }] });
  });

  it("refuses a canonical revocation after staging even before the projection catches up", async () => {
    const h = await harness();
    const part = JSON.stringify(sealedPost());
    expect((await h.send(part, 0)).status).toBe(200);
    await reviewProviderScopeMappings(
      h.services.providerScopeMappings,
      { intent: "revoke", mappingIds: [h.mappingId], reason: "Synthetic revocation" },
      testContext,
    );
    expect(await h.services.providerScopeMappings.getMapping(h.mappingId)).toMatchObject({ review_status: "accepted" });
    expect((await h.send(complete(1, digest(part)))).status).toBe(409);
    expect(await h.events()).toEqual([]);
    expect(await h.settle()).toMatchObject({
      status: "failed",
      units: [{ state: "failed", errorMessage: "extension-request-stale" }],
    });
  });
});
