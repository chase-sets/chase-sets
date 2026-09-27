export type PrepaidRefundIdentity = Readonly<{
  accountId: string;
  fundingId: string;
  refundId: string;
  currencyCode: "usd";
  amount: string;
}>;

export type PrepaidRefundReservation = PrepaidRefundIdentity & Readonly<{ reservationId: string }>;

export type PrepaidRefundSuccess = PrepaidRefundReservation &
  Readonly<{
    processorRefundReference: string;
    processorPaymentReference: string;
    factId: string;
  }>;

export type PrepaidRefundNonExecution = PrepaidRefundReservation &
  Readonly<{
    processorRefundReference: string;
    processorStatus: "failed" | "cancelled";
    evidenceId: string;
  }>;

/** Settlement is the sole money authority. A reservation is not a balance quote. */
export interface PrepaidRefundAuthority {
  reserve(
    identity: PrepaidRefundIdentity,
  ): Promise<
    | Readonly<{ outcome: "reserved"; reservation: PrepaidRefundReservation }>
    | Readonly<{ outcome: "refused"; reason: "insufficient-unspent" | "unavailable" | "identity-conflict" }>
  >;
  commit(success: PrepaidRefundSuccess): Promise<Readonly<{ outcome: "committed" }>>;
  release(nonExecution: PrepaidRefundNonExecution): Promise<Readonly<{ outcome: "released" }>>;
}

export const unavailablePrepaidRefundAuthority: PrepaidRefundAuthority = {
  reserve: async () => ({ outcome: "refused", reason: "unavailable" }),
  commit: async () => {
    throw new Error("prepaid_refund_authority_unavailable");
  },
  release: async () => {
    throw new Error("prepaid_refund_authority_unavailable");
  },
};

export function matchesPrepaidRefundIdentity(value: PrepaidRefundIdentity, expected: PrepaidRefundIdentity): boolean {
  return (
    value.accountId === expected.accountId &&
    value.fundingId === expected.fundingId &&
    value.refundId === expected.refundId &&
    value.currencyCode === expected.currencyCode &&
    value.amount === expected.amount
  );
}

/** Validate an external port at runtime too; an incomplete or partial grant is never authority. */
export function parsePrepaidRefundReservation(
  value: unknown,
  expected: PrepaidRefundIdentity,
): PrepaidRefundReservation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "accountId,amount,currencyCode,fundingId,refundId,reservationId")
    return null;
  if (
    record.accountId !== expected.accountId ||
    record.fundingId !== expected.fundingId ||
    record.refundId !== expected.refundId ||
    record.currencyCode !== expected.currencyCode ||
    record.amount !== expected.amount ||
    typeof record.reservationId !== "string" ||
    !record.reservationId.trim() ||
    record.reservationId.length > 200
  )
    return null;
  return { ...expected, reservationId: record.reservationId };
}
