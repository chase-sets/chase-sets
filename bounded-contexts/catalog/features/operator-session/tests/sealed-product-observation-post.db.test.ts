import { expect, it } from "vitest";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  decideCatalogMergeCandidate,
  evolveCatalogMergeCandidate,
  initialCatalogMergeCandidateState,
  type CatalogMergeCandidateEvent,
} from "../../source-observations/domain/catalog-merge-candidate";
import { sourceObservationStreamId } from "../../source-observations/api/source-observation-stream-identity";
import { describeDb, useOperatorSessionDatabase } from "./db-fixture";
import { composeSealedProducts, acceptSealedMapping } from "./sealed-product-db-fixture";
import { salvage, sealedPost } from "./sealed-product-observation-fixture";
import { grantBearer, provenance, testContext } from "./set-name-observation-fixture";

describeDb("sealed product observation posts", () => {
  const db = useOperatorSessionDatabase("sealed_product_observation_post");
  it.each(["promoted", "rejected"] as const)(
    "admits identical and mixed reposts after a candidate is %s without rewriting its terminal history",
    async (terminal) => {
      const pool = db();
      const h = await composeSealedProducts(pool);
      const entry = salvage.cases[0]!;
      await acceptSealedMapping(pool, entry.unitKey, entry.detail.setName, entry.detail.productLineId);
      expect((await h.post()).status).toBe(200);
      const created = await pool.query<{ stream_id: string }>(
        "SELECT stream_id FROM event_store_events WHERE event_type = 'catalog.merge-candidate.created'",
      );
      expect(created.rows).toHaveLength(1);
      const streamId = created.rows[0]!.stream_id;
      const candidates = createAggregateCommandHandler({
        eventStore: h.store,
        codec: createPassthroughDomainEventCodec<CatalogMergeCandidateEvent>(),
        initialState: () => initialCatalogMergeCandidateState,
        evolve: evolveCatalogMergeCandidate,
        decide: decideCatalogMergeCandidate,
      });
      await candidates.commandHandler({
        streamId,
        command: {
          ...(terminal === "promoted"
            ? { type: "PromoteCatalogMergeCandidate", promotedAt: "2026-11-15T00:00:00.000Z" }
            : { type: "IgnoreCatalogMergeCandidate", ignoredAt: "2026-11-15T00:00:00.000Z" }),
          reason: "Reviewed synthetic sealed product",
          actor: { userId: provenance.creatorUserId, accountId: testContext.audit.forAccountId },
        },
        context: testContext,
      });
      const terminalBefore = await candidates.repository.load(streamId);
      expect(terminalBefore.state.status).toBe(terminal);
      const observationStreamId = sourceObservationStreamId(entry.expected.observationId);
      const observationVersion = (await h.observations.load(observationStreamId)).version;
      const countAdmissions = async () =>
        (
          await pool.query(
            "SELECT event_id FROM event_store_events WHERE event_type = 'catalog.operator-session.sealed-product-observations-admitted'",
          )
        ).rows.length;
      const admissionsBefore = await countAdmissions();
      const repeatedPost = sealedPost();
      repeatedPost.observedAt = "2026-11-15T01:00:00.000Z";
      const repeated = await h.post(repeatedPost);
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toEqual({
        recorded: 0,
        changed: 0,
        unchanged: 1,
        candidateCount: 1,
        exclusions: [],
      });
      expect((await h.observations.load(observationStreamId)).version).toBe(observationVersion);
      expect(await candidates.repository.load(streamId)).toEqual(terminalBefore);
      expect(await countAdmissions()).toBe(admissionsBefore + 1);
      expect(
        (
          await pool.query(
            "SELECT event_id FROM event_store_events WHERE event_type = 'catalog.merge-candidate.created'",
          )
        ).rows,
      ).toHaveLength(1);

      const mixedPost = sealedPost();
      const newProduct = structuredClone(mixedPost.products[0]!);
      newProduct.productId += 1;
      newProduct.productName = "Synthetic new sealed product";
      newProduct.customAttributes.number = "BOX";
      newProduct.barcode = "0653569123457";
      for (const sku of newProduct.skus) sku.sku += 1;
      mixedPost.products.push(newProduct);
      const mixed = await h.post(mixedPost);
      expect(mixed.status).toBe(200);
      expect(await mixed.json()).toEqual({ recorded: 1, changed: 0, unchanged: 1, candidateCount: 2, exclusions: [] });
      expect((await h.observations.load(observationStreamId)).version).toBe(observationVersion);
      expect(await candidates.repository.load(streamId)).toEqual(terminalBefore);
      expect(await countAdmissions()).toBe(admissionsBefore + 2);
      expect(
        (
          await pool.query(
            "SELECT event_id FROM event_store_events WHERE event_type = 'catalog.merge-candidate.created'",
          )
        ).rows,
      ).toHaveLength(2);
      expect(
        (await h.observations.load(sourceObservationStreamId(`tcgplayer_en_product_${newProduct.productId}`))).state.id,
      ).toBe(`tcgplayer_en_product_${newProduct.productId}`);

      const changed = sealedPost();
      changed.products[0]!.customAttributes.packCount = 2;
      expect((await h.post(changed)).status).toBe(503);
      expect((await h.observations.load(observationStreamId)).version).toBe(observationVersion);
      expect(await candidates.repository.load(streamId)).toEqual(terminalBefore);
      expect(await countAdmissions()).toBe(admissionsBefore + 2);
    },
  );

  it.each(salvage.cases)("records salvage parity for $unitKey and one admission per post", async (entry) => {
    const pool = db();
    const h = await composeSealedProducts(pool);
    const response = await h.post({ ...sealedPost(), products: [entry.detail] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      recorded: 1,
      changed: 0,
      unchanged: 0,
      candidateCount: 0,
      exclusions: [{ productId: entry.detail.productId, code: "unmapped-provider-scope" }],
    });
    const loaded = await h.observations.load(sourceObservationStreamId(entry.expected.observationId));
    expect(loaded.state).toMatchObject({
      id: entry.expected.observationId,
      externalKey: entry.expected.externalKey,
      sourceProfileKey: entry.expected.sourceProfileKey,
      sourceProfileVersion: entry.expected.sourceProfileVersion,
      sourceMappingFingerprint: entry.expected.sourceMappingFingerprint,
      sourceRecordHash: entry.expected.sourceRecordHash,
      normalized: entry.expected.normalized,
      sourcePayload: entry.expected.sourcePayload,
    });
    const admissions = await pool.query<{ payload: unknown }>(
      "SELECT payload FROM event_store_events WHERE event_type = 'catalog.operator-session.sealed-product-observations-admitted'",
    );
    expect(admissions.rows).toEqual([{ payload: { ...provenance, observationIds: [entry.expected.observationId] } }]);
    const events = await pool.query("SELECT payload, metadata FROM event_store_events");
    const rows = await pool.query("SELECT * FROM catalog_source_observations");
    const evidence = JSON.stringify([events.rows, rows.rows]);
    for (const marker of [grantBearer, "hostile-cookie-value", "hostile-forwarded-token", "TCGAuthTicket="])
      expect(evidence).not.toContain(marker);
  });
  it("converges concurrent posts, retains revisions on repeat, records changed detail, and creates one mapped candidate", async () => {
    const pool = db();
    const h = await composeSealedProducts(pool);
    const entry = salvage.cases[0]!;
    await acceptSealedMapping(pool, entry.unitKey, entry.detail.setName, entry.detail.productLineId);
    const racing = await Promise.all([h.post(), h.post()]);
    expect(racing.map((response) => response.status)).toEqual([200, 200]);
    const results = await Promise.all(racing.map((response) => response.json()));
    expect(results.map((result) => result.recorded).sort()).toEqual([0, 1]);
    expect(results.map((result) => result.unchanged).sort()).toEqual([0, 1]);
    expect(results.every((result) => result.candidateCount === 1)).toBe(true);
    const streamId = sourceObservationStreamId(entry.expected.observationId);
    const version = (await h.observations.load(streamId)).version;
    expect((await h.post()).status).toBe(200);
    expect((await h.observations.load(streamId)).version).toBe(version);
    const changed = sealedPost();
    changed.products[0]!.customAttributes.packCount = 2;
    expect(await (await h.post(changed)).json()).toMatchObject({
      recorded: 0,
      changed: 1,
      unchanged: 0,
      candidateCount: 1,
    });
    expect((await h.observations.load(streamId)).version).toBeGreaterThan(version);
    expect(
      (
        await pool.query(
          "SELECT DISTINCT stream_id FROM event_store_events WHERE stream_id LIKE 'catalog.merge-candidate-%'",
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT event_id FROM event_store_events WHERE event_type = 'catalog.operator-session.sealed-product-observations-admitted'",
        )
      ).rows,
    ).toHaveLength(4);
  });
  it("rolls back observations and candidates when the admission append fails", async () => {
    const pool = db();
    const h = await composeSealedProducts(pool);
    await pool.query(`CREATE FUNCTION refuse_sealed_admission() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type = 'catalog.operator-session.sealed-product-observations-admitted' THEN
        RAISE EXCEPTION 'synthetic admission failure'; END IF; RETURN NEW; END $$`);
    await pool.query(
      "CREATE TRIGGER refuse_sealed_admission BEFORE INSERT ON event_store_events FOR EACH ROW EXECUTE FUNCTION refuse_sealed_admission()",
    );
    expect((await h.post()).status).toBe(503);
    expect(
      (await pool.query("SELECT event_id FROM event_store_events WHERE stream_id LIKE 'catalog.source-observation-%'"))
        .rows,
    ).toEqual([]);
    expect(
      (await pool.query("SELECT event_id FROM event_store_events WHERE stream_id LIKE 'catalog.merge-candidate-%'"))
        .rows,
    ).toEqual([]);
  });
});
