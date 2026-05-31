import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type PaymentDetailRow = Readonly<{
  payment_id: string;
  buyer_account_id: string;
  order_ids: readonly string[];
  amount: string;
  balance_credit_amount: string;
  processor_amount: string;
  marketplace_sales_fee_amount: string;
  marketplace_checkout_fee_amount: string;
  marketplace_checkout_fee_policy_version: string | null;
  marketplace_checkout_fee_quote_fingerprint: string | null;
  payment_method_category: string | null;
  saved_checkout_instrument_id: string | null;
  seller_net_amount: string;
  seller_payout_amount: string;
  seller_payouts: readonly {
    orderId: string;
    sellerAccountId: string;
    sellerItemNetAmount: string;
    shippingAllowanceAmount: string;
    sellerShippingPayoutAmount: string;
    sellerPayoutAmount: string;
  }[];
  currency_code: string;
  processor_name: string;
  processor_payment_kind: "checkout-session" | "payment-intent" | "balance-credit";
  processor_payment_reference: string;
  processor_client_secret: string | null;
  processor_redirect_url: string | null;
  processor_status: string;
  source_context: string | null;
  source_reference_id: string | null;
  status: string;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
  captured_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
}>;

export type PaymentProviderEventRow = Readonly<{
  provider_event_id: string;
  provider_name: string;
  event_kind: string;
  provider_object_reference: string | null;
  received_at: string;
}>;

export type SavedCheckoutInstrumentRow = Readonly<{
  instrument_id: string;
  account_id: string;
  payment_method_category: "card" | "bank-account" | "platform-credit";
  provider: string;
  provider_reference: string;
  display_label: string;
  confirmation_experience: "trusted-payment-step" | "off-session-token";
  is_default: boolean;
  readiness: "ready" | "setup-required";
  created_at: string;
  updated_at: string;
}>;

export type PaymentProviderIdempotencyKeyRow = Readonly<{
  operation_key: string;
  provider_name: string;
  operation_kind: string;
  account_id: string | null;
  provider_object_reference: string | null;
  idempotency_key: string;
  created_at: string;
}>;

export type PaymentReconciliationRunRow = Readonly<{
  reconciliation_run_id: string;
  kind: string;
  checked_count: number;
  attention_count: number;
  status: string;
  summary: unknown;
  started_at: string;
  completed_at: string;
}>;

type PaymentPageRow = Omit<PaymentDetailRow, "order_ids" | "seller_payouts"> &
  Readonly<{
    order_ids: unknown;
    seller_payouts: unknown;
  }>;

function mapPaymentRow(row: PaymentPageRow): PaymentDetailRow {
  return {
    ...row,
    amount: String(row.amount),
    order_ids: Array.isArray(row.order_ids)
      ? row.order_ids.filter((value): value is string => typeof value === "string")
      : [],
    seller_payouts: Array.isArray(row.seller_payouts)
      ? row.seller_payouts.filter(
          (value): value is PaymentDetailRow["seller_payouts"][number] =>
            Boolean(value) &&
            typeof value === "object" &&
            typeof (value as { orderId?: unknown }).orderId === "string" &&
            typeof (value as { sellerAccountId?: unknown }).sellerAccountId === "string",
        )
      : [],
  };
}

const paymentSelect = `
  SELECT
    payment_id,
    buyer_account_id,
    order_ids,
    amount::text AS amount,
    balance_credit_amount::text AS balance_credit_amount,
    processor_amount::text AS processor_amount,
    marketplace_sales_fee_amount::text AS marketplace_sales_fee_amount,
    marketplace_checkout_fee_amount::text AS marketplace_checkout_fee_amount,
    marketplace_checkout_fee_policy_version,
    marketplace_checkout_fee_quote_fingerprint,
    payment_method_category,
    saved_checkout_instrument_id,
    seller_net_amount::text AS seller_net_amount,
    seller_payout_amount::text AS seller_payout_amount,
    seller_payouts,
    currency_code,
    processor_name,
    processor_payment_kind,
    processor_payment_reference,
    processor_client_secret,
    processor_redirect_url,
    processor_status,
    source_context,
    source_reference_id,
    status,
    failure_code,
    failure_message,
    created_at,
    updated_at,
    captured_at,
    failed_at,
    cancelled_at
  FROM payments_payment_pages
`;

