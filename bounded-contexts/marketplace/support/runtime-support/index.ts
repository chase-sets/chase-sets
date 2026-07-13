import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { CommercialTermsResolver } from "../../api";
import type { ListingEvidencePolicyEvaluator } from "../../features/listings/api/evidence-requirement-resolver";

export type ListingPhotoStorage = Readonly<{
  putObject(
    input: Readonly<{
      key: string;
      body: Uint8Array;
      contentType: string;
      cacheControl?: string;
    }>,
  ): Promise<Readonly<{ key: string; publicUrl: string }>>;
  /** Idempotent bulk delete for evidence garbage collection; optional so non-storage wiring still constructs. */
  deleteObjects?: (keys: readonly string[]) => Promise<void>;
}>;

export type MarketplaceRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  commercialTermsResolver: CommercialTermsResolver;
  listingPhotoStorage?: ListingPhotoStorage;
  /** The marketplace-owned platform-policy runtime; absent falls back to compiled policy defaults. */
  policies?: Pick<PolicyRuntime, "resolvePolicy">;
  listingEvidencePolicyEvaluator?: ListingEvidencePolicyEvaluator;
}>;
