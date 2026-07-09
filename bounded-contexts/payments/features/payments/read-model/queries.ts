import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type PaymentDetailRow = Readonly<{
  payment_id: string;
  buyer_account_id: string;
  order_ids: readonly string[];
  order_refund_caps: readonly {
    orderId: string;
    amount: string;
  }[];
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
  three_d_secure_request: "automatic" | "any" | null;
  three_d_secure_reason_codes: readonly string[];
  liability_shift_status: string | null;
  liability_shift_authentication_result: string | null;
  liability_shift_radar_risk_level: string | null;
  liability_shift_recorded_at: string | null;
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
  refunded_at: string | null;
  refunded_amount: string;
  order_refunded_amounts: readonly {
    orderId: string;
    amount: string;
  }[];
  disputed_at: string | null;
}>;

export type PaymentProviderEventRow = Readonly<{
  provider_event_id: string;
  provider_name: string;
  event_kind: string;
  provider_object_reference: string | null;
  received_at: string;
}>;

export type PaymentAccountRiskSourceRow = Readonly<{
  account_id: string;
  manual_payout_review: boolean;
  stripe_fraud_flag: boolean;
  stripe_fraud_flagged_at: string | null;
  stripe_fraud_signal_count: number;
  stripe_review_open_count: number;
  updated_at: string;
}>;

export type SavedCheckoutInstrumentRow = Readonly<{
  instrument_id: string;
  account_id: string;
  agent_grant_id: string | null;
  payment_method_category: "card" | "bank-account" | "platform-credit";
  provider: string;
  provider_customer_reference: string | null;
  provider_reference: string;
  provider_fingerprint?: string | null;
  display_label: string;
  confirmation_experience: "trusted-payment-step" | "off-session-token";
  is_default: boolean;
  readiness: "ready" | "setup-required" | "removed";
  allow_redisplay: "always" | "limited" | "unspecified";
  consent_id: string | null;
  consent_text: string | null;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
}>;

export type ProviderCustomerRow = Readonly<{
  account_id: string;
  provider: string;
  provider_customer_reference: string;
  display_name: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
}>;

export type SavedCheckoutSetupSessionRow = Readonly<{
  setup_reference_id: string;
  account_id: string;
  agent_grant_id: string | null;
  provider: string;
  provider_customer_reference: string;
  processor_setup_reference: string;
  processor_client_secret: string | null;
  processor_redirect_url: string | null;
  processor_status: string;
  consent_id: string;
  consent_text: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
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

export type PaymentCreationReservationRow = Readonly<{
  payment_id: string;
  buyer_account_id: string;
  order_set_key: string;
  order_ids: readonly string[];
  source_context: string | null;
  source_reference_id: string | null;
  status: "active" | "failed" | "released";
  created_at: string;
  updated_at: string;
}>;

type PaymentCreationReservationRawRow = Omit<PaymentCreationReservationRow, "order_ids"> &
  Readonly<{ order_ids: unknown }>;

export type PaymentCreationReservationResult = Readonly<
  | { outcome: "reserved"; reservation: PaymentCreationReservationRow }
  | { outcome: "same-source"; reservation: PaymentCreationReservationRow }
  | { outcome: "source-conflict"; reservation: PaymentCreationReservationRow }
  | { outcome: "same-order-set"; reservation: PaymentCreationReservationRow }
>;

export type PaymentProviderOperationRow = Readonly<{
  operation_key: string;
  provider_name: string;
  operation_kind: string;
  account_id: string | null;
  payment_id: string | null;
  idempotency_key: string;
  status: "pending" | "succeeded" | "failed";
  provider_object_reference: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}>;

type PaymentPageRow = Omit<
  PaymentDetailRow,
  "order_ids" | "order_refund_caps" | "seller_payouts" | "order_refunded_amounts" | "three_d_secure_reason_codes"
> &
  Readonly<{
    order_ids: unknown;
    order_refund_caps: unknown;
    seller_payouts: unknown;
    order_refunded_amounts: unknown;
    three_d_secure_reason_codes: unknown;
  }>;

function mapOrderMoneyAmounts(value: unknown): PaymentDetailRow["order_refund_caps"] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is PaymentDetailRow["order_refund_caps"][number] =>
          Boolean(entry) &&
          typeof entry === "object" &&
          typeof (entry as { orderId?: unknown }).orderId === "string" &&
          typeof (entry as { amount?: unknown }).amount === "string",
      )
    : [];
}

