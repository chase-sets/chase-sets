import { createHash } from "node:crypto";
import type { ChaseSetsEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import {
  createTransactionalProjectorHandlerMap,
  defineProjectorHandlers,
  type ProjectorHandlerMap,
} from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { centsToMoneyAmount } from "@chase-sets/primitives/money";
import type { AccountId, LedgerEntryId, OrderId } from "@chase-sets/primitives/typed-ids";
import type { WalletServices } from "../../api/runtime";
import { SettlementDomainError } from "../../../../support/runtime-support/common";
import { marketplaceLabelPostagePolicy, type MarketplaceLabelPostagePolicyValue } from "./label-postage-policy";

type FulfillmentSourceProjectionDeps = Readonly<{
  wallets: Pick<WalletServices, "loadWalletState" | "postEntry">;
  policies: Pick<PolicyRuntime, "resolvePolicy">;
}>;

type ShipmentSourceRow = Readonly<{
  order_id: string;
  seller_account_id: string;
}>;

type LabelPostageRow = Readonly<{
  shipment_id: string;
  label_identity: string;
  postage_provider_label_id: string | null;
  source_event_id: string;
  order_id: string;
  seller_account_id: string;
  postage_amount_cents: number | null;
  postage_currency: string | null;
  outcome: MarketplaceLabelPostageOutcome;
  debit_ledger_entry_id: string | null;
  refund_ledger_entry_id: string | null;
  refund_reference: string | null;
  refund_status: string | null;
  policy_version: string;
  source_recorded_at: string;
  label_attached_at: string;
  voided_at: string | null;
  refunded_at: string | null;
  last_stream_version: number;
}>;

export type MarketplaceLabelPostageOutcome =
  | "debit-posted"
  | "skipped-historical"
  | "skipped-null-amount"
  | "refused-currency-mismatch"
  | "refused-invalid-amount"
  | "refused-missing-provider-label-id";

export type MarketplaceLabelPostageDebitDecision =
  | Readonly<{ kind: "post"; amount: string; currencyCode: "usd" }>
  | Readonly<{ kind: "skip"; reason: "historical" | "null-amount" }>
  | Readonly<{
      kind: "refuse";
      reason: "currency-mismatch" | "invalid-amount" | "missing-provider-label-id";
    }>;

type LabelAttachedData = ChaseSetsEventPayloads["fulfillment.shipment.label-attached"];

type LabelVoidedData = Readonly<{
  shipmentId: string;
  refundStatus: string;
  refundReference: string | null;
  voidedAt: string;
}>;

type LabelRefundStatusData = Readonly<{
  shipmentId: string;
  refundStatus: string;
  refundReference: string | null;
  resolvedAt: string;
}>;

function stableLedgerEntryId(kind: "debit" | "refund", shipmentId: string, providerLabelId: string): LedgerEntryId {
  const digest = createHash("sha256")
    .update(`${shipmentId}\u0000${providerLabelId}`, "utf8")
    .digest("hex")
    .slice(0, 26);
  return `led_postage_${kind}_${digest}` as LedgerEntryId;
}

function eventContext(event: TransportEvent) {
  return { tenantId: event.tenantId, audit: event.audit, trace: event.trace };
}

function normalizedFactCurrency(currency: string | null): string | null {
  const normalized = currency?.trim().toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function decideMarketplaceLabelPostageDebit(
  input: Readonly<{
    factRecordedAt: string;
    providerLabelId: string | null;
    postageAmountCents: number | null;
    postageCurrency: string | null;
    walletCurrency: string;
    policy: MarketplaceLabelPostagePolicyValue;
  }>,
): MarketplaceLabelPostageDebitDecision {
  if (Date.parse(input.factRecordedAt) < Date.parse(input.policy.cutoverRecordedAt)) {
    return { kind: "skip", reason: "historical" };
  }
  if (input.postageAmountCents === null) {
    return { kind: "skip", reason: "null-amount" };
  }
  if (!input.providerLabelId?.trim()) {
    return { kind: "refuse", reason: "missing-provider-label-id" };
  }
  if (!Number.isSafeInteger(input.postageAmountCents) || input.postageAmountCents <= 0) {
    return { kind: "refuse", reason: "invalid-amount" };
  }

  const factCurrency = normalizedFactCurrency(input.postageCurrency);
  if (factCurrency !== input.walletCurrency) {
    return { kind: "refuse", reason: "currency-mismatch" };
  }

  return { kind: "post", amount: centsToMoneyAmount(input.postageAmountCents), currencyCode: "usd" };
}

function outcomeForDecision(decision: MarketplaceLabelPostageDebitDecision): MarketplaceLabelPostageOutcome {
  if (decision.kind === "post") return "debit-posted";
  if (decision.kind === "skip") {
    return decision.reason === "historical" ? "skipped-historical" : "skipped-null-amount";
  }
  switch (decision.reason) {
    case "currency-mismatch":
      return "refused-currency-mismatch";
    case "invalid-amount":
      return "refused-invalid-amount";
    case "missing-provider-label-id":
      return "refused-missing-provider-label-id";
  }
}

function decisionNeedsOperatorReview(decision: MarketplaceLabelPostageDebitDecision): boolean {
  return decision.kind === "refuse";
}

function decisionReason(decision: MarketplaceLabelPostageDebitDecision): string | null {
  return decision.kind === "post" ? null : decision.reason;
}

async function assertExistingWalletEntryMatches(
  wallets: FulfillmentSourceProjectionDeps["wallets"],
  expected: Readonly<{
    accountId: AccountId;
    ledgerEntryId: LedgerEntryId;
    direction: "credit" | "debit";
    amount: string;
    currencyCode: "usd";
    orderId: OrderId;
  }>,
): Promise<void> {
  const wallet = await wallets.loadWalletState(expected.accountId);
  const entry = wallet.entries.find((candidate) => candidate.ledgerEntryId === expected.ledgerEntryId);
  if (
    !entry ||
    entry.kind !== "platform-purchase" ||
    entry.direction !== expected.direction ||
    entry.amount !== expected.amount ||
    entry.currencyCode !== expected.currencyCode ||
    entry.fundsStatus !== "available" ||
    entry.orderId !== expected.orderId
  ) {
    throw new SettlementDomainError("Existing marketplace label postage ledger entry conflicts with the fact.");
  }
}

async function postWalletEntryExactlyOnce(
  wallets: FulfillmentSourceProjectionDeps["wallets"],
  params: Parameters<WalletServices["postEntry"]>[0],
  context: Parameters<WalletServices["postEntry"]>[1],
): Promise<void> {
  try {
    await wallets.postEntry(params, context);
  } catch (error) {
    if (!(error instanceof SettlementDomainError) || error.message !== "Ledger entry has already been posted.") {
      throw error;
    }
    await assertExistingWalletEntryMatches(wallets, {
      accountId: params.accountId,
      ledgerEntryId: params.ledgerEntryId,
      direction: params.direction,
      amount: params.amount,
      currencyCode: params.currencyCode ?? "usd",
      orderId: params.orderId!,
    });
  }
}

async function loadShipmentSource(db: PgQueryable, shipmentId: string): Promise<ShipmentSourceRow> {
  const result = await db.query<ShipmentSourceRow>(
    `SELECT order_id, seller_account_id
     FROM settlement_order_fulfillment_sources
     WHERE shipment_id = $1`,
    [shipmentId],
  );
  const source = result.rows[0];
  if (!source) {
    throw new SettlementDomainError("Marketplace label postage is missing its shipment source.");
  }
  return source;
}

function sameLabelFact(
  row: LabelPostageRow,
  input: Readonly<{
    orderId: string;
    sellerAccountId: string;
    amountCents: number | null;
    currency: string | null;
    outcome: MarketplaceLabelPostageOutcome;
    policyVersion: string;
  }>,
): boolean {
  return (
    row.order_id === input.orderId &&
    row.seller_account_id === input.sellerAccountId &&
    row.postage_amount_cents === input.amountCents &&
    row.postage_currency === input.currency &&
    row.outcome === input.outcome &&
    row.policy_version === input.policyVersion
  );
}

async function recordLabelAttached(
  db: PgQueryable,
  deps: FulfillmentSourceProjectionDeps,
  event: TransportEvent,
): Promise<void> {
  const data = event.data as LabelAttachedData;
  const source = await loadShipmentSource(db, data.shipmentId);
  const policy = await deps.policies.resolvePolicy(marketplaceLabelPostagePolicy, { at: event.timing.recordedAt });
  const providerLabelId = data.postageProviderLabelId?.trim() || null;
  const currency = normalizedFactCurrency(data.postageCurrency);
  const needsWalletCurrency =
    Date.parse(event.timing.recordedAt) >= Date.parse(policy.value.cutoverRecordedAt) &&
    data.postageAmountCents !== null &&
    Number.isSafeInteger(data.postageAmountCents) &&
    data.postageAmountCents > 0 &&
    providerLabelId !== null;
  const walletCurrency = needsWalletCurrency
    ? ((await deps.wallets.loadWalletState(source.seller_account_id as AccountId)).currencyCode ?? "usd")
    : "usd";
  const decision = decideMarketplaceLabelPostageDebit({
    factRecordedAt: event.timing.recordedAt,
    providerLabelId,
    postageAmountCents: data.postageAmountCents,
    postageCurrency: currency,
    walletCurrency,
    policy: policy.value,
  });
  const outcome = outcomeForDecision(decision);
  const labelIdentity = providerLabelId ? `provider:${providerLabelId}` : `event:${event.id}`;
  const debitLedgerEntryId =
    decision.kind === "post" ? stableLedgerEntryId("debit", data.shipmentId, providerLabelId!) : null;

  const inserted = await db.query(
    `INSERT INTO settlement_marketplace_label_postage (
       shipment_id, label_identity, postage_provider_label_id, source_event_id,
       order_id, seller_account_id, postage_amount_cents, postage_currency,
       outcome, refusal_reason, operator_review_required, debit_ledger_entry_id,
       refund_ledger_entry_id, refund_reference, refund_status, policy_version,
       source_recorded_at, label_attached_at, voided_at, refunded_at,
       last_stream_version, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       NULL, NULL, NULL, $13, $14, $15, NULL, NULL, $16, $15
     )
     ON CONFLICT DO NOTHING
     RETURNING shipment_id`,
    [
      data.shipmentId,
      labelIdentity,
      providerLabelId,
      event.id,
      source.order_id,
      source.seller_account_id,
      data.postageAmountCents,
      currency,
      outcome,
      decisionReason(decision),
      decisionNeedsOperatorReview(decision),
      debitLedgerEntryId,
      policy.value.policyVersion,
      event.timing.recordedAt,
      data.attachedAt,
      event.streamVersion,
    ],
  );

  if ((inserted.rowCount ?? inserted.rows.length) === 0) {
    const existingResult = await db.query<LabelPostageRow>(
      `SELECT * FROM settlement_marketplace_label_postage
       WHERE (shipment_id = $1 AND label_identity = $2) OR source_event_id = $3
       FOR UPDATE`,
      [data.shipmentId, labelIdentity, event.id],
    );
    const existing = existingResult.rows[0];
    if (
      !existing ||
      !sameLabelFact(existing, {
        orderId: source.order_id,
        sellerAccountId: source.seller_account_id,
        amountCents: data.postageAmountCents,
        currency,
        outcome,
        policyVersion: policy.value.policyVersion,
      })
    ) {
      if (existing) {
        await db.query(
          `UPDATE settlement_marketplace_label_postage
           SET operator_review_required = true,
               refusal_reason = 'conflicting-label-fact',
               last_stream_version = $3,
               updated_at = $4
           WHERE shipment_id = $1
             AND label_identity = $2
             AND last_stream_version < $3`,
          [existing.shipment_id, existing.label_identity, event.streamVersion, event.timing.recordedAt],
        );
        return;
      }
      throw new SettlementDomainError("Marketplace label postage fact conflicts with the recorded label identity.");
    }
    return;
  }

  if (decision.kind !== "post") {
    return;
  }

  await postWalletEntryExactlyOnce(
    deps.wallets,
    {
      accountId: source.seller_account_id as AccountId,
      ledgerEntryId: debitLedgerEntryId!,
      kind: "platform-purchase",
      direction: "debit",
      amount: decision.amount,
      currencyCode: decision.currencyCode,
      fundsStatus: "available",
      orderId: source.order_id as OrderId,
      description: `Marketplace label postage for shipment ${data.shipmentId}`,
      postedAt: data.attachedAt,
      allowNegativeBalance: true,
    },
    eventContext(event),
  );
}

async function recordLabelVoided(db: PgQueryable, event: TransportEvent): Promise<void> {
  const data = event.data as LabelVoidedData;
  const selected = await db.query<LabelPostageRow>(
    `SELECT * FROM settlement_marketplace_label_postage
     WHERE shipment_id = $1
       AND voided_at IS NULL
     ORDER BY label_attached_at DESC, label_identity DESC
     LIMIT 1
     FOR UPDATE`,
    [data.shipmentId],
  );
  const label = selected.rows[0];
  if (!label) return;

  await db.query(
    `UPDATE settlement_marketplace_label_postage
     SET refund_reference = $3,
         refund_status = $4,
         voided_at = $5,
         last_stream_version = $6,
         updated_at = $5
     WHERE shipment_id = $1
       AND label_identity = $2
       AND last_stream_version < $6`,
    [
      label.shipment_id,
      label.label_identity,
      data.refundReference,
      data.refundStatus.trim().toLowerCase(),
      data.voidedAt,
      event.streamVersion,
    ],
  );
}

async function recordLabelRefundStatus(
  db: PgQueryable,
  deps: FulfillmentSourceProjectionDeps,
  event: TransportEvent,
): Promise<void> {
  const data = event.data as LabelRefundStatusData;
  const refundStatus = data.refundStatus.trim().toLowerCase();
  const selected = await db.query<LabelPostageRow>(
    `SELECT * FROM settlement_marketplace_label_postage
     WHERE shipment_id = $1
       AND voided_at IS NOT NULL
       AND ($2::text IS NULL OR refund_reference = $2)
     ORDER BY
       CASE WHEN refund_reference = $2 THEN 0 ELSE 1 END,
       voided_at DESC,
       label_identity DESC
     LIMIT 1
     FOR UPDATE`,
    [data.shipmentId, data.refundReference],
  );
  const label = selected.rows[0];
  if (!label) {
    if (refundStatus === "refunded") {
      throw new SettlementDomainError("Refunded marketplace label postage is missing its recorded void linkage.");
    }
    return;
  }

  if (label.refund_ledger_entry_id !== null) {
    if (
      refundStatus !== "refunded" ||
      label.outcome !== "debit-posted" ||
      !label.postage_provider_label_id ||
      label.postage_amount_cents === null ||
      label.postage_currency !== "usd"
    ) {
      throw new SettlementDomainError("Marketplace label refund status conflicts with the linked refund entry.");
    }
    const expectedRefundLedgerEntryId = stableLedgerEntryId(
      "refund",
      label.shipment_id,
      label.postage_provider_label_id,
    );
    if (label.refund_ledger_entry_id !== expectedRefundLedgerEntryId) {
      throw new SettlementDomainError("Marketplace label refund linkage conflicts with its deterministic identity.");
    }
    await assertExistingWalletEntryMatches(deps.wallets, {
      accountId: label.seller_account_id as AccountId,
      ledgerEntryId: expectedRefundLedgerEntryId,
      direction: "credit",
      amount: centsToMoneyAmount(label.postage_amount_cents),
      currencyCode: "usd",
      orderId: label.order_id as OrderId,
    });
    await db.query(
      `UPDATE settlement_marketplace_label_postage
       SET last_stream_version = $3,
           updated_at = $4
       WHERE shipment_id = $1
         AND label_identity = $2
         AND last_stream_version < $3`,
      [label.shipment_id, label.label_identity, event.streamVersion, data.resolvedAt],
    );
    return;
  }

  if (refundStatus !== "refunded" || label.outcome !== "debit-posted") {
    await db.query(
      `UPDATE settlement_marketplace_label_postage
       SET refund_status = $3,
           last_stream_version = $4,
           updated_at = $5
       WHERE shipment_id = $1
         AND label_identity = $2
         AND last_stream_version < $4`,
      [label.shipment_id, label.label_identity, refundStatus, event.streamVersion, data.resolvedAt],
    );
    return;
  }

  if (!label.postage_provider_label_id || label.postage_amount_cents === null || label.postage_currency !== "usd") {
    throw new SettlementDomainError("Posted marketplace label postage is missing its immutable refund basis.");
  }

  const refundLedgerEntryId = stableLedgerEntryId("refund", label.shipment_id, label.postage_provider_label_id);
  const amount = centsToMoneyAmount(label.postage_amount_cents);
  await postWalletEntryExactlyOnce(
    deps.wallets,
    {
      accountId: label.seller_account_id as AccountId,
      ledgerEntryId: refundLedgerEntryId,
      kind: "platform-purchase",
      direction: "credit",
      amount,
      currencyCode: "usd",
      fundsStatus: "available",
      orderId: label.order_id as OrderId,
      description: `Refund of marketplace label postage for shipment ${label.shipment_id}; reverses ${label.debit_ledger_entry_id}`,
      postedAt: data.resolvedAt,
    },
    eventContext(event),
  );

  await db.query(
    `UPDATE settlement_marketplace_label_postage
     SET refund_ledger_entry_id = $3,
         refund_reference = COALESCE($4, refund_reference),
         refund_status = 'refunded',
         refunded_at = $5,
         last_stream_version = $6,
         updated_at = $5
     WHERE shipment_id = $1
       AND label_identity = $2
       AND refund_ledger_entry_id IS NULL
       AND last_stream_version < $6`,
    [
      label.shipment_id,
      label.label_identity,
      refundLedgerEntryId,
      data.refundReference,
      data.resolvedAt,
      event.streamVersion,
    ],
  );
}

export function buildSettlementFulfillmentSourceProjectionHandlers(
  db: PgQueryable,
  deps: FulfillmentSourceProjectionDeps,
): ProjectorHandlerMap {
  return {
    ...defineProjectorHandlers<
      Pick<
        ChaseSetsEventPayloads,
        "fulfillment.shipment.created" | "fulfillment.shipment.dispatched" | "fulfillment.shipment.delivered"
      >
    >({
      "fulfillment.shipment.created": async (event) => {
        const { data } = event;

        await db.query(
          `INSERT INTO settlement_order_fulfillment_sources (
           shipment_id,
           order_id,
           buyer_account_id,
           seller_account_id,
           status,
           tracking_identifier,
           created_at,
           updated_at,
           dispatched_at,
           delivered_at,
           returned_at,
           exception_raised_at,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, 'created', $5, $6, $6, NULL, NULL, NULL, NULL, $7)
         ON CONFLICT (shipment_id) DO UPDATE SET
           order_id = EXCLUDED.order_id,
           buyer_account_id = EXCLUDED.buyer_account_id,
           seller_account_id = EXCLUDED.seller_account_id,
           status = EXCLUDED.status,
           tracking_identifier = EXCLUDED.tracking_identifier,
           updated_at = EXCLUDED.updated_at,
           last_stream_version = EXCLUDED.last_stream_version
         WHERE settlement_order_fulfillment_sources.last_stream_version < EXCLUDED.last_stream_version`,
          [
            data.shipmentId,
            data.orderId,
            data.buyerAccountId,
            data.sellerAccountId,
            null,
            data.createdAt,
            event.streamVersion,
          ],
        );
      },
      "fulfillment.shipment.dispatched": async (event) => {
        const { data } = event;
        await db.query(
          `UPDATE settlement_order_fulfillment_sources
         SET status = 'dispatched',
             dispatched_at = $2,
             updated_at = $2,
             last_stream_version = $3
         WHERE shipment_id = $1
           AND last_stream_version < $3`,
          [data.shipmentId, data.dispatchedAt, event.streamVersion],
        );
      },
      "fulfillment.shipment.delivered": async (event) => {
        const { data } = event;
        await db.query(
          `UPDATE settlement_order_fulfillment_sources
         SET status = 'delivered',
             tracking_identifier = COALESCE($2, tracking_identifier),
             delivered_at = $3,
             updated_at = $3,
             last_stream_version = $4
         WHERE shipment_id = $1
           AND last_stream_version < $4`,
          [data.shipmentId, data.trackingIdentifier ?? null, data.deliveredAt, event.streamVersion],
        );
      },
    }),
    "fulfillment.shipment.returned": async (event) => {
      const data = event.data as { shipmentId: string; returnedAt: string };
      await db.query(
        `UPDATE settlement_order_fulfillment_sources
         SET status = 'returned',
             returned_at = $2,
             updated_at = $2,
             last_stream_version = $3
         WHERE shipment_id = $1
           AND last_stream_version < $3`,
        [data.shipmentId, data.returnedAt, event.streamVersion],
      );
    },
    "fulfillment.shipment.exception-raised": async (event) => {
      const data = event.data as { shipmentId: string; raisedAt: string };
      await db.query(
        `UPDATE settlement_order_fulfillment_sources
         SET status = 'exception',
             exception_raised_at = $2,
             updated_at = $2,
             last_stream_version = $3
         WHERE shipment_id = $1
           AND last_stream_version < $3`,
        [data.shipmentId, data.raisedAt, event.streamVersion],
      );
    },
    ...createTransactionalProjectorHandlerMap({
      "fulfillment.shipment.label-attached": async (event, context) =>
        recordLabelAttached(context.db as PgQueryable, deps, event),
      "fulfillment.shipment.label-voided": async (event, context) =>
        recordLabelVoided(context.db as PgQueryable, event),
      "fulfillment.shipment.label-refund-status-recorded": async (event, context) =>
        recordLabelRefundStatus(context.db as PgQueryable, deps, event),
    }),
  };
}
