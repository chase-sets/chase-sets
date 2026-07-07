import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ProcessorDisputeEvidence, PaymentProcessorGateway } from "@chase-sets/payment-processing";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { OrderId } from "@chase-sets/primitives/typed-ids";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type {
  PaymentCommand,
  PaymentDisputedEvent,
  PaymentDisputeEvidenceSummary,
  PaymentEvent,
  PaymentState,
  SellerPayoutComponent,
} from "../../domain/domain";
import { listPaymentOrderInputs, type PaymentOrderInputRow } from "../order-input/order-input-queries";
import {
  getPaymentProviderIdempotencyKey,
  recordPaymentProviderIdempotencyKey,
  recordPaymentProviderOperationFailed,
  recordPaymentProviderOperationPending,
  recordPaymentProviderOperationSucceeded,
} from "../../read-model/queries";
import {
  listFulfillmentDisputeEvidenceSources,
  type PaymentsFulfillmentDisputeEvidenceSourceRow,
} from "./dispute-evidence-queries";

export type PaymentDisputeEvidenceSubmissionResult =
  | Readonly<{
      status: "submitted";
      providerDisputeId: string;
      evidence: ProcessorDisputeEvidence;
      evidenceSummary: PaymentDisputeEvidenceSummary;
    }>
  | Readonly<{
      status: "unavailable";
      providerDisputeId: string;
      reason: "tracking-unavailable";
      evidenceSummary: PaymentDisputeEvidenceSummary;
    }>;

type SubmitPaymentDisputeEvidenceDeps = Readonly<{
  db: PgQueryable;
  processorGateway: PaymentProcessorGateway;
  commandHandler: CommandHandler<PaymentCommand, PaymentState, PaymentEvent>;
}>;

