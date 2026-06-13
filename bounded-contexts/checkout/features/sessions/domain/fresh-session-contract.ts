import type {
  AccountId,
  CheckoutSessionId,
  OrderId,
  PaymentId,
  PayoutId,
  ShipmentId,
} from "@chase-sets/primitives/typed-ids";

export type CheckoutFlowMode = "buy" | "sell";
export type CheckoutActorMode = "guest" | "signed-in";
export type CheckoutLifecycleStatus = "draft" | "ready" | "confirming" | "confirmed" | "failed" | "recovering";
export type CheckoutReadinessStatus = "ready" | "needs-resolution" | "blocked";
export type CheckoutFreshnessStatus = "current" | "stale" | "refreshing";
export type CheckoutFreshnessReason =
  | "source-changed"
  | "fulfillment-changed"
  | "shipping-changed"
  | "tax-changed"
  | "fees-changed"
  | "discounts-changed"
  | "credits-changed"
  | "provider-skew"
  | "unknown";
export type CheckoutProviderStatus = "ready" | "pending" | "failed" | "unavailable";
export type CheckoutRiskStatus = "clear" | "held" | "blocked";
export type CheckoutValidationStatus = "valid" | "missing" | "invalid" | "restricted";
export type CheckoutSavedRowStatus = "ready" | "missing" | "editable" | "invalid";
export type CheckoutRecoveryReason =
  | "stale-session"
  | "provider-failure"
  | "partial-completion"
  | "invalid-address"
  | "unresolved-fulfillment"
  | "seller-readiness"
  | "risk-review";

export type CheckoutMoney = Readonly<{
  amount: string;
  currency: string;
}>;

export type FreshCheckoutLineSummary = Readonly<{
  lineId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  thumbnailUrl: string | null;
  quantity: number;
  unitAmount: CheckoutMoney;
  lineAmount: CheckoutMoney;
  fulfillmentStatus: CheckoutReadinessStatus;
  customerFacts: readonly string[];
}>;

export type FreshCheckoutContactState = Readonly<{
  status: CheckoutValidationStatus;
  email: string | null;
  phone: string | null;
  displayName: string | null;
}>;

export type FreshCheckoutAddressState = Readonly<{
  status: CheckoutValidationStatus;
  label: string | null;
  summary: string | null;
  correctionAvailable: boolean;
  serviceability: "serviceable" | "restricted" | "unknown";
}>;

export type FreshCheckoutShippingState = Readonly<{
  status: CheckoutValidationStatus;
  selectedMethodId: string | null;
  label: string | null;
  amount: CheckoutMoney | null;
  promise: string | null;
}>;

export type FreshCheckoutPaymentState = Readonly<{
  status: CheckoutValidationStatus;
  selectedMethodId: string | null;
  displayLabel: string | null;
  providerStatus: CheckoutProviderStatus;
  savedForFuture: boolean;
}>;

export type FreshCheckoutPayoutState = Readonly<{
  status: CheckoutValidationStatus;
  selectedMethodId: string | null;
  displayLabel: string | null;
  providerStatus: CheckoutProviderStatus;
  readinessStatus: CheckoutReadinessStatus;
}>;

export type FreshCheckoutReadinessState = Readonly<{
  status: CheckoutReadinessStatus;
  unresolvedLineIds: readonly string[];
  optimization: Readonly<{
    available: boolean;
    savings: CheckoutMoney | null;
    accepted: boolean | null;
  }>;
  recoveryPath: string | null;
}>;

export type FreshCheckoutRecoveryState = Readonly<{
  reason: CheckoutRecoveryReason;
  command: FreshCheckoutCommandType;
  returnPath: string;
  customerSafeMessage: string;
}>;

export type FreshCheckoutProviderState = Readonly<{
  status: CheckoutProviderStatus;
  correlationId: string | null;
  retryAvailable: boolean;
  customerSafeMessage: string | null;
}>;

export type FreshCheckoutRiskState = Readonly<{
  status: CheckoutRiskStatus;
  customerSafeReason: string | null;
  recoveryPath: string | null;
}>;

export type FreshCheckoutCommunicationState = Readonly<{
  notificationStatus: "not-started" | "queued" | "sent" | "failed";
  retryAvailable: boolean;
}>;

export type FreshCheckoutReconciliationState = Readonly<{
  status: "not-started" | "pending" | "complete" | "failed";
  pendingFacts: readonly string[];
  retryAvailable: boolean;
}>;

export type FreshCheckoutPostConfirmationHandoff = Readonly<{
  status: "not-started" | "pending" | "ready" | "failed";
  orderIds: readonly OrderId[];
  saleIds: readonly string[];
  shipmentIds: readonly ShipmentId[];
  paymentId: PaymentId | null;
  payoutId: PayoutId | null;
  accountHistoryHref: string | null;
}>;