export async function getAccountPayment(
  db: PgQueryable,
  paymentId: string,
  buyerAccountId: string,
): Promise<PaymentDetailRow | null> {
  const result = await db.query<PaymentPageRow>(
    `${paymentSelect}
     WHERE payment_id = $1
       AND buyer_account_id = $2`,
    [paymentId, buyerAccountId],
  );

  const row = result.rows[0];
  return row ? mapPaymentRow(row) : null;
}

export async function getPaymentById(db: PgQueryable, paymentId: string): Promise<PaymentDetailRow | null> {
  const result = await db.query<PaymentPageRow>(
    `${paymentSelect}
     WHERE payment_id = $1`,
    [paymentId],
  );

  const row = result.rows[0];
  return row ? mapPaymentRow(row) : null;
}

export async function getCapturedPaymentByOrderId(db: PgQueryable, orderId: string): Promise<PaymentDetailRow | null> {
  const result = await db.query<PaymentPageRow>(
    `${paymentSelect}
     WHERE status = 'captured'
       AND order_ids @> $1::jsonb
     ORDER BY captured_at DESC NULLS LAST, payment_id DESC
     LIMIT 1`,
    [JSON.stringify([orderId])],
  );

  const row = result.rows[0];
  return row ? mapPaymentRow(row) : null;
}

export async function getOrderPaymentInput(
  db: PgQueryable,
  orderId: string,
): Promise<Readonly<{ order_id: string; total_amount: string }> | null> {
  const result = await db.query<{ order_id: string; total_amount: string }>(
    `SELECT order_id, total_amount::text AS total_amount
     FROM payments_order_inputs
     WHERE order_id = $1`,
    [orderId],
  );

  return result.rows[0] ?? null;
}

export async function getPaymentByProcessorReference(
  db: PgQueryable,
  processorName: string,
  processorPaymentReference: string,
): Promise<PaymentDetailRow | null> {
  const result = await db.query<PaymentPageRow>(
    `${paymentSelect}
     WHERE processor_name = $1
       AND processor_payment_reference = $2`,
    [processorName, processorPaymentReference],
  );

  const row = result.rows[0];
  return row ? mapPaymentRow(row) : null;
}

export async function getPaymentBySource(
  db: PgQueryable,
  sourceContext: string,
  sourceReferenceId: string,
  buyerAccountId: string,
): Promise<PaymentDetailRow | null> {
  const result = await db.query<PaymentPageRow>(
    `${paymentSelect}
     WHERE source_context = $1
       AND source_reference_id = $2
       AND buyer_account_id = $3`,
    [sourceContext, sourceReferenceId, buyerAccountId],
  );

  const row = result.rows[0];
  return row ? mapPaymentRow(row) : null;
}

export async function listSavedCheckoutInstruments(
  db: PgQueryable,
  accountId: string,
): Promise<SavedCheckoutInstrumentRow[]> {
  const result = await db.query<SavedCheckoutInstrumentRow>(
    `SELECT
       instrument_id,
       account_id,
       payment_method_category,
       provider,
       provider_reference,
       display_label,
       confirmation_experience,
       is_default,
       readiness,
       created_at,
       updated_at
     FROM payments_saved_checkout_instruments
     WHERE account_id = $1
     ORDER BY is_default DESC, readiness ASC, updated_at DESC, instrument_id ASC`,
    [accountId],
  );

  return result.rows;
}

export async function getSavedCheckoutInstrument(
  db: PgQueryable,
  params: Readonly<{ accountId: string; instrumentId: string }>,
): Promise<SavedCheckoutInstrumentRow | null> {
  const result = await db.query<SavedCheckoutInstrumentRow>(
    `SELECT
       instrument_id,
       account_id,
       payment_method_category,
       provider,
       provider_reference,
       display_label,
       confirmation_experience,
       is_default,
       readiness,
       created_at,
       updated_at
     FROM payments_saved_checkout_instruments
     WHERE account_id = $1
       AND instrument_id = $2`,
    [params.accountId, params.instrumentId],
  );

  return result.rows[0] ?? null;
}

export async function listPaymentProviderEvents(
  db: PgQueryable,
  params: Readonly<{
    providerName: string;
    providerObjectReference: string;
    internalPaymentId?: string | null;
    limit?: number;
  }>,
): Promise<PaymentProviderEventRow[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 25, 100));
  const result = await db.query<PaymentProviderEventRow>(
    `SELECT
       provider_event_id,
       provider_name,
       event_kind,
       provider_object_reference,
       received_at
     FROM payments_provider_webhook_events
     WHERE provider_name = $1
       AND (
         provider_object_reference = $2
         OR provider_object_reference = $3
       )
     ORDER BY received_at ASC, provider_event_id ASC
     LIMIT $4`,
    [
      params.providerName,
      params.providerObjectReference,
      params.internalPaymentId ?? params.providerObjectReference,
      limit,
    ],
  );

  return result.rows;
}

