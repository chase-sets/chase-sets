import { createHash, randomUUID } from "node:crypto";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { ConnectorPairingError } from "../../connector-feed/domain/contracts";
import type { ConnectorInbound } from "../../connector-feed/domain/transport";
import { composeTcgplayerOrderInbound, type TcgplayerOrderObservation } from "../../tcgplayer-orders/domain/contracts";
import {
  OutboundSyncError,
  type ClaimedOperationClaimant,
  type ClaimedOperationReservation,
  type ClaimedOrderPullOperation,
  type ClaimedSubjectOutcome,
} from "../domain/contracts";
import {
  isClaimedOrderPullOutcome,
  assertOrderPullPayload,
  canaryDispatchDeadlineMs,
  canaryOrderPullBounds,
  deriveOrderPullOperationId,
  orderPullFitsLease,
  orderPullOperationKind,
  type OrderPullPayload,
} from "../domain/order-pull";
import { orderPullCheckpointDigest } from "../domain/order-pull-progress";
import {
  assertCanaryHandoff,
  canaryAuthority,
  canaryReservationPrefix,
  type CanaryHandoff,
} from "../domain/ready-to-ship-canary";
import type { ChannelProviderIdentity } from "../../publication-port/domain/contracts";
import { payloadDigest } from "./payload-digest";

type Fences = Readonly<{ connectionId: string; pairingId: string; grantId: string }>;
type ClaimRow = Readonly<{
  page_claim: string;
  connection_id: string;
  pairing_id: string;
  grant_id: string;
  state: string;
  expires_at: Date | string;
  members: string[];
  admitted: string[];
  operation_id: string;
  attempt_id: string;
  pull_id: string;
  payload_digest: string;
}>;

export async function armReadyToShipCanary(
  db: PgQueryable,
  fence: Fences,
  handoff: CanaryHandoff,
  at: string,
): Promise<void> {
  if (at < handoff.finishedAt || at >= handoff.expiresAt) throw new ConnectorPairingError("authorization-refused");
  const members = await Promise.all(
    handoff.sales.map(async (sale) => (await composeTcgplayerOrderInbound(sale)).externalReference),
  );
  await db.query(
    `UPDATE channel_ready_to_ship_canaries SET state='expired', handoff=NULL
     WHERE connection_id=$1 AND state IN ('armed','claimed') AND expires_at <= $2`,
    [fence.connectionId, at],
  );
  const inserted = await db.query(
    `INSERT INTO channel_ready_to_ship_canaries
     (page_claim,seal_digest,connection_id,pairing_id,grant_id,state,expires_at,handoff,members)
     VALUES ($1,$2,$3,$4,$5,'armed',$6,$7::jsonb,$8) ON CONFLICT DO NOTHING RETURNING page_claim`,
    [
      handoff.pageClaim,
      handoff.sealDigest,
      fence.connectionId,
      fence.pairingId,
      fence.grantId,
      handoff.expiresAt,
      JSON.stringify(handoff),
      members,
    ],
  );
  if (!inserted.rows.length) throw new ConnectorPairingError("conflict");
}

export async function reserveReadyToShipCanary(
  db: PgQueryable,
  input: Readonly<{
    connectionId: string;
    claimant: ClaimedOperationClaimant;
    grantId: string;
    providerIdentity: ChannelProviderIdentity;
    reservedAt: string;
    leaseExpiresAt: string;
  }>,
): Promise<ClaimedOperationReservation<ClaimedOrderPullOperation> | null> {
  if (input.providerIdentity.providerKey !== "tcgplayer" || input.claimant.claimantKind !== "connector") return null;
  const selected = await db.query<{ handoff: unknown }>(
    `SELECT canary.handoff FROM channel_ready_to_ship_canaries AS canary
     JOIN channel_connector_pairings AS pairing
       ON pairing.pairing_id=canary.pairing_id AND pairing.connection_id=canary.connection_id
       AND pairing.state='paired' AND pairing.grant_id=canary.grant_id
     WHERE canary.connection_id=$1 AND canary.pairing_id=$2 AND canary.grant_id=$3
       AND canary.state='armed' AND canary.expires_at>$4 FOR UPDATE OF canary`,
    [input.connectionId, input.claimant.claimantId, input.grantId, input.reservedAt],
  );
  if (!selected.rows.length) return null;
  const handoff = selected.rows[0]!.handoff;
  assertCanaryHandoff(handoff);
  const leaseExpiresAt = input.leaseExpiresAt < handoff.expiresAt ? input.leaseExpiresAt : handoff.expiresAt;
  if (!orderPullFitsLease({ budgetMs: canaryDispatchDeadlineMs, at: input.reservedAt, leaseExpiresAt })) return null;
  const pullId = `copl_${createHash("sha256").update(`ready-to-ship-canary:${handoff.pageClaim}`).digest("hex").slice(0, 40)}`;
  const checkpoint = {
    burstId: pullId,
    policyRevision: canaryAuthority.revision,
    selector: canaryAuthority.selector,
    traversal: null,
    gapCount: 0,
    drained: false,
    followUpTail: false,
  };
  const payload: OrderPullPayload = {
    kind: "order-pull",
    version: 2,
    connectionId: input.connectionId,
    pullId,
    policyRevision: canaryAuthority.revision,
    lawVersion: canaryAuthority.lawVersion,
    selector: canaryAuthority.selector,
    bounds: canaryOrderPullBounds(handoff.sales.length),
    followUpReferences: [],
    checkpoint,
    checkpointDigest: orderPullCheckpointDigest(checkpoint),
    work: {
      chunkId: 1,
      references: handoff.sales.map((sale) => sale.orderNumber),
      postedReferences: [],
      acceptedReferences: [],
    },
    predecessor: null,
    providerNotBefore: input.reservedAt,
    canary: handoff,
  };
  assertOrderPullPayload(payload);
  const reservationId = `${canaryReservationPrefix}${randomUUID()}`;
  const operationId = deriveOrderPullOperationId(input.connectionId, pullId);
  const attemptId = `coa_${randomUUID()}`;
  const digest = payloadDigest(payload);
  const updated = await db.query(
    `UPDATE channel_ready_to_ship_canaries SET state='claimed', handoff=NULL, expires_at=$2,
       reservation_id=$3, operation_id=$4, attempt_id=$5, pull_id=$6, payload_digest=$7
     WHERE page_claim=$1 AND state='armed' RETURNING page_claim`,
    [handoff.pageClaim, leaseExpiresAt, reservationId, operationId, attemptId, pullId, digest],
  );
  if (!updated.rows.length) throw new OutboundSyncError("stale-fence");
  return {
    reservationId,
    connectionId: input.connectionId,
    providerIdentity: input.providerIdentity,
    claimant: input.claimant,
    reservedAt: input.reservedAt,
    leaseExpiresAt,
    operations: [
      {
        operationId,
        attemptId,
        claimGeneration: 1,
        connectionId: input.connectionId,
        providerIdentity: input.providerIdentity,
        subject: { kind: "connection", connectionId: input.connectionId },
        operationKind: orderPullOperationKind,
        pullId,
        scheduleGeneration: 1,
        payload,
        payloadDigest: digest,
        enqueuedAt: input.reservedAt,
      },
    ],
  };
}

