import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { ObjectStorage } from "@chase-sets/object-storage";
import type { CommercialTermsResolver } from "../../api";
import type { ListingEvidencePolicyEvaluator } from "../../features/listings/api/evidence-requirement-resolver";
import type { MarketplaceGradedCardDetails } from "../../features/listings/domain/domain";
import type { ManagedOfferPricing } from "../../features/offers/api/managed-authority";
import type { MarketplaceOfferLifecycleAdmission } from "../../features/offers/api/lifecycle-admission";
import type { ListingTargetAuthority } from "../../features/listings/api/target-contracts";

export type ListingPhotoStorage = Readonly<{
  getObject: ObjectStorage["getObject"];
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

/**
 * Inventory's answer for one item its account owns: the Graded Item Details recorded at creation and the
 * selection they were written from.
 */
export type InventoryItemGradedCardAuthority = Readonly<{
  resolve(input: Readonly<{ accountId: string; inventoryItemId: string }>): Promise<Readonly<{
    gradedCard: MarketplaceGradedCardDetails | null;
    selectedOptions: readonly { dimensionId: string; optionId: string }[];
  }> | null>;
}>;

/**
 * Inventory's answer for what an item its account owns records now: the item facts a Listing created from an
 * Inventory snapshot must match and writes into the account's supply rows.
 */
export type InventoryCurrentItemAuthority = Readonly<{
  resolve(
    input: Readonly<{ accountId: string; inventoryItemId: string }>,
    context: EventStoreContext,
  ): Promise<Readonly<{
    catalogItemId: string;
    productId: string;
    storageLocation: Readonly<{
      storageLocationId: string;
      name: string;
      shipFromCode: string;
      shipFromAddress: AddressSnapshot;
      status: "active" | "retired";
    }>;
    totalQuantity: number;
    availableQuantity: number;
    acquisitionCostAmount: string | null;
    acquisitionCostCurrencyCode: string | null;
  }> | null>;
}>;

export type MarketplaceRuntimeDeps = Readonly<{
  listingTargetAuthority?: ListingTargetAuthority;
  /** Absent keeps Listing creation from an Inventory snapshot closed. */
  inventoryItemGradedCardAuthority?: InventoryItemGradedCardAuthority;
  /** Absent keeps Listing creation from an Inventory snapshot through `POST /listings` closed. */
  inventoryCurrentItemAuthority?: InventoryCurrentItemAuthority;
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  commercialTermsResolver: CommercialTermsResolver;
  listingPhotoStorage?: ListingPhotoStorage;
  /** The marketplace-owned platform-policy runtime; absent falls back to compiled policy defaults. */
  policies?: Pick<PolicyRuntime, "resolvePolicy">;
  listingEvidencePolicyEvaluator?: ListingEvidencePolicyEvaluator;
  managedOfferPricing?: ManagedOfferPricing;
  /** Absent keeps Pause, Resume and Withdraw closed. */
  offerLifecycleAdmission?: MarketplaceOfferLifecycleAdmission;
}>;
