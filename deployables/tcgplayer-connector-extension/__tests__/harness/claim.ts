import { createHash } from "node:crypto";
import type { ConnectorTransportServices } from "@chase-sets/channels/server";

export type Claim = NonNullable<Awaited<ReturnType<ConnectorTransportServices["claim"]>>["reservation"]>;

export function syntheticClaim(now = Date.now()): Claim {
  // Sorted fixture keys make these bytes the producer's canonical JSON, without another codec.
  const payload = {
    draft: {
      attributes: [],
      categoryKey: "card",
      channelListingId: "synthetic-link",
      conditionKey: "new",
      description: "",
      listingRevision: 1,
      price: { amountMinor: 100, currency: "USD" },
      quantity: 1,
      title: "SYNTHETIC_7940",
    },
    kind: "draft",
  } as const;
  const at = new Date(now).toISOString();
  return {
    reservationId: "synthetic-reservation",
    connectionId: "connection_synthetic",
    providerIdentity: { providerKey: "tcgplayer", environment: "sandbox" },
    claimant: { claimantKind: "connector", claimantId: "synthetic-pairing" },
    reservedAt: at,
    leaseExpiresAt: new Date(now + 1800000).toISOString(),
    operations: [
      {
        operationId: "synthetic-operation",
        attemptId: "synthetic-attempt",
        claimGeneration: 1,
        connectionId: "connection_synthetic",
        providerIdentity: { providerKey: "tcgplayer", environment: "sandbox" },
        channelListingId: "synthetic-link",
        listingId: "synthetic-listing",
        operationKind: "publish",
        listingRevision: 1,
        desiredStateSequence: 1,
        payload,
        payloadDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        sourceOccurredAt: at,
        enqueuedAt: at,
      },
    ],
  };
}
