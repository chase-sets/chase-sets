import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type PaymentDetailRow = Readonly<{
  payment_id: string;
  buyer_account_id: string;
  order_ids: readonly string[];
  amount: string;
  balance_credit_amount: string;
  processor_amount: string;
  marketplace_fee_amount: string;
  payment_fee_amount: string;
  seller_net_amount: string;
  currency_code: string;
  processor_name: string;
  processor_payment_reference: string;
  processor_client_secret: string | null;
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

type PaymentPageRow = Omit<PaymentDetailRow, "order_ids"> & Readonly<{
  order_ids: unknown;
}>;

function mapPaymentRow(row: PaymentPageRow): PaymentDetailRow {
  return {
    ...row,
    amount: String(row.amount),
    order_ids: Array.isArray(row.order_ids)
      ? row.order_ids.filter((value): value is string => typeof value === "string")
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
    marketplace_fee_amount::text AS marketplace_fee_amount,
    payment_fee_amount::text AS payment_fee_amount,
    seller_net_amount::text AS seller_net_amount,
    currency_code,
    processor_name,
    processor_payment_reference,
    processor_client_secret,
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

export async function getPaymentById(
  db: PgQueryable,
  paymentId: string,
): Promise<PaymentDetailRow | null> {
  const result = await db.query<PaymentPageRow>(
    `${paymentSelect}
     WHERE payment_id = $1`,
    [paymentId],
  );

  const row = result.rows[0];
  return row ? mapPaymentRow(row) : null;
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