export type FreshCheckoutSplitGroupHandoff = Readonly<{
  status: "not-started" | "ready" | "pending" | "failed";
  groups: readonly Readonly<{
    groupId: string;
    lineIds: readonly string[];
    listingIds: readonly string[];
    sellerAccountId: AccountId | null;
    sellerDisplayName: string | null;
    packageCount: number;
    itemCount: number;
    deliveryPromise: string | null;
    shippingAmount: CheckoutMoney | null;
    supportReference: string;
    downstreamReferenceStatus: "not-started" | "pending" | "ready" | "failed";
    orderIds: readonly OrderId[];
    shipmentIds: readonly ShipmentId[];
  }>[];
  supportReference: string | null;
}>;

export type FreshCheckoutSavedInfoRow = Readonly<{
  kind: "contact" | "shipping-address" | "ship-from-address" | "payment-method" | "payout-method";
  status: CheckoutSavedRowStatus;
  label: string;
  summary: string | null;
  editCommand: FreshCheckoutCommandType | null;
}>;

export type FreshBuyCheckoutTotals = Readonly<{
  subtotal: CheckoutMoney;
  shipping: CheckoutMoney | null;
  tax: CheckoutMoney | null;
  fees: readonly CheckoutMoney[];
  discounts: readonly CheckoutMoney[];
  credits: readonly CheckoutMoney[];
  payableTotal: CheckoutMoney;
}>;

export type FreshSellCheckoutTotals = Readonly<{
  estimatedPayout: CheckoutMoney;
  labelOrShippingAllowance: CheckoutMoney | null;
  fees: readonly CheckoutMoney[];
  adjustments: readonly CheckoutMoney[];
  payoutTotal: CheckoutMoney;
  verificationTermsAccepted: boolean;
}>;

export type FreshCheckoutSessionBase = Readonly<{
  schemaVersion: "checkout.fresh-session.v1";
  sessionId: CheckoutSessionId;
  creationIdempotencyKey: string;
  mode: CheckoutFlowMode;
  actorMode: CheckoutActorMode;
  accountId: AccountId | null;
  guestMerge: Readonly<{
    eligible: boolean;
    mergeToken: string | null;
    signedInAccountId: AccountId | null;
  }>;
  lifecycleStatus: CheckoutLifecycleStatus;
  source: Readonly<{
    type: "cart" | "buy-now" | "sell-list";
    sourceId: string | null;
    returnPath: string;
  }>;
  lines: readonly FreshCheckoutLineSummary[];
  contact: FreshCheckoutContactState;
  deliveryAddress: FreshCheckoutAddressState | null;
  shipFromAddress: FreshCheckoutAddressState | null;
  shipping: FreshCheckoutShippingState | null;
  readiness: FreshCheckoutReadinessState;
  freshness: Readonly<{
    status: CheckoutFreshnessStatus;
    reason: CheckoutFreshnessReason | null;
    revision: string | null;
    recoverCommand: FreshCheckoutCommandType | null;
  }>;
  provider: FreshCheckoutProviderState;
  risk: FreshCheckoutRiskState;
  recovery: FreshCheckoutRecoveryState | null;
  communication: FreshCheckoutCommunicationState;
  reconciliation: FreshCheckoutReconciliationState;
  splitGroupHandoff: FreshCheckoutSplitGroupHandoff | null;
  postConfirmation: FreshCheckoutPostConfirmationHandoff;
  savedInfoRows: readonly FreshCheckoutSavedInfoRow[];
  availableCommands: readonly FreshCheckoutCommandType[];
}>;

export type FreshBuyCheckoutSessionSnapshot = FreshCheckoutSessionBase &
  Readonly<{
    mode: "buy";
    payment: FreshCheckoutPaymentState;
    payout: null;
    totals: FreshBuyCheckoutTotals;
  }>;

export type FreshSellCheckoutSessionSnapshot = FreshCheckoutSessionBase &
  Readonly<{
    mode: "sell";
    payment: null;
    payout: FreshCheckoutPayoutState;
    totals: FreshSellCheckoutTotals;
  }>;

export type FreshCheckoutSessionSnapshot = FreshBuyCheckoutSessionSnapshot | FreshSellCheckoutSessionSnapshot;

export const freshCheckoutCommandTypes = [
  "update-contact",
  "update-address",
  "select-shipping-method",
  "select-payment-method",
  "select-payout-method",
  "apply-credit-or-promotion",
  "remove-credit-or-promotion",
  "refresh-totals",
  "confirm",
  "recover-stale-session",
  "recover-provider-failure",
  "recover-partial-completion",
  "merge-guest-session",
  "return-to-source-list",
] as const;

export type FreshCheckoutCommandType = (typeof freshCheckoutCommandTypes)[number];

export const freshCheckoutStateTransitions = {
  draft: ["ready", "failed", "recovering"],
  ready: ["confirming", "recovering", "failed"],
  confirming: ["confirmed", "recovering", "failed"],
  confirmed: [],
  failed: ["recovering"],
  recovering: ["ready", "failed"],
} as const satisfies Record<CheckoutLifecycleStatus, readonly CheckoutLifecycleStatus[]>;