function mapPaymentRow(row: PaymentPageRow): PaymentDetailRow {
  return {
    ...row,
    amount: String(row.amount),
    refunded_amount: String(row.refunded_amount),
    order_ids: Array.isArray(row.order_ids)
      ? row.order_ids.filter((value): value is string => typeof value === "string")
      : [],
    order_refund_caps: mapOrderMoneyAmounts(row.order_refund_caps),
    seller_payouts: Array.isArray(row.seller_payouts)
      ? row.seller_payouts.filter(
          (value): value is PaymentDetailRow["seller_payouts"][number] =>
            Boolean(value) &&
            typeof value === "object" &&
            typeof (value as { orderId?: unknown }).orderId === "string" &&
            typeof (value as { sellerAccountId?: unknown }).sellerAccountId === "string",
        )
      : [],
    order_refunded_amounts: mapOrderMoneyAmounts(row.order_refunded_amounts),
    three_d_secure_reason_codes: Array.isArray(row.three_d_secure_reason_codes)
      ? row.three_d_secure_reason_codes.filter((value): value is string => typeof value === "string")
      : [],
  };
}

function mapPaymentCreationReservationRow(row: PaymentCreationReservationRawRow): PaymentCreationReservationRow {
  return {
    ...row,
    order_ids: Array.isArray(row.order_ids)
      ? row.order_ids.filter((value): value is string => typeof value === "string")
      : [],
  };
}

export function paymentCreationOrderSetKey(orderIds: readonly string[]) {
  return JSON.stringify([...new Set(orderIds)].sort());
}

const paymentSelect = `
  SELECT
    payment_id,
    buyer_account_id,
    order_ids,
    order_refund_caps,
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
    three_d_secure_request,
    three_d_secure_reason_codes,
    liability_shift_status,
    liability_shift_authentication_result,
    liability_shift_radar_risk_level,
    liability_shift_recorded_at,
    source_context,
    source_reference_id,
    status,
    failure_code,
    failure_message,
    created_at,
    updated_at,
    captured_at,
    failed_at,
    cancelled_at,
    refunded_at,
    refunded_amount::text AS refunded_amount,
    order_refunded_amounts,
    disputed_at
  FROM payments_payment_pages
`;

