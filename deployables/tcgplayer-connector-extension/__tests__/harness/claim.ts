import { createHash } from "node:crypto";
import type { ConnectorTransportServices } from "@chase-sets/channels/server";
import { syntheticExportHeader } from "./origins";

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

/** A labelled synthetic live-export claim; sorted keys make JSON.stringify the producer's canonical JSON. */
export function syntheticLiveExportClaim(
  now = Date.now(),
  identity: Readonly<{
    attemptId?: string;
    claimGeneration?: number;
    reservationId?: string;
    scheduleGeneration?: number;
  }> = {},
): Claim {
  const header = createHash("sha256").update(syntheticExportHeader.join("\n")).digest("hex");
  const scheduleGeneration = identity.scheduleGeneration ?? 1;
  const exportId = `cxpl_${createHash("sha1").update(`synthetic-9288-export-${scheduleGeneration}`).digest("hex")}`;
  const payload = {
    bounds: { budgetMs: 110000, fetchTimeoutMs: 60000, postTimeoutMs: 10000, reportTimeoutMs: 10000 },
    connectionId: "connection_synthetic",
    exportId,
    kind: "live-export",
    limits: { maxBytes: 1048576, maxRecords: 1000 },
    parserProfile: { headerSha256: header, id: "tcgplayer-live-export/v1" },
    scheduleGeneration,
    version: 1,
  } as const;
  const at = new Date(now).toISOString();
  return {
    reservationId: identity.reservationId ?? `synthetic-live-export-reservation-${scheduleGeneration}`,
    connectionId: "connection_synthetic",
    providerIdentity: { providerKey: "tcgplayer", environment: "sandbox" },
    claimant: { claimantKind: "connector", claimantId: "synthetic-pairing" },
    reservedAt: at,
    leaseExpiresAt: new Date(now + 1800000).toISOString(),
    operations: [
      {
        operationId: `synthetic-live-export-operation-${scheduleGeneration}`,
        attemptId: identity.attemptId ?? "synthetic-live-export-attempt",
        claimGeneration: identity.claimGeneration ?? 1,
        connectionId: "connection_synthetic",
        providerIdentity: { providerKey: "tcgplayer", environment: "sandbox" },
        subject: { kind: "connection", connectionId: "connection_synthetic" },
        operationKind: "tcgplayer-live-export",
        exportId,
        scheduleGeneration,
        payload,
        payloadDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        enqueuedAt: at,
      },
    ],
  };
}
