import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  PostageLabelProviderError,
  type PostageAddress,
  type PostageLabelProvider,
  type PostagePackage,
  type PurchasedPostageLabel,
} from "@chase-sets/postage-labels";
import { normalizeAddressSnapshot, type AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type {
  OrderId,
  RemedyId,
  ReturnShipmentId,
  ShipmentId,
  SupportRequestId,
} from "@chase-sets/primitives/typed-ids";
import { FulfillmentDomainError, type ReturnShipmentLabelFailureReason } from "../domain/common";
import {
  decideReturnShipment,
  evolveReturnShipment,
  initialReturnShipmentState,
  type ReturnShipmentEvent,
  type ReturnShipmentFactMetadata,
  type ReturnShipmentPackageRequirements,
  type ReturnShipmentState,
} from "../domain/domain";
import { selectReturnFacility, type ReturnFacility, type ReturnFacilityDirectory } from "../domain/facility-directory";
import { returnShipmentStreamId } from "./runtime";
import {
  listStaleReturnShipmentLabelOperations,
  recordReturnShipmentLabelOperationFailed,
  recordReturnShipmentLabelOperationPending,
  recordReturnShipmentLabelOperationProviderSucceeded,
  recordReturnShipmentLabelOperationSucceeded,
  returnShipmentLabelOperationHasProviderLabel,
  type ReturnShipmentLabelOperationRecord,
} from "../read-model/label-operations";

/**
 * The authorized directive that Support hands Fulfillment to route a returned item
 * to a platform facility. It carries the four orthogonal support decisions already
 * made upstream — remedy, cost payer, destination policy, and package plan — plus a
 * stable `returnShipmentId` and `idempotencyKey` so retries converge on one shipment
 * and one purchased label. Fulfillment selects the concrete facility and buys the
 * label; it never decides who pays or whether a refund is owed.
 */
export type ReturnLabelDirective = Readonly<{
  returnShipmentId: ReturnShipmentId;
  remedyId: RemedyId;
  supportRequestId: SupportRequestId;
  orderId: OrderId;
  outboundShipmentId: ShipmentId;
  returnProgram: string;
  carrier: string;
  region: string;
  serviceLevel: string;
  shipFromSnapshot: AddressSnapshot;
  packageRequirements: ReturnShipmentPackageRequirements;
  costPayer: string;
  costAllocationReference?: string | null;
  estimatedPostageAmountCents?: number | null;
  selectionPolicyVersion: string;
  shipByDeadlineAt: string;
  returnByDeadlineAt: string;
  directiveExpiresAt?: string | null;
  policyVersion: string;
  idempotencyKey: string;
}>;

export type IssueReturnLabelResult =
  | Readonly<{
      outcome: "label-ready";
      returnShipmentId: string;
      version: number;
      trackingIdentifier: string;
      labelDocumentUrl: string;
      postageAmountCents: number | null;
    }>
  | Readonly<{
      outcome: "failed";
      returnShipmentId: string | null;
      failureReason: ReturnShipmentLabelFailureReason;
      failureDetail: string;
    }>
  | Readonly<{ outcome: "in-progress"; returnShipmentId: string }>;

export type VoidReturnLabelResult =
  | Readonly<{ outcome: "voided"; returnShipmentId: string; version: number; refundStatus: string }>
  | Readonly<{ outcome: "noop"; returnShipmentId: string; reason: string }>;

export type ReturnShipmentLabelPurchaseServiceDeps = Readonly<{
  eventStore: EventStore;
  db: PgQueryable;
  postageLabelProvider: PostageLabelProvider;
  facilityDirectory: ReturnFacilityDirectory;
  now?: () => string;
}>;

function postageAddressFromSnapshot(address: AddressSnapshot): PostageAddress {
  return {
    name: address.name,
    company: address.company ?? null,
    street1: address.line1,
    street2: address.line2 ?? null,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    country: address.country,
    phone: address.phone ?? null,
    email: address.email ?? null,
  };
}

function postagePackageFromRequirements(requirements: ReturnShipmentPackageRequirements): PostagePackage {
  return {
    mailpieceClass: "parcel",
    lengthInches: requirements.lengthInches,
    widthInches: requirements.widthInches,
    heightInches: requirements.heightInches,
    weightOunces: requirements.weightOunces,
  };
}

function purchaseFailureReasonFromError(error: unknown): ReturnShipmentLabelFailureReason {
  if (error instanceof PostageLabelProviderError) {
    if (error.kind === "validation") {
      return "label-purchase-rejected";
    }
    if (error.kind === "capability") {
      return "unsupported-parcel";
    }
    return "provider-error";
  }
  return "provider-error";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function facilityIsActiveAt(facility: ReturnFacility, asOf: string): boolean {
  const asOfMs = Date.parse(asOf);
  if (Date.parse(facility.effectiveAt) > asOfMs) {
    return false;
  }
  return facility.retiredAt === null || Date.parse(facility.retiredAt) > asOfMs;
}

/**
 * Distinguishes "no facility serves this route" from "a facility serves the route
 * but cannot accept this parcel" so Support sees the actionable reason. A parcel that
 * every otherwise-eligible facility rejects is `unsupported-parcel`; anything else is
 * `no-eligible-facility`.
 */
function classifyUnselectableFacility(
  directory: ReturnFacilityDirectory,
  directive: ReturnLabelDirective,
  asOf: string,
): ReturnShipmentLabelFailureReason {
  const program = directive.returnProgram.trim().toLowerCase();
  const carrier = directive.carrier.trim().toLowerCase();
  const region = directive.region.trim().toLowerCase();
  const routeMatch = directory.facilities.some(
    (facility) =>
      facilityIsActiveAt(facility, asOf) &&
      facility.supportedReturnPrograms.includes(program) &&
      facility.supportedCarriers.includes(carrier) &&
      facility.supportedRegions.includes(region),
  );
  return routeMatch ? "unsupported-parcel" : "no-eligible-facility";
}

export type ReturnShipmentLabelPurchaseService = Readonly<{
  issueReturnLabel: (directive: ReturnLabelDirective, context: EventStoreContext) => Promise<IssueReturnLabelResult>;
  voidReturnLabel: (
    params: Readonly<{ returnShipmentId: ReturnShipmentId | string; reason?: string | null }>,
    context: EventStoreContext,
  ) => Promise<VoidReturnLabelResult>;
  reconcileStaleReturnLabelPurchases: (
    params?: Readonly<{ staleBefore?: string; staleAfterMs?: number; limit?: number }>,
    context?: EventStoreContext,
  ) => Promise<{ checked: number; attached: number; failed: number }>;
}>;

export function createReturnShipmentLabelPurchaseService(
  deps: ReturnShipmentLabelPurchaseServiceDeps,
): ReturnShipmentLabelPurchaseService {
  const now = deps.now ?? (() => new Date().toISOString());
  const provider = deps.postageLabelProvider;
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<ReturnShipmentEvent>(),
    initialState: () => initialReturnShipmentState,
    evolve: evolveReturnShipment,
    decide: decideReturnShipment,
  });

  function metadataFor(directive: ReturnLabelDirective, causationSuffix: string): ReturnShipmentFactMetadata {
    return {
      correlationRemedyId: directive.remedyId,
      causationId: `${directive.idempotencyKey}:${causationSuffix}`,
      idempotencyKey: directive.idempotencyKey,
      policyVersion: directive.policyVersion,
    };
  }

  function purchaseOperationKey(returnShipmentId: string): string {
    return `return-shipment:${returnShipmentId}:purchase-label`;
  }

  async function recordFailureFact(
    directive: ReturnLabelDirective,
    failureReason: ReturnShipmentLabelFailureReason,
    failureDetail: string,
  ): Promise<void> {
    // A failure fact can only be recorded once the shipment stream exists and is
    // still awaiting a label; pre-request failures are returned to the caller only.
    const loaded = await repository.load(returnShipmentStreamId(directive.returnShipmentId));
    if (loaded.state.status !== "requested" || loaded.state.labelStatus === "ready") {
      return;
    }
    await commandHandler({
      streamId: returnShipmentStreamId(directive.returnShipmentId),
      command: {
        type: "RecordReturnShipmentLabelPurchaseFailed",
        failureReason,
        failureDetail,
        postageProviderName: provider.providerName,
        postageProviderMode: provider.providerMode,
        metadata: metadataFor(directive, `label-failure:${failureReason}`),
        failedAt: now(),
      },
      context: contextRef.current,
    });
  }

  // The active context for helper commands issued inside issueReturnLabel.
  const contextRef: { current: EventStoreContext } = {
    current: {
      tenantId: "tnt_fulfillment" as never,
      audit: { performedByUserId: "usr_fulfillment_system" as never, forAccountId: "acc_fulfillment_system" as never },
    },
  };

  async function attachReadyLabel(
    directive: ReturnLabelDirective,
    operationKey: string,
    label: PurchasedPostageLabel,
    context: EventStoreContext,
  ): Promise<IssueReturnLabelResult> {
    const loaded = await repository.load(returnShipmentStreamId(directive.returnShipmentId));
    if (loaded.state.labelStatus === "ready") {
      await recordReturnShipmentLabelOperationSucceeded(deps.db, {
        operationKey,
        providerShipmentId: label.providerShipmentId,
        providerLabelId: label.providerLabelId,
        trackingIdentifier: label.trackingIdentifier,
        completedAt: label.purchasedAt,
      });
      return {
        outcome: "label-ready",
        returnShipmentId: directive.returnShipmentId,
        version: loaded.version,
        trackingIdentifier: loaded.state.trackingIdentifier ?? label.trackingIdentifier,
        labelDocumentUrl: loaded.state.labelDocumentUrl ?? label.labelDocumentUrl,
        postageAmountCents: loaded.state.postageAmountCents,
      };
    }
    if (loaded.state.status !== "requested") {
      throw new FulfillmentDomainError("Return shipment is no longer awaiting a label.");
    }
    const result = await commandHandler({
      streamId: returnShipmentStreamId(directive.returnShipmentId),
      command: {
        type: "MarkReturnShipmentLabelReady",
        carrierName: label.carrierName,
        trackingIdentifier: label.trackingIdentifier,
        labelProviderReference: label.labelReference,
        labelDocumentUrl: label.labelDocumentUrl,
        postageProviderName: label.providerName,
        postageProviderMode: label.providerMode,
        postageProviderShipmentId: label.providerShipmentId,
        postageProviderLabelId: label.providerLabelId,
        postageAmountCents: label.postageAmountCents,
        estimatedPostageAmountCents: directive.estimatedPostageAmountCents ?? null,
        postageCurrency: label.postageCurrency,
        metadata: metadataFor(directive, "label-ready"),
        readyAt: label.purchasedAt,
      },
      context,
    });
    await recordReturnShipmentLabelOperationSucceeded(deps.db, {
      operationKey,
      providerShipmentId: label.providerShipmentId,
      providerLabelId: label.providerLabelId,
      trackingIdentifier: label.trackingIdentifier,
      completedAt: label.purchasedAt,
    });
    return {
      outcome: "label-ready",
      returnShipmentId: directive.returnShipmentId,
      version: result.version,
      trackingIdentifier: label.trackingIdentifier,
      labelDocumentUrl: label.labelDocumentUrl,
      postageAmountCents: label.postageAmountCents,
    };
  }

  async function recoverProviderLabel(
    operation: ReturnShipmentLabelOperationRecord,
  ): Promise<PurchasedPostageLabel | null> {
    if (!provider.recoverPurchasedUspsLabel) {
      return null;
    }
    const recovered = await provider.recoverPurchasedUspsLabel({ idempotencyKey: operation.idempotency_key });
    if (!recovered) {
      return null;
    }
    await recordReturnShipmentLabelOperationProviderSucceeded(deps.db, {
      operationKey: operation.operation_key,
      providerShipmentId: recovered.providerShipmentId,
      providerLabelId: recovered.providerLabelId,
      trackingIdentifier: recovered.trackingIdentifier,
      updatedAt: recovered.purchasedAt,
    });
    return recovered;
  }

  async function ensureRequested(
    directive: ReturnLabelDirective,
    context: EventStoreContext,
  ): Promise<
    | Readonly<{ ok: true; state: ReturnShipmentState; version: number }>
    | Readonly<{ ok: false; result: IssueReturnLabelResult }>
  > {
    const streamId = returnShipmentStreamId(directive.returnShipmentId);
    const existing = await repository.load(streamId);
    if (existing.state.status !== null) {
      return { ok: true, state: existing.state, version: existing.version };
    }

    const asOf = now();
    if (directive.directiveExpiresAt && Date.parse(asOf) > Date.parse(directive.directiveExpiresAt)) {
      return {
        ok: false,
        result: {
          outcome: "failed",
          returnShipmentId: null,
          failureReason: "expired-directive",
          failureDetail: "The return directive expired before a label could be created.",
        },
      };
    }

    const selection = selectReturnFacility(
      deps.facilityDirectory,
      {
        returnProgram: directive.returnProgram,
        carrier: directive.carrier,
        region: directive.region,
        packageWeightOunces: directive.packageRequirements.weightOunces,
        packageLengthInches: directive.packageRequirements.lengthInches,
        packageWidthInches: directive.packageRequirements.widthInches,
        packageHeightInches: directive.packageRequirements.heightInches,
      },
      { asOf, selectionPolicyVersion: directive.selectionPolicyVersion },
    );
    if (selection.outcome !== "selected") {
      return {
        ok: false,
        result: {
          outcome: "failed",
          returnShipmentId: null,
          failureReason: classifyUnselectableFacility(deps.facilityDirectory, directive, asOf),
          failureDetail: selection.reason,
        },
      };
    }

    let shipFromSnapshot: AddressSnapshot;
    try {
      shipFromSnapshot = normalizeAddressSnapshot(directive.shipFromSnapshot, "Return ship-from");
    } catch (error) {
      return {
        ok: false,
        result: {
          outcome: "failed",
          returnShipmentId: null,
          failureReason: "invalid-buyer-address",
          failureDetail: errorMessage(error, "The buyer return address is invalid."),
        },
      };
    }

    try {
      await commandHandler({
        streamId,
        command: {
          type: "RequestReturnShipment",
          returnShipmentId: directive.returnShipmentId,
          remedyId: directive.remedyId,
          supportRequestId: directive.supportRequestId,
          orderId: directive.orderId,
          outboundShipmentId: directive.outboundShipmentId,
          returnDirective: "return-to-platform",
          shipFromSnapshot,
          destinationSnapshot: selection.snapshot,
          packageRequirements: directive.packageRequirements,
          costPayer: directive.costPayer,
          costAllocationReference: directive.costAllocationReference ?? null,
          shipByDeadlineAt: directive.shipByDeadlineAt,
          returnByDeadlineAt: directive.returnByDeadlineAt,
          metadata: metadataFor(directive, "request"),
          requestedAt: asOf,
        },
        context,
      });
    } catch (error) {
      if (!(error instanceof FulfillmentDomainError) && !(error instanceof Error)) {
        throw error;
      }
      return {
        ok: false,
        result: {
          outcome: "failed",
          returnShipmentId: null,
          failureReason: "duplicate-authorization",
          failureDetail: errorMessage(error, "The return directive conflicts with an existing reverse shipment."),
        },
      };
    }
    const reloaded = await repository.load(streamId);
    return { ok: true, state: reloaded.state, version: reloaded.version };
  }

  async function issueReturnLabel(
    directive: ReturnLabelDirective,
    context: EventStoreContext,
  ): Promise<IssueReturnLabelResult> {
    contextRef.current = context;
    const requested = await ensureRequested(directive, context);
    if (!requested.ok) {
      return requested.result;
    }
    const state = requested.state;
    const returnShipmentId = directive.returnShipmentId;

    if (state.labelStatus === "ready") {
      return {
        outcome: "label-ready",
        returnShipmentId,
        version: requested.version,
        trackingIdentifier: state.trackingIdentifier ?? "",
        labelDocumentUrl: state.labelDocumentUrl ?? "",
        postageAmountCents: state.postageAmountCents,
      };
    }
    if (state.status !== "requested") {
      return {
        outcome: "failed",
        returnShipmentId,
        failureReason: "policy-cancelled",
        failureDetail: `Return shipment is ${state.status ?? "unknown"} and can no longer receive a label.`,
      };
    }
    if (directive.directiveExpiresAt && Date.parse(now()) > Date.parse(directive.directiveExpiresAt)) {
      await recordFailureFact(
        directive,
        "expired-directive",
        "The return directive expired before the label was purchased.",
      );
      return {
        outcome: "failed",
        returnShipmentId,
        failureReason: "expired-directive",
        failureDetail: "The return directive expired before the label was purchased.",
      };
    }

    const operationKey = purchaseOperationKey(returnShipmentId);
    const reservation = await recordReturnShipmentLabelOperationPending(deps.db, {
      operationKey,
      operationKind: "purchase-label",
      returnShipmentId,
      remedyId: directive.remedyId,
      providerName: provider.providerName,
      providerMode: provider.providerMode,
      idempotencyKey: operationKey,
      request: {
        serviceLevel: directive.serviceLevel,
        costPayer: directive.costPayer,
        costAllocationReference: directive.costAllocationReference ?? null,
        package: directive.packageRequirements,
      },
      createdAt: now(),
    });

    if (!reservation.operation_reserved) {
      if (reservation.status === "succeeded") {
        return {
          outcome: "label-ready",
          returnShipmentId,
          version: requested.version,
          trackingIdentifier: reservation.tracking_identifier ?? state.trackingIdentifier ?? "",
          labelDocumentUrl: state.labelDocumentUrl ?? "",
          postageAmountCents: state.postageAmountCents,
        };
      }
      if (reservation.status === "provider-succeeded" || returnShipmentLabelOperationHasProviderLabel(reservation)) {
        const recovered = await recoverProviderLabel(reservation);
        if (recovered) {
          return attachReadyLabel(directive, operationKey, recovered, context);
        }
      }
      return { outcome: "in-progress", returnShipmentId };
    }

    const sender = postageAddressFromSnapshot(state.shipFromSnapshot!);
    const recipient = postageAddressFromSnapshot(state.destinationSnapshot!.postalAddress);
    let purchased: PurchasedPostageLabel;
    try {
      purchased = await provider.purchaseUspsLabel({
        shipmentId: returnShipmentId,
        orderId: directive.orderId,
        idempotencyKey: operationKey,
        serviceLevel: directive.serviceLevel,
        sender,
        recipient,
        package: postagePackageFromRequirements(state.packageRequirements!),
      });
    } catch (error) {
      // The provider may have created the label before the call failed (a timeout
      // after success). Recover it under the same idempotency key rather than buying
      // a second label; only when nothing is recoverable is this a real failure.
      const recovered = await recoverProviderLabel(reservation);
      if (recovered) {
        return attachReadyLabel(directive, operationKey, recovered, context);
      }
      const failureReason = purchaseFailureReasonFromError(error);
      const detail = errorMessage(error, "The return label could not be purchased.");
      await recordReturnShipmentLabelOperationFailed(deps.db, { operationKey, errorMessage: detail });
      await recordFailureFact(directive, failureReason, detail);
      return { outcome: "failed", returnShipmentId, failureReason, failureDetail: detail };
    }

    await recordReturnShipmentLabelOperationProviderSucceeded(deps.db, {
      operationKey,
      providerShipmentId: purchased.providerShipmentId,
      providerLabelId: purchased.providerLabelId,
      trackingIdentifier: purchased.trackingIdentifier,
      updatedAt: purchased.purchasedAt,
    });
    return attachReadyLabel(directive, operationKey, purchased, context);
  }

  async function voidReturnLabel(
    params: Readonly<{ returnShipmentId: ReturnShipmentId | string; reason?: string | null }>,
    context: EventStoreContext,
  ): Promise<VoidReturnLabelResult> {
    const returnShipmentId = params.returnShipmentId;
    const streamId = returnShipmentStreamId(returnShipmentId);
    const loaded = await repository.load(streamId);
    const state = loaded.state;
    if (state.status === null) {
      return { outcome: "noop", returnShipmentId, reason: "unknown-return-shipment" };
    }
    if (state.labelStatus === "voided") {
      return { outcome: "noop", returnShipmentId, reason: "already-voided" };
    }
    if (state.labelStatus !== "ready") {
      return { outcome: "noop", returnShipmentId, reason: "no-purchased-label" };
    }
    if (!state.postageProviderShipmentId || !state.postageProviderLabelId || !state.trackingIdentifier) {
      return { outcome: "noop", returnShipmentId, reason: "missing-provider-label" };
    }

    const voidRequestedAt = now();
    const operationKey = `return-shipment:${returnShipmentId}:void-label`;
    await recordReturnShipmentLabelOperationPending(deps.db, {
      operationKey,
      operationKind: "void-label",
      returnShipmentId,
      remedyId: state.remedyId!,
      providerName: provider.providerName,
      providerMode: provider.providerMode,
      idempotencyKey: operationKey,
      request: {
        providerShipmentId: state.postageProviderShipmentId,
        providerLabelId: state.postageProviderLabelId,
        trackingIdentifier: state.trackingIdentifier,
      },
      createdAt: voidRequestedAt,
    });

    let voided;
    try {
      voided = await provider.voidLabel({
        providerShipmentId: state.postageProviderShipmentId,
        providerLabelId: state.postageProviderLabelId,
        trackingIdentifier: state.trackingIdentifier,
      });
    } catch (error) {
      await recordReturnShipmentLabelOperationFailed(deps.db, {
        operationKey,
        errorMessage: errorMessage(error, "The return label void request failed."),
      });
      throw error;
    }

    const result = await commandHandler({
      streamId,
      command: {
        type: "VoidReturnShipmentLabel",
        refundStatus: voided.refundStatus,
        refundReference: voided.refundReference,
        reason: params.reason ?? null,
        metadata: {
          correlationRemedyId: state.remedyId!,
          causationId: `${operationKey}:void`,
          idempotencyKey: operationKey,
          policyVersion: state.policyVersion ?? "return-policy",
        },
        voidedAt: voided.voidedAt,
      },
      context,
      expectedVersion: loaded.version,
    });

    const refundStatus = voided.refundStatus.trim().toLowerCase();
    if (refundStatus === "rejected") {
      await recordReturnShipmentLabelOperationFailed(deps.db, {
        operationKey,
        errorMessage: "The provider rejected the return label refund.",
        completedAt: voided.voidedAt,
      });
    } else {
      await recordReturnShipmentLabelOperationSucceeded(deps.db, {
        operationKey,
        providerShipmentId: state.postageProviderShipmentId,
        providerLabelId: state.postageProviderLabelId,
        trackingIdentifier: state.trackingIdentifier,
        completedAt: voided.voidedAt,
      });
    }

    return { outcome: "voided", returnShipmentId, version: result.version, refundStatus: voided.refundStatus };
  }

  async function reconcileStaleReturnLabelPurchases(
    params: Readonly<{ staleBefore?: string; staleAfterMs?: number; limit?: number }> = {},
    context: EventStoreContext = contextRef.current,
  ): Promise<{ checked: number; attached: number; failed: number }> {
    const staleBefore =
      params.staleBefore ?? new Date(Date.now() - Math.max(1, params.staleAfterMs ?? 5 * 60 * 1000)).toISOString();
    const operations = await listStaleReturnShipmentLabelOperations(deps.db, {
      staleBefore,
      limit: params.limit,
      operationKind: "purchase-label",
    });
    const result = { checked: operations.length, attached: 0, failed: 0 };
    for (const operation of operations) {
      const recovered = await recoverProviderLabel(operation);
      if (!recovered) {
        await recordReturnShipmentLabelOperationFailed(deps.db, {
          operationKey: operation.operation_key,
          errorMessage: "No purchased provider label was recoverable for the stale return-label operation.",
        });
        result.failed += 1;
        continue;
      }
      const loaded = await repository.load(returnShipmentStreamId(operation.return_shipment_id));
      if (loaded.state.status !== "requested") {
        await recordReturnShipmentLabelOperationSucceeded(deps.db, {
          operationKey: operation.operation_key,
          providerShipmentId: recovered.providerShipmentId,
          providerLabelId: recovered.providerLabelId,
          trackingIdentifier: recovered.trackingIdentifier,
          completedAt: recovered.purchasedAt,
        });
        result.attached += 1;
        continue;
      }
      await commandHandler({
        streamId: returnShipmentStreamId(operation.return_shipment_id),
        command: {
          type: "MarkReturnShipmentLabelReady",
          carrierName: recovered.carrierName,
          trackingIdentifier: recovered.trackingIdentifier,
          labelProviderReference: recovered.labelReference,
          labelDocumentUrl: recovered.labelDocumentUrl,
          postageProviderName: recovered.providerName,
          postageProviderMode: recovered.providerMode,
          postageProviderShipmentId: recovered.providerShipmentId,
          postageProviderLabelId: recovered.providerLabelId,
          postageAmountCents: recovered.postageAmountCents,
          estimatedPostageAmountCents: null,
          postageCurrency: recovered.postageCurrency,
          metadata: {
            correlationRemedyId: loaded.state.remedyId!,
            causationId: `${operation.operation_key}:recover`,
            idempotencyKey: operation.idempotency_key,
            policyVersion: loaded.state.policyVersion ?? "return-policy",
          },
          readyAt: recovered.purchasedAt,
        },
        context,
      });
      await recordReturnShipmentLabelOperationSucceeded(deps.db, {
        operationKey: operation.operation_key,
        providerShipmentId: recovered.providerShipmentId,
        providerLabelId: recovered.providerLabelId,
        trackingIdentifier: recovered.trackingIdentifier,
        completedAt: recovered.purchasedAt,
      });
      result.attached += 1;
    }
    return result;
  }

  return { issueReturnLabel, voidReturnLabel, reconcileStaleReturnLabelPurchases };
}