export async function getPaymentAccountRiskSource(
  db: PgQueryable,
  accountId: string,
): Promise<PaymentAccountRiskSourceRow | null> {
  const result = await db.query<PaymentAccountRiskSourceRow>(
    `SELECT
       account_id,
       manual_payout_review,
       stripe_fraud_flag,
       stripe_fraud_flagged_at,
       stripe_fraud_signal_count,
       stripe_review_open_count,
       updated_at
     FROM payments_account_risk_sources
     WHERE account_id = $1`,
    [accountId],
  );

  return result.rows[0] ?? null;
}

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
     WHERE status IN ('captured', 'partially-refunded')
       AND payment_id IN (
         SELECT payment_id
         FROM payments_payment_orders
         WHERE order_id = $1
       )
     ORDER BY captured_at DESC NULLS LAST, payment_id DESC
     LIMIT 1`,
    [orderId],
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

const activePaymentStatuses = ["pending-confirmation", "captured", "partially-refunded", "refunded", "disputed"];

export async function getActivePaymentByOrderSet(
  db: PgQueryable,
  orderIds: readonly string[],
  buyerAccountId: string,
): Promise<PaymentDetailRow | null> {
  const result = await db.query<PaymentPageRow>(
    `WITH requested_order_ids AS (
       SELECT jsonb_array_elements_text($1::jsonb) AS order_id
     ),
     exact_payment_order_sets AS (
       SELECT payment_id
       FROM payments_payment_orders
       GROUP BY payment_id
       HAVING COUNT(*) = (SELECT COUNT(*) FROM requested_order_ids)
          AND COUNT(*) FILTER (WHERE order_id IN (SELECT order_id FROM requested_order_ids)) =
              (SELECT COUNT(*) FROM requested_order_ids)
     )
     ${paymentSelect}
     WHERE buyer_account_id = $2
       AND status = ANY($3::text[])
       AND payment_id IN (SELECT payment_id FROM exact_payment_order_sets)
     ORDER BY created_at ASC, payment_id ASC
     LIMIT 1`,
    [JSON.stringify([...new Set(orderIds)]), buyerAccountId, activePaymentStatuses],
  );

  const row = result.rows[0];
  return row ? mapPaymentRow(row) : null;
}

async function getActivePaymentCreationReservationBySource(
  db: PgQueryable,
  sourceContext: string,
  sourceReferenceId: string,
): Promise<PaymentCreationReservationRow | null> {
  const result = await db.query<PaymentCreationReservationRawRow>(
    `SELECT
       payment_id,
       buyer_account_id,
       order_set_key,
       order_ids,
       source_context,
       source_reference_id,
       status,
       created_at,
       updated_at
     FROM payments_payment_creation_reservations
     WHERE source_context = $1
       AND source_reference_id = $2
       AND status = 'active'
     ORDER BY created_at ASC, payment_id ASC
     LIMIT 1`,
    [sourceContext, sourceReferenceId],
  );

  const row = result.rows[0];
  return row ? mapPaymentCreationReservationRow(row) : null;
}

async function getActivePaymentCreationReservationByOrderSet(
  db: PgQueryable,
  buyerAccountId: string,
  orderSetKey: string,
): Promise<PaymentCreationReservationRow | null> {
  const result = await db.query<PaymentCreationReservationRawRow>(
    `SELECT
       payment_id,
       buyer_account_id,
       order_set_key,
       order_ids,
       source_context,
       source_reference_id,
       status,
       created_at,
       updated_at
     FROM payments_payment_creation_reservations
     WHERE buyer_account_id = $1
       AND order_set_key = $2
       AND status = 'active'
     ORDER BY created_at ASC, payment_id ASC
     LIMIT 1`,
    [buyerAccountId, orderSetKey],
  );

  const row = result.rows[0];
  return row ? mapPaymentCreationReservationRow(row) : null;
}

export async function reservePaymentCreation(
  db: PgQueryable,
  reservation: Readonly<{
    paymentId: string;
    buyerAccountId: string;
    orderIds: readonly string[];
    sourceContext?: string | null;
    sourceReferenceId?: string | null;
    createdAt?: string;
  }>,
): Promise<PaymentCreationReservationResult> {
  const orderIds = [...new Set(reservation.orderIds)];
  const orderSetKey = paymentCreationOrderSetKey(orderIds);
  const timestamp = reservation.createdAt ?? new Date().toISOString();
  const result = await db.query<PaymentCreationReservationRawRow>(
    `INSERT INTO payments_payment_creation_reservations (
       payment_id,
       buyer_account_id,
       order_set_key,
       order_ids,
       source_context,
       source_reference_id,
       status,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'active', $7, $7)
     ON CONFLICT DO NOTHING
     RETURNING
       payment_id,
       buyer_account_id,
       order_set_key,
       order_ids,
       source_context,
       source_reference_id,
       status,
       created_at,
       updated_at`,
    [
      reservation.paymentId,
      reservation.buyerAccountId,
      orderSetKey,
      JSON.stringify(orderIds),
      reservation.sourceContext ?? null,
      reservation.sourceReferenceId ?? null,
      timestamp,
    ],
  );

  const inserted = result.rows[0];
  if (inserted) {
    return { outcome: "reserved", reservation: mapPaymentCreationReservationRow(inserted) };
  }

  if (reservation.sourceContext && reservation.sourceReferenceId) {
    const existingSource = await getActivePaymentCreationReservationBySource(
      db,
      reservation.sourceContext,
      reservation.sourceReferenceId,
    );
    if (existingSource) {
      return {
        outcome: existingSource.buyer_account_id === reservation.buyerAccountId ? "same-source" : "source-conflict",
        reservation: existingSource,
      };
    }
  }

  const existingOrderSet = await getActivePaymentCreationReservationByOrderSet(
    db,
    reservation.buyerAccountId,
    orderSetKey,
  );
  if (existingOrderSet) {
    return { outcome: "same-order-set", reservation: existingOrderSet };
  }

  throw new Error("Payment creation reservation conflict could not be resolved.");
}

export async function markPaymentCreationReservationInactive(
  db: PgQueryable,
  params: Readonly<{ paymentId: string; status: "failed" | "released"; updatedAt?: string }>,
) {
  await db.query(
    `UPDATE payments_payment_creation_reservations
     SET status = $2,
         updated_at = $3
     WHERE payment_id = $1
       AND status = 'active'`,
    [params.paymentId, params.status, params.updatedAt ?? new Date().toISOString()],
  );
}

export async function listSavedCheckoutInstruments(
  db: PgQueryable,
  accountId: string,
): Promise<SavedCheckoutInstrumentRow[]> {
  const result = await db.query<SavedCheckoutInstrumentRow>(
    `SELECT
       instrument_id,
       account_id,
       agent_grant_id,
       payment_method_category,
       provider,
       provider_customer_reference,
       provider_reference,
       provider_fingerprint,
       display_label,
       confirmation_experience,
       is_default,
       readiness,
       allow_redisplay,
       consent_id,
       consent_text,
       removed_at,
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
       agent_grant_id,
       payment_method_category,
       provider,
       provider_customer_reference,
       provider_reference,
       provider_fingerprint,
       display_label,
       confirmation_experience,
       is_default,
       readiness,
       allow_redisplay,
       consent_id,
       consent_text,
       removed_at,
       created_at,
       updated_at
     FROM payments_saved_checkout_instruments
     WHERE account_id = $1
       AND instrument_id = $2`,
    [params.accountId, params.instrumentId],
  );

  return result.rows[0] ?? null;
}

export async function getSavedCheckoutInstrumentByProviderReference(
  db: PgQueryable,
  params: Readonly<{ provider: string; providerReference: string }>,
): Promise<SavedCheckoutInstrumentRow | null> {
  const result = await db.query<SavedCheckoutInstrumentRow>(
    `SELECT
       instrument_id,
       account_id,
       agent_grant_id,
       payment_method_category,
       provider,
       provider_customer_reference,
       provider_reference,
       provider_fingerprint,
       display_label,
       confirmation_experience,
       is_default,
       readiness,
       allow_redisplay,
       consent_id,
       consent_text,
       removed_at,
       created_at,
       updated_at
     FROM payments_saved_checkout_instruments
     WHERE provider = $1
       AND provider_reference = $2`,
    [params.provider, params.providerReference],
  );

  return result.rows[0] ?? null;
}

export async function listSavedCheckoutInstrumentsForAgentGrant(
  db: PgQueryable,
  params: Readonly<{ accountId: string; agentGrantId: string }>,
): Promise<SavedCheckoutInstrumentRow[]> {
  const result = await db.query<SavedCheckoutInstrumentRow>(
    `SELECT
       instrument_id,
       account_id,
       agent_grant_id,
       payment_method_category,
       provider,
       provider_customer_reference,
       provider_reference,
       provider_fingerprint,
       display_label,
       confirmation_experience,
       is_default,
       readiness,
       allow_redisplay,
       consent_id,
       consent_text,
       removed_at,
       created_at,
       updated_at
     FROM payments_saved_checkout_instruments
     WHERE account_id = $1
       AND agent_grant_id = $2
       AND readiness <> 'removed'
     ORDER BY updated_at ASC, instrument_id ASC`,
    [params.accountId, params.agentGrantId],
  );

  return result.rows;
}

export async function recordRevokedAgentGrant(
  db: PgQueryable,
  params: Readonly<{ accountId: string; agentGrantId: string; revokedAt: string }>,
) {
  await db.query(
    `INSERT INTO payments_revoked_agent_grants (
       account_id,
       agent_grant_id,
       revoked_at
     ) VALUES ($1, $2, $3)
     ON CONFLICT (account_id, agent_grant_id) DO UPDATE
     SET revoked_at = LEAST(payments_revoked_agent_grants.revoked_at, EXCLUDED.revoked_at)`,
    [params.accountId, params.agentGrantId, params.revokedAt],
  );
}

export async function getRevokedAgentGrant(
  db: PgQueryable,
  params: Readonly<{ accountId: string; agentGrantId: string }>,
): Promise<Readonly<{ account_id: string; agent_grant_id: string; revoked_at: string }> | null> {
  const result = await db.query<{ account_id: string; agent_grant_id: string; revoked_at: string }>(
    `SELECT account_id, agent_grant_id, revoked_at
     FROM payments_revoked_agent_grants
     WHERE account_id = $1
       AND agent_grant_id = $2`,
    [params.accountId, params.agentGrantId],
  );

  return result.rows[0] ?? null;
}

export async function getProviderCustomer(
  db: PgQueryable,
  params: Readonly<{ accountId: string; provider: string }>,
): Promise<ProviderCustomerRow | null> {
  const result = await db.query<ProviderCustomerRow>(
    `SELECT
       account_id,
       provider,
       provider_customer_reference,
       display_name,
       email,
       created_at,
       updated_at
     FROM payments_provider_customers
     WHERE account_id = $1
       AND provider = $2`,
    [params.accountId, params.provider],
  );

  return result.rows[0] ?? null;
}

export async function upsertProviderCustomer(
  db: PgQueryable,
  customer: Readonly<{
    accountId: string;
    provider: string;
    providerCustomerReference: string;
    displayName?: string | null;
    email?: string | null;
    timestamp?: string;
  }>,
): Promise<ProviderCustomerRow> {
  const timestamp = customer.timestamp ?? new Date().toISOString();
  const result = await db.query<ProviderCustomerRow>(
    `INSERT INTO payments_provider_customers (
       account_id,
       provider,
       provider_customer_reference,
       display_name,
       email,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (account_id, provider) DO UPDATE
     SET provider_customer_reference = EXCLUDED.provider_customer_reference,
         display_name = COALESCE(EXCLUDED.display_name, payments_provider_customers.display_name),
         email = COALESCE(EXCLUDED.email, payments_provider_customers.email),
         updated_at = EXCLUDED.updated_at
     RETURNING
       account_id,
       provider,
       provider_customer_reference,
       display_name,
       email,
       created_at,
       updated_at`,
    [
      customer.accountId,
      customer.provider,
      customer.providerCustomerReference,
      customer.displayName ?? null,
      customer.email ?? null,
      timestamp,
    ],
  );

  return result.rows[0]!;
}

export async function upsertSavedCheckoutInstrument(
  db: PgQueryable,
  instrument: Readonly<{
    instrumentId: string;
    accountId: string;
    agentGrantId?: string | null;
    paymentMethodCategory: "card" | "bank-account" | "platform-credit";
    provider: string;
    providerCustomerReference?: string | null;
    providerReference: string;
    providerFingerprint?: string | null;
    displayLabel: string;
    confirmationExperience: "trusted-payment-step" | "off-session-token";
    readiness: "ready" | "setup-required" | "removed";
    allowRedisplay?: "always" | "limited" | "unspecified";
    consentId?: string | null;
    consentText?: string | null;
    isDefault?: boolean;
    removedAt?: string | null;
    timestamp?: string;
  }>,
): Promise<SavedCheckoutInstrumentRow> {
  const timestamp = instrument.timestamp ?? new Date().toISOString();
  const result = await db.query<SavedCheckoutInstrumentRow>(
    `WITH cleared_default AS (
       UPDATE payments_saved_checkout_instruments
       SET is_default = false,
           updated_at = $17
       WHERE account_id = $2
          AND $15 = true
     )
     INSERT INTO payments_saved_checkout_instruments (
       instrument_id,
       account_id,
       agent_grant_id,
       payment_method_category,
       provider,
       provider_customer_reference,
       provider_reference,
       provider_fingerprint,
       display_label,
       confirmation_experience,
       readiness,
       allow_redisplay,
       consent_id,
       consent_text,
       is_default,
       removed_at,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)
     ON CONFLICT (provider, provider_reference) DO UPDATE
     SET account_id = EXCLUDED.account_id,
         agent_grant_id = EXCLUDED.agent_grant_id,
         payment_method_category = EXCLUDED.payment_method_category,
         provider_customer_reference = EXCLUDED.provider_customer_reference,
         provider_fingerprint = EXCLUDED.provider_fingerprint,
         display_label = EXCLUDED.display_label,
         confirmation_experience = EXCLUDED.confirmation_experience,
         readiness = EXCLUDED.readiness,
         allow_redisplay = EXCLUDED.allow_redisplay,
         consent_id = COALESCE(EXCLUDED.consent_id, payments_saved_checkout_instruments.consent_id),
         consent_text = COALESCE(EXCLUDED.consent_text, payments_saved_checkout_instruments.consent_text),
         is_default = EXCLUDED.is_default,
         removed_at = EXCLUDED.removed_at,
         updated_at = EXCLUDED.updated_at
     RETURNING
       instrument_id,
       account_id,
       agent_grant_id,
       payment_method_category,
       provider,
       provider_customer_reference,
       provider_reference,
       provider_fingerprint,
       display_label,
       confirmation_experience,
       is_default,
       readiness,
       allow_redisplay,
       consent_id,
       consent_text,
       removed_at,
       created_at,
       updated_at`,
    [
      instrument.instrumentId,
      instrument.accountId,
      instrument.agentGrantId ?? null,
      instrument.paymentMethodCategory,
      instrument.provider,
      instrument.providerCustomerReference ?? null,
      instrument.providerReference,
      instrument.providerFingerprint ?? null,
      instrument.displayLabel,
      instrument.confirmationExperience,
      instrument.readiness,
      instrument.allowRedisplay ?? "unspecified",
      instrument.consentId ?? null,
      instrument.consentText ?? null,
      Boolean(instrument.isDefault),
      instrument.removedAt ?? null,
      timestamp,
    ],
  );

  return result.rows[0]!;
}

export async function setSavedCheckoutInstrumentDefault(
  db: PgQueryable,
  params: Readonly<{ accountId: string; instrumentId: string; timestamp?: string }>,
) {
  const timestamp = params.timestamp ?? new Date().toISOString();
  await db.query(
    `UPDATE payments_saved_checkout_instruments
     SET is_default = instrument_id = $2,
         updated_at = $3
     WHERE account_id = $1
       AND readiness <> 'removed'`,
    [params.accountId, params.instrumentId, timestamp],
  );
}

export async function markSavedCheckoutInstrumentRemoved(
  db: PgQueryable,
  params: Readonly<{ accountId: string; instrumentId: string; timestamp?: string }>,
) {
  const timestamp = params.timestamp ?? new Date().toISOString();
  await db.query(
    `UPDATE payments_saved_checkout_instruments
     SET readiness = 'removed',
         is_default = false,
         removed_at = $3,
         updated_at = $3
     WHERE account_id = $1
       AND instrument_id = $2`,
    [params.accountId, params.instrumentId, timestamp],
  );
}

export async function recordSavedCheckoutInstrumentAudit(
  db: PgQueryable,
  audit: Readonly<{
    auditId: string;
    instrumentId: string;
    accountId: string;
    action: string;
    reason?: string | null;
    performedByAccountId?: string | null;
    createdAt?: string;
  }>,
) {
  await db.query(
    `INSERT INTO payments_saved_checkout_instrument_audit (
       audit_id,
       instrument_id,
       account_id,
       action,
       reason,
       performed_by_account_id,
       created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (audit_id) DO NOTHING`,
    [
      audit.auditId,
      audit.instrumentId,
      audit.accountId,
      audit.action,
      audit.reason ?? null,
      audit.performedByAccountId ?? null,
      audit.createdAt ?? new Date().toISOString(),
    ],
  );
}

export async function recordSavedCheckoutSetupSession(
  db: PgQueryable,
  session: Readonly<{
    setupReferenceId: string;
    accountId: string;
    agentGrantId?: string | null;
    provider: string;
    providerCustomerReference: string;
    processorSetupReference: string;
    processorClientSecret?: string | null;
    processorRedirectUrl?: string | null;
    processorStatus: string;
    consentId: string;
    consentText: string;
    timestamp?: string;
  }>,
): Promise<SavedCheckoutSetupSessionRow> {
  const timestamp = session.timestamp ?? new Date().toISOString();
  const result = await db.query<SavedCheckoutSetupSessionRow>(
    `INSERT INTO payments_saved_checkout_setup_sessions (
       setup_reference_id,
       account_id,
       agent_grant_id,
       provider,
       provider_customer_reference,
       processor_setup_reference,
       processor_client_secret,
       processor_redirect_url,
       processor_status,
       consent_id,
       consent_text,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
     ON CONFLICT (setup_reference_id) DO UPDATE
     SET processor_setup_reference = EXCLUDED.processor_setup_reference,
         processor_client_secret = EXCLUDED.processor_client_secret,
         processor_redirect_url = EXCLUDED.processor_redirect_url,
         processor_status = EXCLUDED.processor_status,
         agent_grant_id = EXCLUDED.agent_grant_id,
         updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [
      session.setupReferenceId,
      session.accountId,
      session.agentGrantId ?? null,
      session.provider,
      session.providerCustomerReference,
      session.processorSetupReference,
      session.processorClientSecret ?? null,
      session.processorRedirectUrl ?? null,
      session.processorStatus,
      session.consentId,
      session.consentText,
      timestamp,
    ],
  );

  return result.rows[0]!;
}

export async function getSavedCheckoutSetupSessionByProcessorReference(
  db: PgQueryable,
  processorSetupReference: string,
): Promise<SavedCheckoutSetupSessionRow | null> {
  const result = await db.query<SavedCheckoutSetupSessionRow>(
    `SELECT *
     FROM payments_saved_checkout_setup_sessions
     WHERE processor_setup_reference = $1`,
    [processorSetupReference],
  );

  return result.rows[0] ?? null;
}

export async function getSavedCheckoutSetupSessionBySetupReference(
  db: PgQueryable,
  setupReferenceId: string,
): Promise<SavedCheckoutSetupSessionRow | null> {
  const result = await db.query<SavedCheckoutSetupSessionRow>(
    `SELECT *
     FROM payments_saved_checkout_setup_sessions
     WHERE setup_reference_id = $1`,
    [setupReferenceId],
  );

  return result.rows[0] ?? null;
}

export async function completeSavedCheckoutSetupSession(
  db: PgQueryable,
  params: Readonly<{ processorSetupReference: string; processorStatus: string; completedAt?: string }>,
) {
  const timestamp = params.completedAt ?? new Date().toISOString();
  await db.query(
    `UPDATE payments_saved_checkout_setup_sessions
     SET processor_status = $2,
         completed_at = COALESCE(completed_at, $3),
         updated_at = $3
     WHERE processor_setup_reference = $1`,
    [params.processorSetupReference, params.processorStatus, timestamp],
  );
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
       status,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $7)
     ON CONFLICT (operation_key) DO UPDATE
     SET provider_name = EXCLUDED.provider_name,
         operation_kind = EXCLUDED.operation_kind,
         account_id = EXCLUDED.account_id,
         payment_id = EXCLUDED.payment_id,
         idempotency_key = EXCLUDED.idempotency_key,
         updated_at = EXCLUDED.updated_at`,
    [
      operation.operationKey,
      operation.providerName,
      operation.operationKind,
      operation.accountId ?? null,
      operation.paymentId ?? null,
      operation.idempotencyKey,
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

export async function getPaymentProviderIdempotencyKey(
  db: PgQueryable,
  operationKey: string,
): Promise<PaymentProviderIdempotencyKeyRow | null> {
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
     WHERE operation_key = $1
     LIMIT 1`,
    [operationKey],
  );

  return result.rows[0] ?? null;
}