export async function getPaymentProviderEvent(
  db: PgQueryable,
  params: Readonly<{ providerEventId: string; accountId: string }>,
): Promise<PaymentProviderEventRow | null> {
  const result = await db.query<PaymentProviderEventRow>(
    `SELECT
       event.provider_event_id,
       event.provider_name,
       event.event_kind,
       event.provider_object_reference,
       event.received_at
     FROM payments_provider_webhook_events event
     LEFT JOIN payments_payment_pages payment
       ON payment.processor_name = event.provider_name
      AND (
        payment.processor_payment_reference = event.provider_object_reference
        OR payment.payment_id = event.provider_object_reference
      )
     WHERE event.provider_event_id = $1
       AND payment.buyer_account_id = $2`,
    [params.providerEventId, params.accountId],
  );

  return result.rows[0] ?? null;
}

export async function recordPaymentProviderIdempotencyKey(
  db: PgQueryable,
  entry: Readonly<{
    operationKey: string;
    providerName: string;
    operationKind: string;
    accountId?: string | null;
    providerObjectReference?: string | null;
    idempotencyKey: string;
    createdAt?: string;
  }>,
) {
  await db.query(
    `INSERT INTO payments_provider_idempotency_keys (
       operation_key,
       provider_name,
       operation_kind,
       account_id,
       provider_object_reference,
       idempotency_key,
       created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (operation_key) DO UPDATE
     SET provider_name = EXCLUDED.provider_name,
         operation_kind = EXCLUDED.operation_kind,
         account_id = EXCLUDED.account_id,
         provider_object_reference = EXCLUDED.provider_object_reference,
         idempotency_key = EXCLUDED.idempotency_key`,
    [
      entry.operationKey,
      entry.providerName,
      entry.operationKind,
      entry.accountId ?? null,
      entry.providerObjectReference ?? null,
      entry.idempotencyKey,
      entry.createdAt ?? new Date().toISOString(),
    ],
  );
}

export async function recordPaymentProviderOperationPending(
  db: PgQueryable,
  operation: Readonly<{
    operationKey: string;
    providerName: string;
    operationKind: string;
    accountId?: string | null;
    paymentId?: string | null;
    idempotencyKey: string;
    request?: unknown;
    createdAt?: string;
  }>,
) {
  const timestamp = operation.createdAt ?? new Date().toISOString();
  await db.query(
    `INSERT INTO payments_provider_operations (
       operation_key,
       provider_name,
       operation_kind,
       account_id,
       payment_id,
       idempotency_key,
       request_json,
       status,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending', $8, $8)
     ON CONFLICT (operation_key) DO UPDATE
     SET provider_name = EXCLUDED.provider_name,
         operation_kind = EXCLUDED.operation_kind,
         account_id = EXCLUDED.account_id,
         payment_id = EXCLUDED.payment_id,
         idempotency_key = EXCLUDED.idempotency_key,
         request_json = EXCLUDED.request_json,
         updated_at = EXCLUDED.updated_at`,
    [
      operation.operationKey,
      operation.providerName,
      operation.operationKind,
      operation.accountId ?? null,
      operation.paymentId ?? null,
      operation.idempotencyKey,
      JSON.stringify(operation.request ?? {}),
      timestamp,
    ],
  );
}

export async function recordPaymentProviderOperationSucceeded(
  db: PgQueryable,
  operation: Readonly<{
    operationKey: string;
    providerObjectReference: string;
    completedAt?: string;
  }>,
) {
  const timestamp = operation.completedAt ?? new Date().toISOString();
  await db.query(
    `UPDATE payments_provider_operations
     SET status = 'succeeded',
         provider_object_reference = $2,
         error_message = NULL,
         completed_at = $3,
         updated_at = $3
     WHERE operation_key = $1`,
    [operation.operationKey, operation.providerObjectReference, timestamp],
  );
}

export async function recordPaymentProviderOperationFailed(
  db: PgQueryable,
  operation: Readonly<{
    operationKey: string;
    errorMessage: string;
    completedAt?: string;
  }>,
) {
  const timestamp = operation.completedAt ?? new Date().toISOString();
  await db.query(
    `UPDATE payments_provider_operations
     SET status = 'failed',
         error_message = $2,
         completed_at = $3,
         updated_at = $3
     WHERE operation_key = $1
       AND status = 'pending'`,
    [operation.operationKey, operation.errorMessage, timestamp],
  );
}