export async function submitPaymentDisputeEvidence(
  deps: SubmitPaymentDisputeEvidenceDeps,
  dispute: PaymentDisputedEvent["data"],
  context: EventStoreContext,
): Promise<PaymentDisputeEvidenceSubmissionResult> {
  if (dispute.disputeLifecycleState !== "created" && dispute.disputeLifecycleState !== "updated") {
    return unavailable(dispute, [], "tracking-unavailable");
  }

  const orderIds = dispute.orderIds as readonly OrderId[];
  const [orders, fulfillmentSources] = await Promise.all([
    listPaymentOrderInputs(deps.db, orderIds, dispute.buyerAccountId),
    listFulfillmentDisputeEvidenceSources(deps.db, orderIds),
  ]);
  const assembled = assembleProcessorDisputeEvidence({
    dispute,
    orders,
    fulfillmentSources,
  });

  if (!assembled) {
    const result = unavailable(dispute, fulfillmentSources, "tracking-unavailable");
    await deps.commandHandler({
      streamId: `payments.payment-${dispute.paymentId}`,
      command: {
        type: "RecordPaymentDisputeEvidenceUnavailable",
        providerDisputeId: dispute.providerDisputeId,
        reason: result.reason,
        evidenceSummary: result.evidenceSummary,
        recordedAt: new Date().toISOString(),
      },
      context,
    });
    return result;
  }

  if (!deps.processorGateway.submitDisputeEvidence) {
    throw new Error("Configured payment processor cannot submit dispute evidence.");
  }

  const operationKey = `dispute:${dispute.providerDisputeId}:evidence`;
  const idempotencyKey = `payments:dispute:${dispute.providerDisputeId}:evidence`;
  const existingSubmission = await getPaymentProviderIdempotencyKey(deps.db, operationKey);
  if (existingSubmission) {
    return {
      status: "submitted",
      providerDisputeId: dispute.providerDisputeId,
      evidence: assembled.evidence,
      evidenceSummary: assembled.evidenceSummary,
    };
  }

  await recordPaymentProviderOperationPending(deps.db, {
    operationKey,
    providerName: dispute.processorName,
    operationKind: "dispute-evidence-submit",
    accountId: dispute.buyerAccountId,
    paymentId: dispute.paymentId,
    idempotencyKey,
    createdAt: dispute.disputedAt,
  });

  let submitted: Awaited<ReturnType<NonNullable<PaymentProcessorGateway["submitDisputeEvidence"]>>>;
  try {
    submitted = await deps.processorGateway.submitDisputeEvidence({
      paymentId: dispute.paymentId,
      providerDisputeId: dispute.providerDisputeId,
      providerChargeReference: dispute.providerChargeReference,
      processorPaymentReference: dispute.processorPaymentReference,
      evidence: assembled.evidence,
      idempotencyKey,
    });
  } catch (error) {
    await recordPaymentProviderOperationFailed(deps.db, {
      operationKey,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  await recordPaymentProviderOperationSucceeded(deps.db, {
    operationKey,
    providerObjectReference: submitted.providerDisputeId,
    completedAt: submitted.submittedAt,
  });
  await recordPaymentProviderIdempotencyKey(deps.db, {
    operationKey,
    providerName: submitted.processorName,
    operationKind: "dispute-evidence-submit",
    accountId: dispute.buyerAccountId,
    providerObjectReference: submitted.providerDisputeId,
    idempotencyKey,
    createdAt: submitted.submittedAt,
  });

  await deps.commandHandler({
    streamId: `payments.payment-${dispute.paymentId}`,
    command: {
      type: "RecordPaymentDisputeEvidenceSubmitted",
      providerDisputeId: submitted.providerDisputeId,
      processorStatus: submitted.processorStatus,
      evidenceSummary: assembled.evidenceSummary,
      submittedAt: submitted.submittedAt,
    },
    context,
  });

  return {
    status: "submitted",
    providerDisputeId: submitted.providerDisputeId,
    evidence: assembled.evidence,
    evidenceSummary: assembled.evidenceSummary,
  };
}

export function assembleProcessorDisputeEvidence(
  input: Readonly<{
    dispute: Pick<
      PaymentDisputedEvent["data"],
      "paymentId" | "orderIds" | "providerDisputeId" | "disputeReason" | "disputeEvidenceDueAt" | "sellerPayouts"
    >;
    orders: readonly PaymentOrderInputRow[];
    fulfillmentSources: readonly PaymentsFulfillmentDisputeEvidenceSourceRow[];
  }>,
): Readonly<{ evidence: ProcessorDisputeEvidence; evidenceSummary: PaymentDisputeEvidenceSummary }> | null {
  const trackedShipments = input.fulfillmentSources.filter((shipment) => shipment.tracking_identifier?.trim());
  if (trackedShipments.length === 0) {
    return null;
  }

  const primaryShipment = trackedShipments[0]!;
  const address = primaryShipment.shipping_destination_snapshot;
  const trackingNumbers = [...new Set(trackedShipments.map((shipment) => shipment.tracking_identifier!).sort())];
  const carriers = [
    ...new Set(trackedShipments.flatMap((shipment) => (shipment.carrier_name ? [shipment.carrier_name] : [])).sort()),
  ];
  const deliveredAt = trackedShipments.find((shipment) => shipment.delivered_at)?.delivered_at ?? null;
  const shippedAt = primaryShipment.dispatched_at ?? primaryShipment.label_attached_at;
  const evidenceSummary: PaymentDisputeEvidenceSummary = {
    trackingNumbers,
    carriers,
    deliveredAt,
    orderIds: input.dispute.orderIds as readonly OrderId[],
    hasDeliveryProof: Boolean(deliveredAt),
  };

  return {
    evidence: {
      customerEmailAddress: firstPresent(
        input.orders.map((order) => order.buyer_email),
        address?.email ?? null,
      ),
      customerName: address?.name ?? null,
      productDescription: productDescription(trackedShipments),
      shippingAddress: address ? formatAddress(address) : null,
      shippingCarrier: carriers.join(", ") || null,
      shippingDate: shippedAt ? shippedAt.slice(0, 10) : null,
      shippingTrackingNumber: trackingNumbers.join(", "),
      uncategorizedText: disputeNarrative({
        dispute: input.dispute,
        shipments: trackedShipments,
        sellerPayouts: input.dispute.sellerPayouts,
      }),
    },
    evidenceSummary,
  };
}

function unavailable(
  dispute: Pick<PaymentDisputedEvent["data"], "providerDisputeId" | "orderIds">,
  fulfillmentSources: readonly PaymentsFulfillmentDisputeEvidenceSourceRow[],
  reason: "tracking-unavailable",
): Extract<PaymentDisputeEvidenceSubmissionResult, { status: "unavailable" }> {
  return {
    status: "unavailable",
    providerDisputeId: dispute.providerDisputeId,
    reason,
    evidenceSummary: {
      trackingNumbers: [],
      carriers: [],
      deliveredAt: fulfillmentSources.find((shipment) => shipment.delivered_at)?.delivered_at ?? null,
      orderIds: dispute.orderIds as readonly OrderId[],
      hasDeliveryProof: false,
    },
  };
}

function firstPresent(values: readonly (string | null | undefined)[], fallback: string | null) {
  return values.find((value) => value?.trim())?.trim() ?? fallback;
}

function formatAddress(address: AddressSnapshot) {
  return [
    address.name,
    address.company,
    address.line1,
    address.line2,
    `${address.city}, ${address.state} ${address.postalCode}`,
    address.country,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");
}

function productDescription(shipments: readonly PaymentsFulfillmentDisputeEvidenceSourceRow[]) {
  const lines = shipments.flatMap((shipment) => shipment.lines);
  const descriptions = lines.map((line) => {
    const quantity = line.quantity && line.quantity > 1 ? `${line.quantity} x ` : "";
    return [line.itemTitle, line.itemSubtitle, line.productSummary]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => value.trim())
      .join(" - ")
      .replace(/^/, quantity);
  });
  return [...new Set(descriptions.filter(Boolean))].join("\n").slice(0, 4000) || null;
}

function disputeNarrative(
  input: Readonly<{
    dispute: Pick<
      PaymentDisputedEvent["data"],
      "paymentId" | "orderIds" | "providerDisputeId" | "disputeReason" | "disputeEvidenceDueAt"
    >;
    shipments: readonly PaymentsFulfillmentDisputeEvidenceSourceRow[];
    sellerPayouts: readonly SellerPayoutComponent[];
  }>,
) {
  const deliveryLines = input.shipments.map((shipment) => {
    const delivered = shipment.delivered_at ? ` Delivery confirmed at ${shipment.delivered_at}.` : "";
    const dispatched = shipment.dispatched_at ? ` Dispatched at ${shipment.dispatched_at}.` : "";
    const addressVerification = addressVerificationNarrative(shipment.shipping_destination_snapshot);
    return `Order ${shipment.order_id} shipped via ${shipment.carrier_name ?? "carrier"} tracking ${shipment.tracking_identifier}.${dispatched}${delivered}${addressVerification}`;
  });
  const sellerExposure = input.sellerPayouts
    .map((payout) => `${payout.orderId}: seller payout ${payout.sellerPayoutAmount}`)
    .join("; ");

  return [
    `Chase Sets automatically assembled this dispute evidence from platform order and fulfillment records for payment ${input.dispute.paymentId}.`,
    `Dispute ${input.dispute.providerDisputeId}${input.dispute.disputeReason ? ` reason ${input.dispute.disputeReason}` : ""}${input.dispute.disputeEvidenceDueAt ? ` due ${input.dispute.disputeEvidenceDueAt}` : ""}.`,
    ...deliveryLines,
    sellerExposure ? `Settlement exposure references: ${sellerExposure}.` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .slice(0, 4000);
}

function addressVerificationNarrative(address: AddressSnapshot | null | undefined) {
  const verification = address?.verification;
  if (!verification) {
    return "";
  }

  const decision =
    verification.buyerDecision === "kept-original"
      ? " Buyer confirmed the original unverified shipping address."
      : verification.buyerDecision === "accepted-suggested"
        ? " Buyer accepted the standardized shipping address."
        : verification.buyerDecision === "provider-unavailable"
          ? " Address verification provider was unavailable at checkout, so the address was accepted as unverified."
          : "";
  return ` Address verification status: ${verification.status} via ${verification.source} at ${verification.checkedAt}.${decision}`;
}