export async function listPaymentProviderOperationsNeedingReconciliation(
  db: PgQueryable,
  params: Readonly<{ limit?: number; claimOwnerId?: string; claimTtlMs?: number }> = {},
): Promise<PaymentProviderOperationRow[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
  if (params.claimOwnerId) {
    const result = await db.query<PaymentProviderOperationRow>(
      `WITH candidates AS (
         SELECT operation_key
         FROM payments_provider_operations
         WHERE status = 'pending'
           AND updated_at < NOW() - INTERVAL '15 minutes'
         ORDER BY updated_at ASC, operation_key ASC
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
           'payment-provider-operation-reconciliation',
           operation_key,
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
       SELECT
         operation_key,
         provider_name,
         operation_kind,
         account_id,
         payment_id,
         idempotency_key,
         status,
         provider_object_reference,
         error_message,
         created_at,
         updated_at,
         completed_at
       FROM payments_provider_operations
       WHERE operation_key IN (SELECT entity_id FROM claimed)
       ORDER BY updated_at ASC, operation_key ASC`,
      [limit, params.claimOwnerId, params.claimTtlMs ?? 120_000],
    );

    return result.rows;
  }

  const result = await db.query<PaymentProviderOperationRow>(
    `SELECT
       operation_key,
       provider_name,
       operation_kind,
       account_id,
       payment_id,
       idempotency_key,
       status,
       provider_object_reference,
       error_message,
       created_at,
       updated_at,
       completed_at
     FROM payments_provider_operations
     WHERE status = 'pending'
       AND updated_at < NOW() - INTERVAL '15 minutes'
     ORDER BY updated_at ASC, operation_key ASC
     LIMIT $1`,
    [limit],
  );

  return result.rows;
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
