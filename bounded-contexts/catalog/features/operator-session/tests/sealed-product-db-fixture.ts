import { createHash } from "node:crypto";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";
import { seedCatalogDatabase } from "../../../support/authoring-support/seed";
import {
  decideSourceObservation,
  evolveSourceObservation,
  initialSourceObservationState,
  type SourceObservationEvent,
} from "../../source-observations/domain/domain";
import { operatorExtensionContext } from "../api/set-name-observations";
import { createExtensionTcgplayerSealedProductRecorder } from "../../source-observations/api/extension-tcgplayer-sealed-products";
import { createCatalogProviderIntegrationProfileVersionStore } from "../../source-observations/api/providers/provider-integration-profile-store";
import { observationWriteLockId, withOperatorSessionBackend } from "../api/operation";
import { parseTcgplayerSealedProductObservationPost } from "../domain/extension/sealed-products/contract";
import { tcgplayerSealedProductUnitKeyForLine } from "../../source-observations/api/providers/tcgplayer/adapter";
import { grantBearer, provenance } from "./set-name-observation-fixture";
import { sealedPost } from "./sealed-product-observation-fixture";

export async function composeSealedProducts(pool: PgTransactionalPool) {
  await seedCatalogDatabase(pool, undefined, { enabledDataProfiles: ["catalog-integration-bootstrap"] });
  await pool.query(
    `INSERT INTO catalog_operator_session_grants
    (id, token_hash, creator_user_id, creator_membership_id, created_at, last_used_at, idle_expires_at)
    VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '30 days')`,
    [
      provenance.grantId,
      createHash("sha256").update(grantBearer, "ascii").digest(),
      provenance.creatorUserId,
      provenance.creatorMembershipId,
    ],
  );
  const services = catalogModule.createServices(pool, {
    catalogOperatorAuthority: {
      forActor: async () => ({
        kind: "granted",
        membershipId: provenance.creatorMembershipId,
        roleKey: "platform-admin",
        rolePermissions: ["catalog.manage"],
      }),
      forGrantCreator: async () => ({
        kind: "granted",
        membershipId: provenance.creatorMembershipId,
        roleKey: "platform-admin",
        rolePermissions: ["catalog.manage"],
      }),
    },
  });
  const store = createPostgresEventStore({ pool });
  // Keep the recorder's salvage and publication fixtures independent of request
  // state. Correlation and rollback of settlement are tested through the public route.
  const record = createExtensionTcgplayerSealedProductRecorder({
    pool,
    profileVersions: createCatalogProviderIntegrationProfileVersionStore(pool),
    deps: { db: pool, eventStore: store, checkpointStore: createPostgresProjectionStore({ db: pool }) },
  });
  async function post(body: unknown = sealedPost()) {
    const parsed = parseTcgplayerSealedProductObservationPost(body);
    if (!parsed.ok) throw new Error("Invalid sealed recorder fixture");
    const unitKey = tcgplayerSealedProductUnitKeyForLine(parsed.post.products[0]!.productLineName);
    if (!unitKey) throw new Error("Unsupported sealed recorder fixture");
    try {
      const result = await withOperatorSessionBackend(
        pool,
        (backend) =>
          record(
            {
              post: parsed.post,
              unitKey,
              provenance,
              context: operatorExtensionContext(provenance),
            },
            backend,
          ),
        observationWriteLockId,
      );
      return Response.json(result);
    } catch {
      return Response.json({ code: "source-observations-unavailable" }, { status: 503 });
    }
  }
  const observations = createAggregateCommandHandler({
    eventStore: store,
    codec: createPassthroughDomainEventCodec<SourceObservationEvent>(),
    initialState: () => initialSourceObservationState,
    evolve: evolveSourceObservation,
    decide: decideSourceObservation,
  }).repository;
  return { services, post, store, observations };
}

export async function acceptSealedMapping(
  pool: PgTransactionalPool,
  unitKey: string,
  setName: string,
  productLineId: number,
) {
  const scopeRecordId = `scope-sealed-${productLineId}`;
  await pool.query(
    `INSERT INTO catalog_provider_scope_mappings
    (mapping_id, scope_record_id, provider_key, unit_key, product_line_id, set_name, confidence, review_status, policy_version)
    VALUES ($1, $2, 'tcgplayer', $3, $4, $5, 'manual', 'accepted', 'synthetic')`,
    [`mapping-sealed-${productLineId}`, scopeRecordId, unitKey, String(productLineId), setName],
  );
  return scopeRecordId;
}
