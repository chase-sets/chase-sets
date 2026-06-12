export const checkoutTransactionalNotificationPolicyDocPath =
  "bounded-contexts/checkout/docs/checkout-transactional-notifications.md" as const;

export type CheckoutNotificationAudience =
  | "guest-buyer"
  | "signed-in-buyer"
  | "guest-seller"
  | "signed-in-seller"
  | "support-operator";

export type CheckoutNotificationSourceOwner =
  | "Checkout"
  | "Ordering"
  | "Payments"
  | "Fulfillment"
  | "Settlement"
  | "Notifications"
  | "Support";

export type CheckoutNotificationChannel = "transactional-email" | "notification-center" | "support-evidence" | "none";

export type CheckoutNotificationLaunchDecision =
  | "required-for-launch"
  | "deferred-with-launch-register"
  | "not-customer-facing";

export type CheckoutNotificationTriggerTiming =
  | "before-confirmation"
  | "on-checkout-confirmation"
  | "after-owning-context-commit"
  | "failure-recovery"
  | "operator-support";

export type CheckoutNotificationOwnerIssue =
  | "#1114"
  | "#1115"
  | "#1116"
  | "#1117"
  | "#1118"
  | "#1119"
  | "#1120"
  | "#1121"
  | "#1122"
  | "#1129"
  | "#1130"
  | "#1135"
  | "#1164"
  | "#1165";

export type CheckoutNotificationTriggerKey =
  | "pre-confirmation-recovery-no-send"
  | "buy-order-confirmation"
  | "buy-payment-captured"
  | "buy-payment-failed"
  | "guest-receipt-and-account-claim"
  | "sell-confirmation-recorded"
  | "seller-sale-committed"
  | "label-or-shipping-next-step"
  | "downstream-handoff-failed"
  | "support-request-opened"
  | "support-request-resolved"
  | "refund-issued"
  | "refund-failed"
  | "missing-contact-fallback"
  | "duplicate-prevention";

export type CheckoutTransactionalNotificationPolicyEntry = Readonly<{
  trigger: CheckoutNotificationTriggerKey;
  docLabel: string;
  ownerIssues: readonly CheckoutNotificationOwnerIssue[];
  sourceOwner: CheckoutNotificationSourceOwner;
  sourceFact: string;
  timing: CheckoutNotificationTriggerTiming;
  launchDecision: CheckoutNotificationLaunchDecision;
  audiences: readonly CheckoutNotificationAudience[];
  channels: readonly CheckoutNotificationChannel[];
  messageTypes: readonly string[];
  idempotencyKeyShape: string;
  supportReferenceRequired: boolean;
  pendingDownstreamBoundaryRequired: boolean;
  noCustomerCommittingSideEffectBeforeConfirmation: boolean;
  duplicatePreventionRequired: boolean;
  missingContactFallback: "web-only" | "support-runbook" | "not-applicable";
  accountClaimBehavior: "order-receipt-only" | "deferred-with-launch-register" | "not-applicable";
  evidenceExpectation: string;
}>;

const buyerAudiences = ["guest-buyer", "signed-in-buyer"] as const satisfies readonly CheckoutNotificationAudience[];
const sellerAudiences = ["guest-seller", "signed-in-seller"] as const satisfies readonly CheckoutNotificationAudience[];
const allCustomerAudiences = [
  "guest-buyer",
  "signed-in-buyer",
  "guest-seller",
  "signed-in-seller",
] as const satisfies readonly CheckoutNotificationAudience[];

export const checkoutTransactionalNotificationRequiredTriggers = [
  "pre-confirmation-recovery-no-send",
  "buy-order-confirmation",
  "buy-payment-captured",
  "buy-payment-failed",
  "guest-receipt-and-account-claim",
  "sell-confirmation-recorded",
  "seller-sale-committed",
  "label-or-shipping-next-step",
  "downstream-handoff-failed",
  "support-request-opened",
  "support-request-resolved",
  "refund-issued",
  "refund-failed",
  "missing-contact-fallback",
  "duplicate-prevention",
] as const satisfies readonly CheckoutNotificationTriggerKey[];

