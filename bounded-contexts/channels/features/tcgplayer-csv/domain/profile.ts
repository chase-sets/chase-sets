import type { ChannelCompositionProfile } from "../../listing-composition/domain/contracts";
import type { ChannelProviderDescriptor } from "../../publication-port/domain/contracts";
import type { ChannelExportSchemaDescriptor } from "./contracts";

const providerEvidence = Object.freeze({
  sourceKind: "operator-capture" as const,
  sourceRef:
    "https://github.com/chase-sets/chase-sets/issues/7026#issuecomment-5554920388,https://github.com/chase-sets/chase-sets/issues/7026#issuecomment-5555055372,https://github.com/chase-sets/chase-sets/issues/7026#issuecomment-5555154180",
  sourceVersion: "Seller Portal v313357",
  capturedAt: "2026-09-05T22:16:27Z",
});

export const tcgplayerLiveExportHeader = [
  "TCGplayer Id",
  "Product Line",
  "Set Name",
  "Product Name",
  "Title",
  "Number",
  "Rarity",
  "Condition",
  "TCG Market Price",
  "TCG Direct Low",
  "TCG Low Price With Shipping",
  "TCG Low Price",
  "Total Quantity",
  "Add to Quantity",
  "TCG Marketplace Price",
  "Photo URL",
] as const;

export const tcgplayerExportSchemaDescriptors: readonly ChannelExportSchemaDescriptor[] = Object.freeze([
  {
    providerKey: "tcgplayer",
    surface: "live",
    pinState: "fixed",
    requiredColumns: tcgplayerLiveExportHeader,
    fixedHeader: tcgplayerLiveExportHeader,
    derivation: { ...providerEvidence, capturedAt: "2026-09-05T21:57:32Z" },
  },
  {
    providerKey: "tcgplayer",
    surface: "staged",
    pinState: "connection-write-once",
    requiredColumns: ["TCGplayer Id", "Total Quantity", "Add to Quantity", "TCG Marketplace Price"],
    derivation: providerEvidence,
  },
]);

export const tcgplayerProviderDescriptors: readonly ChannelProviderDescriptor[] = Object.freeze(
  (["sandbox", "production"] as const).map((environment) => ({
    identity: { providerKey: "tcgplayer", environment },
    setup: {
      providerKey: "tcgplayer",
      environment,
      requirements: {
        credential: "not-required",
        requiredPolicyKeys: ["channels.tcgplayer-staged-import"],
        binding: "one-or-more-current",
      },
    },
    publication: { execution: "claimed" },
  })),
);

export const tcgplayerCompositionProfiles: readonly ChannelCompositionProfile[] = Object.freeze(
  (["sandbox", "production"] as const).map((environment) => ({
    identity: { providerKey: "tcgplayer", environment },
    derivation: providerEvidence,
    snapshotPreservedPlaceholder: "chase-sets:snapshot-preserved:tcgplayer",
    title: { mode: "snapshot-preserved", maxLength: 4_096, snapshotField: "referenceColumns.Title" },
    description: { mode: "snapshot-preserved", maxLength: 100_000, snapshotField: "referenceColumns" },
    category: {
      mode: "snapshot-preserved",
      maxKeyLength: 256,
      snapshotField: "referenceColumns.Product Line",
    },
    condition: { mode: "snapshot-preserved", maxKeyLength: 256, snapshotField: "conditionText" },
    attributes: {
      mode: "snapshot-preserved",
      maxCount: 200,
      maxKeyLength: 256,
      maxValueLength: 4_096,
      snapshotField: "referenceColumns",
    },
    quantity: { max: 1_000_000, draftField: "quantity" },
    price: { maxAmountMinor: Number.MAX_SAFE_INTEGER, allowedCurrencies: ["USD"], draftField: "price" },
    requiresProviderCatalogItemReference: true,
    requiresProviderProductReference: false,
    conditionDimensionId: null,
    forbiddenPatterns: [],
  })),
);