export const forbiddenFreshCheckoutCommandTypes = [
  "start-old-checkout",
  "load-dense-checkout-session",
  "adapt-old-checkout-payload",
  "dual-write-old-session",
] as const;

export function isFreshCheckoutCommandType(value: string): value is FreshCheckoutCommandType {
  return freshCheckoutCommandTypes.includes(value as FreshCheckoutCommandType);
}

export function hasForbiddenFreshCheckoutCommand(commands: readonly string[]) {
  return commands.some((command) =>
    forbiddenFreshCheckoutCommandTypes.includes(command as (typeof forbiddenFreshCheckoutCommandTypes)[number]),
  );
}

export function canTransitionFreshCheckout(from: CheckoutLifecycleStatus, to: CheckoutLifecycleStatus) {
  return (freshCheckoutStateTransitions[from] as readonly CheckoutLifecycleStatus[]).includes(to);
}

export function requiresPreCheckoutResolution(snapshot: FreshCheckoutSessionSnapshot) {
  return (
    snapshot.readiness.status !== "ready" ||
    snapshot.readiness.unresolvedLineIds.length > 0 ||
    snapshot.lines.some((line) => line.fulfillmentStatus !== "ready")
  );
}

export function canConfirmFreshCheckout(snapshot: FreshCheckoutSessionSnapshot) {
  if (snapshot.lifecycleStatus !== "ready" || requiresPreCheckoutResolution(snapshot)) {
    return false;
  }

  if (
    snapshot.freshness.status !== "current" ||
    snapshot.provider.status !== "ready" ||
    snapshot.risk.status !== "clear"
  ) {
    return false;
  }

  if (snapshot.mode === "buy") {
    return (
      snapshot.contact.status === "valid" &&
      snapshot.deliveryAddress?.status === "valid" &&
      snapshot.payment.status === "valid"
    );
  }

  return (
    snapshot.shipFromAddress?.status === "valid" &&
    snapshot.payout.status === "valid" &&
    snapshot.payout.readinessStatus === "ready"
  );
}

export function renderableCheckoutSummary(snapshot: FreshCheckoutSessionSnapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    sessionId: snapshot.sessionId,
    mode: snapshot.mode,
    actorMode: snapshot.actorMode,
    lifecycleStatus: snapshot.lifecycleStatus,
    lineCount: snapshot.lines.length,
    total: snapshot.mode === "buy" ? snapshot.totals.payableTotal : snapshot.totals.payoutTotal,
    readinessStatus: snapshot.readiness.status,
    freshnessStatus: snapshot.freshness.status,
    providerStatus: snapshot.provider.status,
    riskStatus: snapshot.risk.status,
    splitGroupCount: snapshot.splitGroupHandoff?.groups.length ?? 0,
    postConfirmationStatus: snapshot.postConfirmation.status,
    primaryAction: canConfirmFreshCheckout(snapshot) ? "confirm" : "resolve",
  } as const;
}

const sensitiveKeyPatterns = [
  /secret/i,
  /cardNumber/i,
  /cvc/i,
  /cvv/i,
  /accountNumber/i,
  /bankAccount/i,
  /routingNumber/i,
  /taxId/i,
  /identityPayload/i,
  /rawProvider/i,
  /verificationDocument/i,
] as const;

export function findSensitiveCheckoutSnapshotKeys(value: unknown, path = "snapshot"): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findSensitiveCheckoutSnapshotKeys(item, `${path}[${index}]`));
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => {
    const nestedPath = `${path}.${key}`;
    const keyMatches = sensitiveKeyPatterns.some((pattern) => pattern.test(key)) ? [nestedPath] : [];
    return [...keyMatches, ...findSensitiveCheckoutSnapshotKeys(nested, nestedPath)];
  });
}

const internalCopyPatterns = [
  /\bprojection\b/i,
  /\bread model\b/i,
  /\ballocation\b/i,
  /\bprovider payload\b/i,
  /\binternal\b/i,
  /\bdual write\b/i,
  /\bold checkout\b/i,
] as const;

export function findCheckoutCustomerCopyLeaks(snapshot: FreshCheckoutSessionSnapshot) {
  const customerCopy = [
    ...snapshot.lines.flatMap((line) => [line.itemTitle, line.itemSubtitle, ...line.customerFacts]),
    snapshot.contact.displayName,
    snapshot.deliveryAddress?.label,
    snapshot.deliveryAddress?.summary,
    snapshot.shipFromAddress?.label,
    snapshot.shipFromAddress?.summary,
    snapshot.shipping?.label,
    snapshot.shipping?.promise,
    snapshot.readiness.recoveryPath,
    snapshot.provider.customerSafeMessage,
    snapshot.risk.customerSafeReason,
    snapshot.risk.recoveryPath,
    snapshot.recovery?.customerSafeMessage,
    snapshot.recovery?.returnPath,
    ...snapshot.savedInfoRows.flatMap((row) => [row.label, row.summary]),
  ].filter((value): value is string => typeof value === "string");

  return customerCopy.filter((value) => internalCopyPatterns.some((pattern) => pattern.test(value)));
}