export const checkoutTransactionalNotificationPolicyEntries = [
  notificationPolicy({
    trigger: "pre-confirmation-recovery-no-send",
    docLabel: "Pre-confirmation recovery does not send",
    ownerIssues: ["#1129", "#1117", "#1119", "#1116"],
    sourceOwner: "Checkout",
    sourceFact:
      "Readiness, active-session, provider-return, kill-switch, or stale-session recovery before confirmation.",
    timing: "before-confirmation",
    launchDecision: "not-customer-facing",
    audiences: allCustomerAudiences,
    channels: ["none"],
    messageTypes: [],
    idempotencyKeyShape: "not-applicable-before-confirmation",
    supportReferenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    noCustomerCommittingSideEffectBeforeConfirmation: true,
    duplicatePreventionRequired: true,
    missingContactFallback: "not-applicable",
    accountClaimBehavior: "not-applicable",
    evidenceExpectation:
      "Recovery evidence proves no payment, order, sale, label, payout, settlement, notification, account-history, support, refund, void, or reversal side effect started.",
  }),
  notificationPolicy({
    trigger: "buy-order-confirmation",
    docLabel: "Buyer order confirmation",
    ownerIssues: ["#1129", "#1120", "#1130", "#1135"],
    sourceOwner: "Ordering",
    sourceFact: "Ordering-owned order created fact after Checkout confirmation and payment/order handoff.",
    timing: "after-owning-context-commit",
    launchDecision: "required-for-launch",
    audiences: buyerAudiences,
    channels: ["transactional-email", "notification-center"],
    messageTypes: ["ordering.order.created"],
    idempotencyKeyShape: "ordering:order_confirmed:<order-id>",
    supportReferenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    noCustomerCommittingSideEffectBeforeConfirmation: true,
    duplicatePreventionRequired: true,
    missingContactFallback: "web-only",
    accountClaimBehavior: "order-receipt-only",
    evidenceExpectation:
      "Order confirmation includes totals and support reference after Ordering commits the order; guest receipt uses contact email or web receipt lookup without old checkout links.",
  }),
  notificationPolicy({
    trigger: "buy-payment-captured",
    docLabel: "Buyer payment captured",
    ownerIssues: ["#1129", "#1130"],
    sourceOwner: "Payments",
    sourceFact: "Payments-owned payment captured fact.",
    timing: "after-owning-context-commit",
    launchDecision: "required-for-launch",
    audiences: buyerAudiences,
    channels: ["transactional-email"],
    messageTypes: ["payments.payment-captured"],
    idempotencyKeyShape: "payments:payment_captured:<payment-id>",
    supportReferenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    noCustomerCommittingSideEffectBeforeConfirmation: true,
    duplicatePreventionRequired: true,
    missingContactFallback: "support-runbook",
    accountClaimBehavior: "order-receipt-only",
    evidenceExpectation:
      "Payment captured notification is idempotent by payment id and does not resend on confirmation page reload.",
  }),
  notificationPolicy({
    trigger: "buy-payment-failed",
    docLabel: "Buyer payment failed",
    ownerIssues: ["#1129", "#1130", "#1122"],
    sourceOwner: "Payments",
    sourceFact: "Payments-owned payment failed fact or provider failure recovery.",
    timing: "failure-recovery",
    launchDecision: "required-for-launch",
    audiences: buyerAudiences,
    channels: ["transactional-email", "support-evidence"],
    messageTypes: ["payments.payment-failed"],
    idempotencyKeyShape: "payments:payment_failed:<payment-id>",
    supportReferenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    noCustomerCommittingSideEffectBeforeConfirmation: true,
    duplicatePreventionRequired: true,
    missingContactFallback: "support-runbook",
    accountClaimBehavior: "order-receipt-only",
    evidenceExpectation:
      "Payment failure communication is customer-safe, support-visible, and does not imply an order or refund exists unless Payments records it.",
  }),
  notificationPolicy({
    trigger: "guest-receipt-and-account-claim",
    docLabel: "Guest receipt and account claim",
    ownerIssues: ["#1129", "#1118", "#1120", "#1121"],
    sourceOwner: "Checkout",
    sourceFact: "Guest checkout confirmation plus Ordering receipt destination.",
    timing: "after-owning-context-commit",
    launchDecision: "required-for-launch",
    audiences: ["guest-buyer"],
    channels: ["transactional-email", "support-evidence"],
    messageTypes: ["ordering.order.created"],
    idempotencyKeyShape: "ordering:order_confirmed:<order-id>",
    supportReferenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    noCustomerCommittingSideEffectBeforeConfirmation: true,
    duplicatePreventionRequired: true,
    missingContactFallback: "support-runbook",
    accountClaimBehavior: "deferred-with-launch-register",
    evidenceExpectation:
      "Guest receipts use order confirmation and support-safe lookup; account claim/link behavior is launch-registered if not enabled.",
  }),
  notificationPolicy({
    trigger: "sell-confirmation-recorded",
    docLabel: "Seller confirmation recorded",
    ownerIssues: ["#1129", "#1120", "#1135"],
    sourceOwner: "Checkout",
    sourceFact: "Checkout-owned sell confirmation and Marketplace handoff recorded with downstream status pending.",
    timing: "on-checkout-confirmation",
    launchDecision: "deferred-with-launch-register",
    audiences: sellerAudiences,
    channels: ["support-evidence"],
    messageTypes: [],
    idempotencyKeyShape: "checkout:sell_confirmation_recorded:<confirmation-id>",
    supportReferenceRequired: true,
    pendingDownstreamBoundaryRequired: true,
    noCustomerCommittingSideEffectBeforeConfirmation: true,
    duplicatePreventionRequired: true,
    missingContactFallback: "support-runbook",
    accountClaimBehavior: "not-applicable",
    evidenceExpectation:
      "Checkout records seller confirmation and support reference, but does not send sale-complete copy before downstream owners commit sale, label, payout, settlement, notification, or account-history facts.",
  }),
  notificationPolicy({
    trigger: "seller-sale-committed",
    docLabel: "Seller sale committed",
    ownerIssues: ["#1129", "#1135", "#1130"],
    sourceOwner: "Settlement",
    sourceFact: "Downstream sale, payout, and settlement status committed by owning contexts.",
    timing: "after-owning-context-commit",
    launchDecision: "deferred-with-launch-register",
    audiences: sellerAudiences,
    channels: ["support-evidence"],
    messageTypes: [],
    idempotencyKeyShape: "seller:sale_committed:<sale-or-handoff-id>",
    supportReferenceRequired: true,
    pendingDownstreamBoundaryRequired: true,
    noCustomerCommittingSideEffectBeforeConfirmation: true,
    duplicatePreventionRequired: true,
    missingContactFallback: "support-runbook",
    accountClaimBehavior: "not-applicable",
    evidenceExpectation:
      "Seller sale communication needs owner-approved launch status before public launch; until then account activity/support evidence must not imply completed downstream facts.",
  }),
  notificationPolicy({
    trigger: "label-or-shipping-next-step",
    docLabel: "Label or shipping next step",
    ownerIssues: ["#1129", "#1135", "#1164"],
    sourceOwner: "Fulfillment",
    sourceFact: "Fulfillment-owned label, tracking, or shipment status fact.",
    timing: "after-owning-context-commit",
    launchDecision: "deferred-with-launch-register",
    audiences: sellerAudiences,
    channels: ["support-evidence"],
    messageTypes: [],
    idempotencyKeyShape: "fulfillment:shipping_next_step:<shipment-or-label-id>",
    supportReferenceRequired: true,
    pendingDownstreamBoundaryRequired: true,
    noCustomerCommittingSideEffectBeforeConfirmation: true,
    duplicatePreventionRequired: true,
    missingContactFallback: "support-runbook",
    accountClaimBehavior: "not-applicable",
    evidenceExpectation:
      "Shipping next-step communication waits for Fulfillment-owned label/tracking facts and must handle split-group shipments without exposing seller allocation internals.",
  }),
  notificationPolicy({
    trigger: "downstream-handoff-failed",
    docLabel: "Downstream handoff failed",
    ownerIssues: ["#1129", "#1122", "#1130", "#1135"],
    sourceOwner: "Checkout",
    sourceFact: "Checkout confirmation/handoff row records downstream failed or support-required status.",
    timing: "failure-recovery",
    launchDecision: "required-for-launch",
    audiences: allCustomerAudiences,
    channels: ["support-evidence"],
    messageTypes: [],
    idempotencyKeyShape: "checkout:handoff_failed:<confirmation-or-handoff-id>",
    supportReferenceRequired: true,
    pendingDownstreamBoundaryRequired: true,
    noCustomerCommittingSideEffectBeforeConfirmation: true,
    duplicatePreventionRequired: true,
    missingContactFallback: "support-runbook",
    accountClaimBehavior: "not-applicable",
    evidenceExpectation:
      "Failed handoff communication is support-safe and routes to the owning context without synthesizing order, sale, label, payout, settlement, notification, or account-history completion.",
  }),
  notificationPolicy({
    trigger: "support-request-opened",
    docLabel: "Support request opened",
    ownerIssues: ["#1129", "#1122"],
    sourceOwner: "Support",
    sourceFact: "Support request opened for a committed order source.",
    timing: "operator-support",
    launchDecision: "required-for-launch",
    audiences: ["signed-in-buyer", "signed-in-seller", "support-operator"],
    channels: ["transactional-email", "support-evidence"],
    messageTypes: ["support.support-request.opened"],
    idempotencyKeyShape: "support:support_request_opened:<support-request-id>",
    supportReferenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    noCustomerCommittingSideEffectBeforeConfirmation: true,
    duplicatePreventionRequired: true,
    missingContactFallback: "support-runbook",
    accountClaimBehavior: "not-applicable",
    evidenceExpectation:
      "Support request opened notification is tied to a support request id and an existing order source; pre-confirmation checkout recovery does not create fake support requests.",
  }),
  notificationPolicy({
    trigger: "support-request-resolved",
    docLabel: "Support request resolved",
    ownerIssues: ["#1129", "#1122", "#1165"],
    sourceOwner: "Support",
    sourceFact: "Support request resolved after evidence and downstream owner status are recorded.",
    timing: "operator-support",
    launchDecision: "required-for-launch",
    audiences: ["signed-in-buyer", "signed-in-seller", "support-operator"],
    channels: ["transactional-email", "support-evidence"],
    messageTypes: ["support.support-request.resolved"],
    idempotencyKeyShape: "support:support_request_resolved:<support-request-id>",
    supportReferenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    noCustomerCommittingSideEffectBeforeConfirmation: true,
    duplicatePreventionRequired: true,
    missingContactFallback: "support-runbook",
    accountClaimBehavior: "not-applicable",
    evidenceExpectation:
      "Support resolution notification waits for Support lifecycle evidence and downstream refund/hold facts where relevant.",
  }),
  notificationPolicy({
    trigger: "refund-issued",
    docLabel: "Refund issued",
    ownerIssues: ["#1129", "#1130", "#1165"],
    sourceOwner: "Payments",
    sourceFact: "Payments-owned refund issued fact.",
    timing: "after-owning-context-commit",
    launchDecision: "required-for-launch",
    audiences: buyerAudiences,
    channels: ["transactional-email", "support-evidence"],
    messageTypes: ["payments.refund-issued"],
    idempotencyKeyShape: "payments:refund_issued:<refund-id>",
    supportReferenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    noCustomerCommittingSideEffectBeforeConfirmation: true,
    duplicatePreventionRequired: true,
    missingContactFallback: "support-runbook",
    accountClaimBehavior: "order-receipt-only",
    evidenceExpectation:
      "Refund issued communication is idempotent by refund id and does not duplicate across provider webhook replay or support recovery.",
  }),
  notificationPolicy({
    trigger: "refund-failed",
    docLabel: "Refund failed",
    ownerIssues: ["#1129", "#1130", "#1165"],
    sourceOwner: "Payments",
    sourceFact: "Payments-owned refund failed fact.",
    timing: "failure-recovery",
    launchDecision: "required-for-launch",
    audiences: buyerAudiences,
    channels: ["transactional-email", "support-evidence"],
    messageTypes: ["payments.refund-failed"],
    idempotencyKeyShape: "payments:refund_failed:<refund-id>",
    supportReferenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    noCustomerCommittingSideEffectBeforeConfirmation: true,
    duplicatePreventionRequired: true,
    missingContactFallback: "support-runbook",
    accountClaimBehavior: "order-receipt-only",
    evidenceExpectation:
      "Refund failed communication is support-safe and does not claim refund completion before Payments records it.",
  }),
  notificationPolicy({
    trigger: "missing-contact-fallback",
    docLabel: "Missing contact fallback",
    ownerIssues: ["#1129", "#1121", "#1122"],
    sourceOwner: "Checkout",
    sourceFact: "Checkout or owning downstream context cannot resolve a deliverable customer contact.",
    timing: "failure-recovery",
    launchDecision: "required-for-launch",
    audiences: allCustomerAudiences,
    channels: ["support-evidence"],
    messageTypes: [],
    idempotencyKeyShape: "checkout:missing_contact:<support-safe-reference>",
    supportReferenceRequired: true,
    pendingDownstreamBoundaryRequired: false,
    noCustomerCommittingSideEffectBeforeConfirmation: true,
    duplicatePreventionRequired: true,
    missingContactFallback: "support-runbook",
    accountClaimBehavior: "order-receipt-only",
    evidenceExpectation:
      "Missing contact evidence routes to account/support surfaces and never falls back to old checkout recovery emails or raw provider/customer data.",
  }),
  notificationPolicy({
    trigger: "duplicate-prevention",
    docLabel: "Duplicate prevention",
    ownerIssues: ["#1129", "#1130", "#1115"],
    sourceOwner: "Notifications",
    sourceFact: "Durable outbox idempotency and source-owner idempotency keys for transactional communication.",
    timing: "after-owning-context-commit",
    launchDecision: "required-for-launch",
    audiences: allCustomerAudiences,
    channels: ["support-evidence"],
    messageTypes: [],
    idempotencyKeyShape: "<source-owner>:<message-type>:<stable-source-id>",
    supportReferenceRequired: true,
    pendingDownstreamBoundaryRequired: true,
    noCustomerCommittingSideEffectBeforeConfirmation: true,
    duplicatePreventionRequired: true,
    missingContactFallback: "support-runbook",
    accountClaimBehavior: "order-receipt-only",
    evidenceExpectation:
      "Launch evidence covers reload, duplicate submit, job retry, provider webhook replay, and operator recovery without duplicate messages.",
  }),
] as const satisfies readonly CheckoutTransactionalNotificationPolicyEntry[];