async function lockClaim(db: PgQueryable, reservationId: string) {
  const result = await db.query<ClaimRow>(
    `SELECT page_claim,connection_id,pairing_id,grant_id,state,expires_at,members,admitted,
      operation_id,attempt_id,pull_id,payload_digest FROM channel_ready_to_ship_canaries
      WHERE reservation_id=$1 FOR UPDATE`,
    [reservationId],
  );
  return result.rows[0];
}

export async function admitReadyToShipCanaryMember(
  db: PgQueryable,
  fence: Fences,
  reservationId: string,
  pageClaim: string,
  sale: TcgplayerOrderObservation,
  inbound: ConnectorInbound,
  now: () => Date,
): Promise<Readonly<{ receivedAt: string; expiresAt: string }>> {
  const expectedReference = (await composeTcgplayerOrderInbound(sale)).externalReference;
  const row = await lockClaim(db, reservationId);
  const at = now().toISOString();
  if (
    !row ||
    row.state !== "claimed" ||
    row.page_claim !== pageClaim ||
    row.connection_id !== fence.connectionId ||
    row.pairing_id !== fence.pairingId ||
    row.grant_id !== fence.grantId ||
    Date.parse(at) >= new Date(row.expires_at).getTime() ||
    expectedReference !== inbound.externalReference ||
    !row.members.includes(inbound.externalReference)
  )
    throw new ConnectorPairingError("authorization-refused");
  if (!row.admitted.includes(inbound.externalReference))
    await db.query("UPDATE channel_ready_to_ship_canaries SET admitted=array_append(admitted,$2) WHERE page_claim=$1", [
      pageClaim,
      inbound.externalReference,
    ]);
  return { receivedAt: at, expiresAt: new Date(row.expires_at).toISOString() };
}

export async function settleReadyToShipCanary(
  db: PgQueryable,
  input: Readonly<{
    reservationId: string;
    claimant: ClaimedOperationClaimant;
    outcomes: readonly ClaimedSubjectOutcome[];
  }>,
  now: () => string,
): Promise<string | null> {
  const row = await lockClaim(db, input.reservationId);
  if (!row || row.state !== "claimed") return null;
  const report = input.outcomes[0];
  if (
    input.outcomes.length !== 1 ||
    !report ||
    !isClaimedOrderPullOutcome(report) ||
    input.claimant.claimantKind !== "connector" ||
    input.claimant.claimantId !== row.pairing_id ||
    report.operationId !== row.operation_id ||
    report.attemptId !== row.attempt_id ||
    report.claimGeneration !== 1 ||
    report.pullId !== row.pull_id ||
    report.payloadDigest !== row.payload_digest
  )
    throw new OutboundSyncError("reservation-membership-mismatch");
  const at = now();
  if (Date.parse(at) >= new Date(row.expires_at).getTime()) throw new OutboundSyncError("reservation-expired");
  const posted = report.outcome.kind === "canary-posted";
  if (
    posted
      ? row.members.length !== row.admitted.length
      : report.outcome.kind !== "order-pull-unknown" && report.outcome.kind !== "abandoned"
  )
    throw new OutboundSyncError("invalid-input");
  await db.query("UPDATE channel_ready_to_ship_canaries SET state=$2 WHERE page_claim=$1", [
    row.page_claim,
    posted ? "posted" : "failed",
  ]);
  return at;
}

export async function expireReadyToShipCanaries(db: PgQueryable, at: string): Promise<number> {
  const result = await db.query(
    `UPDATE channel_ready_to_ship_canaries SET state='expired', handoff=NULL WHERE page_claim IN (
       SELECT page_claim FROM channel_ready_to_ship_canaries
       WHERE state IN ('armed','claimed') AND expires_at <= $1
       ORDER BY expires_at,page_claim LIMIT 100 FOR UPDATE SKIP LOCKED
     )`,
    [at],
  );
  return Number(result.rowCount ?? 0);
}
