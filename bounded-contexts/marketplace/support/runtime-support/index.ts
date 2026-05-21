import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CommercialTermsResolver } from "../../api";

export type ListingPhotoStorage = Readonly<{
  putObject(
    input: Readonly<{
      key: string;
      body: Uint8Array;
      contentType: string;
      cacheControl?: string;
    }>,
  ): Promise<Readonly<{ key: string; publicUrl: string }>>;
}>;

export type MarketplaceRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  commercialTermsResolver: CommercialTermsResolver;
  listingPhotoStorage?: ListingPhotoStorage;
}>;