export function assertCheckoutTransactionalNotificationPolicyCoverage(): void {
  const byTrigger = new Map(checkoutTransactionalNotificationPolicyEntries.map((entry) => [entry.trigger, entry]));

  for (const trigger of checkoutTransactionalNotificationRequiredTriggers) {
    if (!byTrigger.has(trigger)) {
      throw new Error(`Missing checkout transactional notification policy for '${trigger}'.`);
    }
  }

  if (byTrigger.size !== checkoutTransactionalNotificationPolicyEntries.length) {
    throw new Error("Checkout transactional notification policy triggers must be unique.");
  }

  for (const entry of checkoutTransactionalNotificationPolicyEntries) {
    if (!entry.ownerIssues.includes("#1129")) {
      throw new Error(`Checkout notification policy '${entry.trigger}' must include #1129 as an owner issue.`);
    }
    if (entry.docLabel.trim().length === 0 || entry.sourceFact.trim().length === 0) {
      throw new Error(`Checkout notification policy '${entry.trigger}' needs documentation text.`);
    }
    if (entry.audiences.length === 0) {
      throw new Error(`Checkout notification policy '${entry.trigger}' needs an audience.`);
    }
    if (entry.channels.length === 0) {
      throw new Error(`Checkout notification policy '${entry.trigger}' needs a channel decision.`);
    }
    if (entry.evidenceExpectation.trim().length === 0) {
      throw new Error(`Checkout notification policy '${entry.trigger}' needs launch evidence expectations.`);
    }
    if (entry.duplicatePreventionRequired && entry.idempotencyKeyShape.trim().length === 0) {
      throw new Error(`Checkout notification policy '${entry.trigger}' needs an idempotency key shape.`);
    }
    if (entry.channels.includes("none") && (entry.channels.length > 1 || entry.messageTypes.length > 0)) {
      throw new Error(`Checkout notification policy '${entry.trigger}' cannot mix no-send with message types.`);
    }
    if (entry.timing === "before-confirmation") {
      if (entry.messageTypes.length > 0 || !entry.channels.includes("none")) {
        throw new Error(`Checkout notification policy '${entry.trigger}' must not send before confirmation.`);
      }
      if (!entry.noCustomerCommittingSideEffectBeforeConfirmation) {
        throw new Error(
          `Checkout notification policy '${entry.trigger}' must prove no side effects before confirmation.`,
        );
      }
    }
    if (entry.pendingDownstreamBoundaryRequired && !entry.supportReferenceRequired) {
      throw new Error(
        `Checkout notification policy '${entry.trigger}' needs a support reference for pending boundary.`,
      );
    }
    if (
      entry.launchDecision === "required-for-launch" &&
      entry.channels.includes("transactional-email") &&
      entry.messageTypes.length === 0
    ) {
      throw new Error(`Checkout notification policy '${entry.trigger}' requires transactional email message types.`);
    }
  }

  for (const trigger of [
    "sell-confirmation-recorded",
    "seller-sale-committed",
    "label-or-shipping-next-step",
    "downstream-handoff-failed",
  ] as const satisfies readonly CheckoutNotificationTriggerKey[]) {
    const entry = byTrigger.get(trigger);
    if (!entry?.pendingDownstreamBoundaryRequired) {
      throw new Error(`Checkout notification policy '${trigger}' must protect pending downstream language.`);
    }
  }
}

function notificationPolicy(
  input: CheckoutTransactionalNotificationPolicyEntry,
): CheckoutTransactionalNotificationPolicyEntry {
  return input;
}