export async function listPaymentProviderIdempotencyKeys(
  db: PgQueryable,
  params: Readonly<{ accountId: string; limit?: number }>,
): Promise<PaymentProviderIdempotencyKeyRow[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 25, 100));
  const result = await db.query<PaymentProviderIdempotencyKeyRow>(
    `SELECT
       operation_key,
       provider_name,
       operation_kind,
       account_id,
       provider_object_reference,
       idempotency_key,
       created_at
     FROM payments_provider_idempotency_keys
     WHERE account_id = $1
     ORDER BY created_at DESC, operation_key DESC
     LIMIT $2`,
    [params.accountId, limit],
  );

  return result.rows;
}

export async function listPaymentsNeedingReconciliation(
  db: PgQueryable,
  params: Readonly<{ limit?: number; claimOwnerId?: string; claimTtlMs?: number }> = {},
): Promise<PaymentDetailRow[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
  if (params.claimOwnerId) {
    const result = await db.query<PaymentPageRow>(
      `WITH candidates AS (
         SELECT payment_id
         FROM payments_payment_pages
         WHERE (
           status = 'pending-confirmation'
           AND updated_at < NOW() - INTERVAL '15 minutes'
         )
         OR (
           status = 'failed'
           AND processor_payment_kind <> 'balance-credit'
         )
         ORDER BY updated_at ASC, payment_id ASC
         LIMIT $1
       ),
       claimed AS (
         INSERT INTO payments_work_claims (
           work_kind,
           entity_id,
           owner_id,
           claim_expires_at,
           attempts,
           updated_at
         )
         SELECT
           'payment-reconciliation',
           payment_id,
           $2,
           now() + ($3::text || ' milliseconds')::interval,
           1,
           now()
         FROM candidates
         ON CONFLICT (work_kind, entity_id)
         DO UPDATE SET
           owner_id = EXCLUDED.owner_id,
           claim_expires_at = EXCLUDED.claim_expires_at,
           attempts = payments_work_claims.attempts + 1,
           updated_at = EXCLUDED.updated_at
         WHERE payments_work_claims.claim_expires_at <= now()
            OR payments_work_claims.owner_id = EXCLUDED.owner_id
         RETURNING entity_id
       )
       ${paymentSelect}
       WHERE payment_id IN (SELECT entity_id FROM claimed)
       ORDER BY updated_at ASC, payment_id ASC`,
      [limit, params.claimOwnerId, params.claimTtlMs ?? 120_000],
    );

    return result.rows.map(mapPaymentRow);
  }

  const result = await db.query<PaymentPageRow>(
    `${paymentSelect}
     WHERE (
       status = 'pending-confirmation'
       AND updated_at < NOW() - INTERVAL '15 minutes'
     )
     OR (
       status = 'failed'
       AND processor_payment_kind <> 'balance-credit'
     )
     ORDER BY updated_at ASC, payment_id ASC
     LIMIT $1`,
    [limit],
  );

  return result.rows.map(mapPaymentRow);
}

export async function recordPaymentReconciliationRun(
  db: PgQueryable,
  run: Readonly<{
    reconciliationRunId: string;
    kind: string;
    checked: number;
    attention: number;
    status: string;
    summary?: unknown;
    startedAt: string;
    completedAt: string;
  }>,
) {
  await db.query(
    `INSERT INTO payments_reconciliation_runs (
       reconciliation_run_id,
       kind,
       checked_count,
       attention_count,
       status,
       summary,
       started_at,
       completed_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     ON CONFLICT (reconciliation_run_id) DO NOTHING`,
    [
      run.reconciliationRunId,
      run.kind,
      run.checked,
      run.attention,
      run.status,
      JSON.stringify(run.summary ?? {}),
      run.startedAt,
      run.completedAt,
    ],
  );
}

export async function listPaymentReconciliationRuns(
  db: PgQueryable,
  params: Readonly<{ limit?: number }> = {},
): Promise<PaymentReconciliationRunRow[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 25, 100));
  const result = await db.query<PaymentReconciliationRunRow>(
    `SELECT
       reconciliation_run_id,
       kind,
       checked_count,
       attention_count,
       status,
       summary,
       started_at,
       completed_at
     FROM payments_reconciliation_runs
     ORDER BY completed_at DESC, reconciliation_run_id DESC
     LIMIT $1`,
    [limit],
  );

  return result.rows;
}
