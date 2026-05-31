#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isIsoTimestamp } from "./marketplace-evidence-references.mjs";
import { validateReleaseCommit } from "./marketplace-release-commit.mjs";
import { TAX_NEXUS_JURISDICTION_CODES } from "./marketplace-tax-nexus-measurement.mjs";

export const MARKETPLACE_LAUNCH_EVIDENCE_SCHEMA_VERSION = "marketplace-launch-evidence/v1";

const MAX_EVIDENCE_AGE_DAYS = 30;
const PRODUCTION_STRIPE_WEBHOOK_HOSTS = new Set(["chasesets.com", "admin.chasesets.com", "marketplace.chasesets.com"]);
const PRODUCTION_STRIPE_PAYMENT_WEBHOOK_PATH = "/api/payments/provider/webhooks";
const PRODUCTION_STRIPE_CONNECT_WEBHOOK_PATH = "/api/settlement/provider/money-movement/webhooks";
const PRODUCTION_STRIPE_CONNECT_RETURN_PATH = "/account/payouts";
const PRODUCTION_STRIPE_CONNECT_REFRESH_PATH = "/account/payouts/setup";
const REQUIRED_STRIPE_API_VERSION = "2026-02-25.clover";
const REQUIRED_STRIPE_MONEY_OPERATION_IDENTIFIERS = [
  { key: "livePaymentIntentId", prefix: "pi_" },
  { key: "liveCheckoutSessionId", prefix: "cs_" },
  { key: "refundId", prefix: "re_" },
  { key: "disputeId", prefix: "dp_" },
  { key: "connectAccountId", prefix: "acct_" },
  { key: "payoutReadinessAccountId", prefix: "acct_" },
  { key: "payoutFailurePayoutId", prefix: "po_" },
  { key: "payoutFailureBalanceTransactionId", prefix: "txn_" },
  { key: "platformFundingBalanceTransactionId", prefix: "txn_" },
];
const REQUIRED_STRIPE_MONEY_OPERATION_EVENT_ID_GROUPS = [
  { key: "paymentProviderEventIds", prefix: "evt_", minimumCount: 5 },
  { key: "connectProviderEventIds", prefix: "evt_", minimumCount: 2 },
];
const STRIPE_ID_PLACEHOLDER_PATTERN = /(?:placeholder|example|sample|test|todo|tbd|none|null)/i;
const PRODUCTION_EMAIL_WEBHOOK_HOSTS = new Set(["chasesets.com", "admin.chasesets.com", "marketplace.chasesets.com"]);
const PRODUCTION_EMAIL_WEBHOOK_PATH = "/api/notifications/provider/email/webhooks";
const REQUIRED_SES_CONFIGURATION_SET_NAME = "transactional-production";
const REQUIRED_TRANSACTIONAL_EMAIL_IDENTIFIERS = [
  "controlledSendProviderMessageId",
  "outboxRowId",
  "deliveryProviderEventId",
  "bounceProviderEventId",
  "complaintProviderEventId",
];
const REQUIRED_SUPPORT_OPERATION_IDENTIFIER_SPECS = [
  { key: "buyerSupportRequestId", prefix: "sup_" },
  { key: "sellerSupportRequestId", prefix: "sup_" },
  { key: "refundResolutionSupportRequestId", prefix: "sup_" },
  { key: "refundEffectId", prefix: "sre_" },
  { key: "refundId", prefix: "rfd_" },
  { key: "settlementHoldId", prefix: "hold_" },
];
const PRODUCTION_POSTAGE_WEBHOOK_HOSTS = new Set(["chasesets.com", "admin.chasesets.com", "marketplace.chasesets.com"]);
const PRODUCTION_POSTAGE_WEBHOOK_PATH = "/api/fulfillment/provider/postage/webhooks";
const REQUIRED_FULFILLMENT_POSTAGE_IDENTIFIERS = [
  "controlledParcelShipmentId",
  "parcelProviderShipmentId",
  "parcelProviderLabelId",
  "trackingProviderObjectReference",
  "trackingIdentifier",
  "deliveryExceptionProviderEventId",
  "labelVoidRefundProviderObjectReference",
  "letterMailpieceShipmentId",
];
const REQUIRED_FULFILLMENT_POSTAGE_EVENT_ID_GROUPS = [
  { key: "providerEventIds", minimumCount: 4 },
  { key: "trackingStatusProviderEventIds", minimumCount: 3 },
  { key: "refundStatusProviderEventIds", minimumCount: 1 },
];
const REQUIRED_LAUNCH_SUPPLY_MEASUREMENT_QUERY_VERSION = "launch-supply-measurement-query/v1";
const REQUIRED_TAX_NEXUS_MEASUREMENT_QUERY_VERSION = "tax-nexus-measurement-query/v1";
const REQUIRED_TAX_NEXUS_JURISDICTION_COUNT = TAX_NEXUS_JURISDICTION_CODES.length;
const REQUIRED_PUBLIC_PRESENCE_COPY_AUDIT_VERSION = "marketplace-public-presence-copy-audit/v1";
const REQUIRED_PUBLIC_PRESENCE_COPY_AUDIT_PAGE_COUNT = 8;
const REQUIRED_MARKETPLACE_CHECKOUT_FEE_POLICY_VERSION = "marketplace-checkout-fee-v1";
const PRODUCTION_MARKETPLACE_HOSTS = new Set(["chasesets.com", "marketplace.chasesets.com"]);
const MARKETPLACE_CHECKOUT_FEE_POLICY_PATH = "/api/marketplace/account/marketplace-checkout-fee-policy";

const REQUIRED_APPROVAL_GATES = [
  {
    key: "marketplacePromotion",
    label: "Marketplace promotion",
    approvedEnv: "PRODUCTION_MARKETPLACE_PROMOTION_APPROVED",
    referenceEnv: "PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE",
  },
  {
    key: "marketplaceCheckoutFee",
    label: "Marketplace Checkout Fee",
    approvedEnv: "PRODUCTION_MARKETPLACE_CHECKOUT_FEE_APPROVED",
    referenceEnv: "PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE",
  },
  {
    key: "stripeMoneyOperations",
    label: "Stripe money operations",
    approvedEnv: "PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED",
    referenceEnv: "PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE",
  },
  {
    key: "supportOperations",
    label: "Support operations",
    approvedEnv: "PRODUCTION_SUPPORT_OPERATIONS_APPROVED",
    referenceEnv: "PRODUCTION_SUPPORT_OPERATIONS_REFERENCE",
  },
  {
    key: "fulfillmentPostage",
    label: "Fulfillment postage",
    approvedEnv: "PRODUCTION_FULFILLMENT_POSTAGE_APPROVED",
    referenceEnv: "PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE",
  },
  {
    key: "transactionalEmail",
    label: "Transactional email",
    approvedEnv: "PRODUCTION_TRANSACTIONAL_EMAIL_APPROVED",
    referenceEnv: "PRODUCTION_TRANSACTIONAL_EMAIL_REFERENCE",
  },
  {
    key: "launchSupplyMeasurements",
    label: "Launch supply measurements",
    approvedEnv: "PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_APPROVED",
    referenceEnv: "PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_REFERENCE",
  },
  {
    key: "taxReadiness",
    label: "Tax readiness",
    approvedEnv: "PRODUCTION_TAX_READINESS_APPROVED",
    referenceEnv: "PRODUCTION_TAX_READINESS_REFERENCE",
  },
];

const PLACEHOLDER_REFERENCE_PATTERN =
  /^(?:tbd|todo|none|null|n\/a|na|placeholder|example|sample|test|ticket|record|launch-000)$/i;

const REQUIRED_TRANSACTIONAL_EMAIL_TEMPLATE_AREAS = [
  "auth",
  "orders",
  "payments",
  "fulfillment",
  "refunds",
  "support",
  "payouts",
];

export function validateMarketplaceLaunchEvidence(packet, options = {}) {
  const errors = [];
  const warnings = [];
  const now = options.now ?? new Date();

  if (!isRecord(packet)) {
    return {
      ok: false,
      errors: ["Evidence packet must be a JSON object."],
      warnings,
      summary: { checkedGateCount: 0 },
    };
  }

  if (packet.schemaVersion !== MARKETPLACE_LAUNCH_EVIDENCE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${MARKETPLACE_LAUNCH_EVIDENCE_SCHEMA_VERSION}.`);
  }

  if (packet.environment !== "production") {
    errors.push("environment must be production.");
  }

  const gates = isRecord(packet.gates) ? packet.gates : {};
  if (!isRecord(packet.gates)) {
    errors.push("gates must be an object.");
  }

  for (const gateConfig of REQUIRED_APPROVAL_GATES) {
    validateApprovalGate(gateConfig, gates[gateConfig.key], packet.productionEnvironment, now, errors, warnings);
  }

  validateLaunchSupplyMeasurements(gates.launchSupplyMeasurements, errors);
  validateMarketplacePromotion(gates.marketplacePromotion, now, errors);
  validateMarketplaceCheckoutFee(gates.marketplaceCheckoutFee, now, errors);
  validateStripeMoneyOperations(gates.stripeMoneyOperations, now, errors);
  validateSupportOperations(gates.supportOperations, now, errors);
  validateFulfillmentPostage(gates.fulfillmentPostage, now, errors);
  validateTransactionalEmail(gates.transactionalEmail, now, errors);
  validateTaxReadiness(gates.taxReadiness, packet.productionEnvironment, now, errors);
  validateUcpAp2Marketing(gates.ucpAp2Marketing, errors, warnings);
  validateReleaseCommitFormats(gates, errors);
  validateReleaseCommitConsistency(gates, errors);
  validateProductionEnvironment(packet.productionEnvironment, errors, warnings);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      checkedGateCount: REQUIRED_APPROVAL_GATES.length,
      requiredGates: REQUIRED_APPROVAL_GATES.map((gate) => gate.key),
    },
  };
}

async function main(argv) {
  const filePath = readFileArgument(argv);
  if (!filePath) {
    console.error("Usage: node ./scripts/marketplace-launch-evidence.mjs --file <redacted-evidence.json>");
    return 2;
  }

  let packet;
  try {
    packet = JSON.parse(await readFile(resolve(filePath), "utf8"));
  } catch (error) {
    console.error(`Unable to read launch evidence packet: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const result = validateMarketplaceLaunchEvidence(packet);
  if (result.ok) {
    console.log(`Marketplace launch evidence passed ${result.summary.checkedGateCount} gates.`);
    for (const warning of result.warnings) {
      console.warn(`Warning: ${warning}`);
    }
    return 0;
  }

  console.error("Marketplace launch evidence failed:");
  for (const error of result.errors) {
    console.error(`- ${error}`);
  }
  for (const warning of result.warnings) {
    console.warn(`Warning: ${warning}`);
  }
  return 1;
}

function validateApprovalGate(config, gate, productionEnvironment, now, errors, warnings) {
  if (!isRecord(gate)) {
    errors.push(`${config.label} gate is required at gates.${config.key}.`);
    return;
  }

  if (gate.approved !== true) {
    errors.push(`${config.label} gate must have approved=true.`);
  }

  validateReference(`${config.label} reference`, gate.reference, errors);

  if (!isNonEmptyString(gate.owner)) {
    errors.push(`${config.label} gate must name an accountable owner.`);
  }

  validateCheckedAt(config.label, gate.checkedAt, now, errors, warnings);

  if (isRecord(productionEnvironment)) {
    validateEnvironmentBoolean(config.approvedEnv, productionEnvironment[config.approvedEnv], true, errors);
    validateEnvironmentReference(
      config.referenceEnv,
      productionEnvironment[config.referenceEnv],
      gate.reference,
      errors,
    );
  }
}

function validateLaunchSupplyMeasurements(gate, errors) {
  if (!isRecord(gate)) {
    return;
  }

  const activeCount = Number(gate.activeLaunchListingCount);
  const sellerCount = Number(gate.activeLaunchSellerAccountCount);
  const missingCount = Number(gate.activeLaunchListingsMissingResolvedProductMeasures);
  const coverage = Number(gate.resolvedProductMeasureCoveragePercent);

  if (!Number.isFinite(activeCount) || activeCount <= 0) {
    errors.push("Launch supply measurements must prove at least one active launch listing is eligible for checkout.");
  }

  if (!Number.isFinite(sellerCount) || sellerCount <= 0 || sellerCount > activeCount) {
    errors.push(
      "Launch supply measurements must include activeLaunchSellerAccountCount between 1 and activeLaunchListingCount.",
    );
  }

  validateSampledListingIds("Launch supply measurements", gate.sampledActiveLaunchListingIds, activeCount, errors);

  if (!Number.isFinite(missingCount) || missingCount !== 0) {
    errors.push("Launch supply measurements must have activeLaunchListingsMissingResolvedProductMeasures=0.");
  }

  if (!Number.isFinite(coverage) || coverage !== 100) {
    errors.push("Launch supply measurements must have resolvedProductMeasureCoveragePercent=100.");
  }

  if (gate.environment !== "production") {
    errors.push("Launch supply measurements environment must be production.");
  }

  if (gate.queryVersion !== REQUIRED_LAUNCH_SUPPLY_MEASUREMENT_QUERY_VERSION) {
    errors.push(`Launch supply measurements queryVersion must be ${REQUIRED_LAUNCH_SUPPLY_MEASUREMENT_QUERY_VERSION}.`);
  }

  if (!isNonEmptyString(gate.queryReference)) {
    errors.push("Launch supply measurements must include queryReference for the data-quality sweep.");
  } else {
    validateReference("Launch supply measurements queryReference", gate.queryReference, errors);
    if (gate.queryReference.trim() === REQUIRED_LAUNCH_SUPPLY_MEASUREMENT_QUERY_VERSION) {
      errors.push("Launch supply measurements queryReference must point to the production query evidence record.");
    }
  }

  if (!isNonEmptyString(gate.operator)) {
    errors.push("Launch supply measurements must include the operator who ran the sweep.");
  }

  if (!isNonEmptyString(gate.projectionFreshnessReference)) {
    errors.push("Launch supply measurements must include projectionFreshnessReference.");
  } else {
    validateReference(
      "Launch supply measurements projectionFreshnessReference",
      gate.projectionFreshnessReference,
      errors,
    );
  }
}

function validateMarketplacePromotion(gate, now, errors) {
  if (!isRecord(gate)) {
    return;
  }

  validateRequiredBooleans(
    "Marketplace promotion",
    gate,
    [
      "finalLaunchReviewApproved",
      "publicPresenceLaunchCopyReviewed",
      "futureOnlyLaunchCopyRemoved",
      "policyPagesReviewed",
      "rollbackOwnerAssigned",
      "publicPresenceCopyAuditPassed",
      "publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved",
      "publicPresenceCopyAuditPolicyPagesReviewed",
      "publicPresenceCopyAuditUncertifiedClaimsAbsent",
    ],
    errors,
  );
  validateRequiredStrings(
    "Marketplace promotion",
    gate,
    [
      "reviewReference",
      "reviewCompletedAt",
      "environment",
      "releaseCommit",
      "stagingWorkflowRunReference",
      "productionWorkflowRunReference",
      "publicPresenceReviewReference",
      "publicPresenceCopyAuditReference",
      "publicPresenceCopyAuditVersion",
      "publicPresenceCopyAuditBaseUrl",
      "publicPresenceCopyAuditCompletedAt",
      "policyPagesReviewReference",
      "rollbackOwnerReference",
    ],
    errors,
  );
  validateDetailedReferences(
    "Marketplace promotion",
    gate,
    [
      "reviewReference",
      "stagingWorkflowRunReference",
      "productionWorkflowRunReference",
      "publicPresenceReviewReference",
      "publicPresenceCopyAuditReference",
      "policyPagesReviewReference",
      "rollbackOwnerReference",
    ],
    errors,
  );
  validateCompletedAt("Marketplace promotion", "reviewCompletedAt", gate.reviewCompletedAt, now, errors);
  validateCompletedAt(
    "Marketplace promotion",
    "publicPresenceCopyAuditCompletedAt",
    gate.publicPresenceCopyAuditCompletedAt,
    now,
    errors,
  );

  if (isNonEmptyString(gate.environment) && gate.environment.trim().toLowerCase() !== "production") {
    errors.push("Marketplace promotion environment must be production.");
  }

  if (gate.publicPresenceCopyAuditMode !== "launch") {
    errors.push("Marketplace promotion must include publicPresenceCopyAuditMode=launch.");
  }
  if (gate.publicPresenceCopyAuditVersion !== REQUIRED_PUBLIC_PRESENCE_COPY_AUDIT_VERSION) {
    errors.push(
      `Marketplace promotion must include publicPresenceCopyAuditVersion=${REQUIRED_PUBLIC_PRESENCE_COPY_AUDIT_VERSION}.`,
    );
  }
  validatePublicPresenceCopyAuditBaseUrl(gate.publicPresenceCopyAuditBaseUrl, errors);
  if (gate.publicPresenceCopyAuditRequiredPageCount !== REQUIRED_PUBLIC_PRESENCE_COPY_AUDIT_PAGE_COUNT) {
    errors.push(
      `Marketplace promotion must include publicPresenceCopyAuditRequiredPageCount=${REQUIRED_PUBLIC_PRESENCE_COPY_AUDIT_PAGE_COUNT}.`,
    );
  }
}

function validateMarketplaceCheckoutFee(gate, now, errors) {
  if (!isRecord(gate)) {
    return;
  }

  validateRequiredBooleans(
    "Marketplace Checkout Fee",
    gate,
    [
      "buyerFacingCopyApproved",
      "feeLabelsApproved",
      "refundLanguageApproved",
      "stateDisclosureReviewApproved",
      "stripeLiveFeeConfigurationApproved",
    ],
    errors,
  );
  validateRequiredStrings(
    "Marketplace Checkout Fee",
    gate,
    [
      "approvalReference",
      "environment",
      "releaseCommit",
      "approvalCompletedAt",
      "feePolicyVersion",
      "feePolicyEffectiveAt",
      "stripeMode",
      "livePolicyEndpointUrl",
      "livePolicyEndpointCheckedAt",
      "livePolicyEndpointReference",
      "baseFixedAmount",
      "bankAccountResultingFixedAmount",
      "platformCreditResultingFixedAmount",
      "unsupportedMethodsDefault",
      "feeQuoteStaleResponseError",
      "buyerFacingCopyReference",
      "feeLabelsReference",
      "refundLanguageReference",
      "stateDisclosureReviewReference",
      "stripeLiveFeeConfigurationReference",
    ],
    errors,
  );
  validateDetailedReferences(
    "Marketplace Checkout Fee",
    gate,
    [
      "approvalReference",
      "livePolicyEndpointReference",
      "buyerFacingCopyReference",
      "feeLabelsReference",
      "refundLanguageReference",
      "stateDisclosureReviewReference",
      "stripeLiveFeeConfigurationReference",
    ],
    errors,
  );
  validateCompletedAt("Marketplace Checkout Fee", "approvalCompletedAt", gate.approvalCompletedAt, now, errors);
  validateLivePolicyEndpointObservation(gate, now, errors);
  validateMarketplaceCheckoutFeePolicy(gate, now, errors);

  if (isNonEmptyString(gate.environment) && gate.environment.trim().toLowerCase() !== "production") {
    errors.push("Marketplace Checkout Fee environment must be production.");
  }

  if (isNonEmptyString(gate.stripeMode) && gate.stripeMode.trim().toLowerCase() !== "live") {
    errors.push("Marketplace Checkout Fee stripeMode must be live.");
  }
}

function validateLivePolicyEndpointObservation(gate, now, errors) {
  validateProductionMarketplaceUrl(
    "Marketplace Checkout Fee livePolicyEndpointUrl",
    gate.livePolicyEndpointUrl,
    MARKETPLACE_CHECKOUT_FEE_POLICY_PATH,
    errors,
  );
  if (gate.livePolicyEndpointStatusCode !== 200) {
    errors.push("Marketplace Checkout Fee livePolicyEndpointStatusCode must be 200.");
  }
  validateCompletedAt(
    "Marketplace Checkout Fee",
    "livePolicyEndpointCheckedAt",
    gate.livePolicyEndpointCheckedAt,
    now,
    errors,
  );
}

function validateMarketplaceCheckoutFeePolicy(gate, now, errors) {
  if (gate.feePolicyVersion !== REQUIRED_MARKETPLACE_CHECKOUT_FEE_POLICY_VERSION) {
    errors.push(
      `Marketplace Checkout Fee feePolicyVersion must be ${REQUIRED_MARKETPLACE_CHECKOUT_FEE_POLICY_VERSION}.`,
    );
  }
  if (!Array.isArray(gate.enabledJurisdictions) || gate.enabledJurisdictions.join(",") !== "US") {
    errors.push("Marketplace Checkout Fee enabledJurisdictions must match the live policy endpoint: US.");
  }
  if (gate.basePercentageBps !== 290 || gate.baseFixedAmount !== "0.30") {
    errors.push("Marketplace Checkout Fee base policy must match the live card policy: 290 bps plus 0.30.");
  }
  if (gate.bankAccountResultingPercentageBps !== 50 || gate.bankAccountResultingFixedAmount !== "0.00") {
    errors.push("Marketplace Checkout Fee bank-account policy must match the live policy: 50 bps plus 0.00.");
  }
  if (gate.platformCreditResultingPercentageBps !== 0 || gate.platformCreditResultingFixedAmount !== "0.00") {
    errors.push("Marketplace Checkout Fee platform-credit policy must match the live policy: 0 bps plus 0.00.");
  }
  if (gate.unsupportedMethodsDefault !== "no-positive-fee") {
    errors.push("Marketplace Checkout Fee unsupportedMethodsDefault must match the live policy: no-positive-fee.");
  }
  if (gate.feeQuoteConfirmationRequired !== true) {
    errors.push("Marketplace Checkout Fee feeQuoteConfirmationRequired must be true.");
  }
  if (gate.feeQuoteStaleResponseCode !== 409 || gate.feeQuoteStaleResponseError !== "fee_quote_stale") {
    errors.push("Marketplace Checkout Fee stale quote response must match the live policy: 409 fee_quote_stale.");
  }
  validatePolicyEffectiveAt("Marketplace Checkout Fee", gate.feePolicyEffectiveAt, now, errors);
}

function validateCompletedAt(label, fieldName, value, now, errors) {
  if (!isNonEmptyString(value)) {
    return;
  }

  if (!isIsoTimestamp(value)) {
    errors.push(`${label} ${fieldName} must be an ISO timestamp.`);
    return;
  }

  const completedAt = new Date(value);
  if (completedAt.getTime() > now.getTime() + 60_000) {
    errors.push(`${label} ${fieldName} cannot be in the future.`);
    return;
  }

  const ageDays = (now.getTime() - completedAt.getTime()) / 86_400_000;
  if (ageDays > MAX_EVIDENCE_AGE_DAYS) {
    errors.push(`${label} ${fieldName} cannot be older than ${MAX_EVIDENCE_AGE_DAYS} days.`);
  }
}

function validatePolicyEffectiveAt(label, value, now, errors) {
  if (!isNonEmptyString(value)) {
    return;
  }

  if (!isIsoTimestamp(value)) {
    errors.push(`${label} feePolicyEffectiveAt must be an ISO timestamp.`);
    return;
  }

  const effectiveAt = new Date(value);
  if (effectiveAt.getTime() > now.getTime() + 60_000) {
    errors.push(`${label} feePolicyEffectiveAt cannot be in the future.`);
  }
}

function validateStripeMoneyOperations(gate, now, errors) {
  if (!isRecord(gate)) {
    return;
  }

  validateRequiredBooleans(
    "Stripe money operations",
    gate,
    [
      "liveCheckoutProven",
      "refundProven",
      "disputeProven",
      "connectOnboardingProven",
      "payoutReadinessProven",
      "payoutFailureReversalProven",
      "reconciliationProven",
      "platformBalanceFundingProven",
      "webhookReplayProven",
      "radarRiskPostureApproved",
    ],
    errors,
  );

  validateRequiredStrings(
    "Stripe money operations",
    gate,
    [
      "proofReference",
      "environment",
      "releaseCommit",
      "apiVersion",
      "paymentWebhookDestination",
      "connectWebhookDestination",
      "connectReturnUrl",
      "connectRefreshUrl",
      "proofCompletedAt",
      ...REQUIRED_STRIPE_MONEY_OPERATION_IDENTIFIERS.map(({ key }) => key),
      "paymentProviderEventQueryReference",
      "connectProviderEventQueryReference",
      "liveCheckoutReference",
      "refundReference",
      "disputeReference",
      "connectOnboardingReference",
      "payoutReadinessReference",
      "payoutFailureReversalReference",
      "reconciliationReference",
      "platformBalanceFundingReference",
      "webhookReplayReference",
      "paymentProviderEventQueryReference",
      "connectProviderEventQueryReference",
      "radarRiskPostureReference",
    ],
    errors,
  );
  validateDetailedReferences(
    "Stripe money operations",
    gate,
    [
      "proofReference",
      "liveCheckoutReference",
      "refundReference",
      "disputeReference",
      "connectOnboardingReference",
      "payoutReadinessReference",
      "payoutFailureReversalReference",
      "reconciliationReference",
      "platformBalanceFundingReference",
      "webhookReplayReference",
      "radarRiskPostureReference",
    ],
    errors,
  );
  validateStripeIdentifierFields("Stripe money operations", gate, REQUIRED_STRIPE_MONEY_OPERATION_IDENTIFIERS, errors);
  validateStripeEventIdFields("Stripe money operations", gate, REQUIRED_STRIPE_MONEY_OPERATION_EVENT_ID_GROUPS, errors);
  validateProofCompletedAt("Stripe money operations", gate.proofCompletedAt, now, errors);

  if (isNonEmptyString(gate.environment) && gate.environment.trim().toLowerCase() !== "live") {
    errors.push("Stripe money operations environment must be live.");
  }

  if (isNonEmptyString(gate.apiVersion) && gate.apiVersion.trim() !== REQUIRED_STRIPE_API_VERSION) {
    errors.push(`Stripe money operations apiVersion must be ${REQUIRED_STRIPE_API_VERSION}.`);
  }

  if (!Number.isInteger(gate.connectConnectedAccountCount) || gate.connectConnectedAccountCount <= 0) {
    errors.push("Stripe money operations must include at least one live connected account.");
  }
  if (!Number.isInteger(gate.paymentProviderEventRowCount) || gate.paymentProviderEventRowCount < 5) {
    errors.push("Stripe money operations must include paymentProviderEventRowCount of at least 5.");
  }
  if (!Number.isInteger(gate.connectProviderEventRowCount) || gate.connectProviderEventRowCount < 2) {
    errors.push("Stripe money operations must include connectProviderEventRowCount of at least 2.");
  }

  validateProductionStripeUrl(
    "Stripe money operations paymentWebhookDestination",
    gate.paymentWebhookDestination,
    PRODUCTION_STRIPE_PAYMENT_WEBHOOK_PATH,
    errors,
  );
  validateProductionStripeUrl(
    "Stripe money operations connectWebhookDestination",
    gate.connectWebhookDestination,
    PRODUCTION_STRIPE_CONNECT_WEBHOOK_PATH,
    errors,
  );
  validateProductionStripeUrl(
    "Stripe money operations connectReturnUrl",
    gate.connectReturnUrl,
    PRODUCTION_STRIPE_CONNECT_RETURN_PATH,
    errors,
  );
  validateProductionStripeUrl(
    "Stripe money operations connectRefreshUrl",
    gate.connectRefreshUrl,
    PRODUCTION_STRIPE_CONNECT_REFRESH_PATH,
    errors,
  );
}

function validateStripeIdentifierFields(label, gate, specs, errors) {
  for (const { key, prefix } of specs) {
    if (isNonEmptyString(gate[key]) && !isConcreteStripeId(gate[key], prefix)) {
      errors.push(`${label} ${key} must be a concrete Stripe identifier starting with ${prefix}.`);
    }
  }
}

function validateStripeEventIdFields(label, gate, specs, errors) {
  for (const { key, prefix, minimumCount } of specs) {
    const values = gate[key];
    if (!Array.isArray(values)) {
      errors.push(`${label} must include ${key}.`);
      continue;
    }
    if (values.length < minimumCount) {
      errors.push(`${label} ${key} must include at least ${minimumCount} concrete Stripe event IDs.`);
    }
    if (new Set(values).size !== values.length) {
      errors.push(`${label} ${key} must not contain duplicate Stripe event IDs.`);
    }
    if (values.some((value) => !isConcreteStripeId(value, prefix))) {
      errors.push(`${label} ${key} entries must be concrete Stripe identifiers starting with ${prefix}.`);
    }
  }
}

function isConcreteStripeId(value, prefix) {
  if (!isNonEmptyString(value)) {
    return false;
  }
  const normalized = value.trim();
  return (
    normalized.startsWith(prefix) &&
    normalized.length >= prefix.length + 6 &&
    /^[A-Za-z0-9_]+$/.test(normalized.slice(prefix.length)) &&
    !STRIPE_ID_PLACEHOLDER_PATTERN.test(normalized)
  );
}

function validateSupportOperations(gate, now, errors) {
  if (!isRecord(gate)) {
    return;
  }

  validateRequiredBooleans(
    "Support operations",
    gate,
    [
      "buyerIssueOpeningProven",
      "sellerIssueOpeningProven",
      "operationsQueueReviewProven",
      "overdueEscalationProven",
      "lifecycleEndpointsProven",
      "refundProducingResolutionProven",
      "settlementHoldCoordinationProven",
      "supportNotificationsProven",
    ],
    errors,
  );
  validateRequiredStrings(
    "Support operations",
    gate,
    [
      "buyerSupportRequestId",
      "sellerSupportRequestId",
      "operationsQueueReviewReference",
      "overdueEscalationResultReference",
      "lifecycleEndpointResultReference",
      "refundResolutionSupportRequestId",
      "refundEffectId",
      "refundId",
      "refundEffectReference",
      "settlementHoldId",
      "settlementHoldReleaseReference",
      "settlementHoldReference",
      "supportNotificationReference",
      "rehearsalReference",
      "rehearsalCompletedAt",
      "environment",
      "releaseCommit",
    ],
    errors,
  );
  validateDetailedReferences(
    "Support operations",
    gate,
    [
      "operationsQueueReviewReference",
      "overdueEscalationResultReference",
      "lifecycleEndpointResultReference",
      "refundEffectReference",
      "settlementHoldReleaseReference",
      "settlementHoldReference",
      "supportNotificationReference",
      "rehearsalReference",
    ],
    errors,
  );
  validateSupportOperationIdentifiers(gate, errors);
  validateSupportRehearsalCompletedAt(gate.rehearsalCompletedAt, now, errors);
  if (isNonEmptyString(gate.environment) && gate.environment.trim().toLowerCase() !== "staging") {
    errors.push("Support operations environment must be staging.");
  }
  if (
    isNonEmptyString(gate.buyerSupportRequestId) &&
    isNonEmptyString(gate.sellerSupportRequestId) &&
    gate.buyerSupportRequestId === gate.sellerSupportRequestId
  ) {
    errors.push("Support operations must include separate buyer and seller support request ids.");
  }
  if (
    isNonEmptyString(gate.refundResolutionSupportRequestId) &&
    isNonEmptyString(gate.buyerSupportRequestId) &&
    gate.refundResolutionSupportRequestId !== gate.buyerSupportRequestId
  ) {
    errors.push("Support operations refund resolution must be tied to the buyer support request id.");
  }
  if (
    isNonEmptyString(gate.settlementHoldReleaseReference) &&
    isNonEmptyString(gate.settlementHoldReference) &&
    gate.settlementHoldReleaseReference === gate.settlementHoldReference
  ) {
    errors.push("Support operations must include separate hold and hold-release evidence references.");
  }
}

function validateSupportOperationIdentifiers(gate, errors) {
  validateConcreteIdentifiers(
    "Support operations",
    gate,
    REQUIRED_SUPPORT_OPERATION_IDENTIFIER_SPECS.map(({ key }) => key),
    errors,
  );
  for (const { key, prefix } of REQUIRED_SUPPORT_OPERATION_IDENTIFIER_SPECS) {
    if (isNonEmptyString(gate[key]) && !gate[key].startsWith(prefix)) {
      errors.push(`Support operations ${key} must start with ${prefix}.`);
    }
  }
}

function validateSupportRehearsalCompletedAt(value, now, errors) {
  if (!isNonEmptyString(value)) {
    return;
  }

  if (!isIsoTimestamp(value)) {
    errors.push("Support operations rehearsalCompletedAt must be an ISO timestamp.");
    return;
  }

  const rehearsalCompletedAt = new Date(value);
  if (rehearsalCompletedAt.getTime() > now.getTime() + 60_000) {
    errors.push("Support operations rehearsalCompletedAt cannot be in the future.");
    return;
  }

  const ageDays = (now.getTime() - rehearsalCompletedAt.getTime()) / 86_400_000;
  if (ageDays > MAX_EVIDENCE_AGE_DAYS) {
    errors.push(`Support operations rehearsalCompletedAt cannot be older than ${MAX_EVIDENCE_AGE_DAYS} days.`);
  }
}

function validateFulfillmentPostage(gate, now, errors) {
  if (!isRecord(gate)) {
    return;
  }

  validateRequiredBooleans(
    "Fulfillment postage",
    gate,
    [
      "easyPostProductionModeProven",
      "webhookDestinationConfigured",
      "providerEventRowsProven",
      "parcelLabelPurchaseProven",
      "labelVoidRefundProven",
      "trackingEventProven",
      "deliveryExceptionProven",
      "letterMailpieceHandlingProven",
    ],
    errors,
  );
  validateRequiredStrings(
    "Fulfillment postage",
    gate,
    [
      "easyPostAccountReference",
      "webhookDestinationReference",
      "providerEventQueryReference",
      "parcelLabelReference",
      "labelVoidRefundReference",
      "trackingEventReference",
      "deliveryExceptionReference",
      "letterMailpieceReference",
      "proofReference",
      "proofCompletedAt",
      "environment",
      "releaseCommit",
      "easyPostMode",
      "webhookDestination",
      ...REQUIRED_FULFILLMENT_POSTAGE_IDENTIFIERS,
    ],
    errors,
  );
  validateDetailedReferences(
    "Fulfillment postage",
    gate,
    [
      "easyPostAccountReference",
      "webhookDestinationReference",
      "providerEventQueryReference",
      "parcelLabelReference",
      "labelVoidRefundReference",
      "trackingEventReference",
      "deliveryExceptionReference",
      "letterMailpieceReference",
      "proofReference",
    ],
    errors,
  );
  validateProofCompletedAt("Fulfillment postage", gate.proofCompletedAt, now, errors);

  if (isNonEmptyString(gate.environment) && gate.environment.trim().toLowerCase() !== "production") {
    errors.push("Fulfillment postage environment must be production.");
  }

  if (isNonEmptyString(gate.easyPostMode) && gate.easyPostMode.trim().toLowerCase() !== "production") {
    errors.push("Fulfillment postage easyPostMode must be production.");
  }

  validateProductionPostageWebhookUrl("Fulfillment postage webhookDestination", gate.webhookDestination, errors);

  if (!Number.isInteger(gate.providerEventRowCount) || gate.providerEventRowCount < 4) {
    errors.push("Fulfillment postage must include providerEventRowCount of at least 4.");
  }
  if (!Number.isInteger(gate.matchedShipmentProviderEventRowCount) || gate.matchedShipmentProviderEventRowCount < 4) {
    errors.push("Fulfillment postage must include matchedShipmentProviderEventRowCount of at least 4.");
  }
  if (!Number.isInteger(gate.trackingStatusProviderEventRowCount) || gate.trackingStatusProviderEventRowCount < 3) {
    errors.push("Fulfillment postage must include trackingStatusProviderEventRowCount of at least 3.");
  }
  if (!Number.isInteger(gate.refundStatusProviderEventRowCount) || gate.refundStatusProviderEventRowCount < 1) {
    errors.push("Fulfillment postage must include refundStatusProviderEventRowCount of at least 1.");
  }
  validateFulfillmentPostageIdentifiers(gate, errors);
  validateFulfillmentPostageEventIdGroups(gate, errors);
}

function validateFulfillmentPostageIdentifiers(gate, errors) {
  validateConcretePostageIdentifier(
    "Fulfillment postage controlledParcelShipmentId",
    gate.controlledParcelShipmentId,
    errors,
  );
  validateEasyPostId("Fulfillment postage parcelProviderShipmentId", gate.parcelProviderShipmentId, "shp_", errors);
  validateEasyPostId("Fulfillment postage parcelProviderLabelId", gate.parcelProviderLabelId, "pl_", errors);
  validateEasyPostId(
    "Fulfillment postage trackingProviderObjectReference",
    gate.trackingProviderObjectReference,
    "trk_",
    errors,
  );
  validateConcretePostageIdentifier("Fulfillment postage trackingIdentifier", gate.trackingIdentifier, errors);
  validateEasyPostId(
    "Fulfillment postage deliveryExceptionProviderEventId",
    gate.deliveryExceptionProviderEventId,
    "evt_",
    errors,
  );
  validateConcretePostageIdentifier(
    "Fulfillment postage labelVoidRefundProviderObjectReference",
    gate.labelVoidRefundProviderObjectReference,
    errors,
  );
  validateConcretePostageIdentifier(
    "Fulfillment postage letterMailpieceShipmentId",
    gate.letterMailpieceShipmentId,
    errors,
  );
}

function validateFulfillmentPostageEventIdGroups(gate, errors) {
  for (const { key, minimumCount } of REQUIRED_FULFILLMENT_POSTAGE_EVENT_ID_GROUPS) {
    const values = gate[key];
    if (!Array.isArray(values)) {
      errors.push(`Fulfillment postage must include ${key}.`);
      continue;
    }
    if (values.length < minimumCount) {
      errors.push(`Fulfillment postage ${key} must include at least ${minimumCount} concrete EasyPost event IDs.`);
    }
    if (new Set(values).size !== values.length) {
      errors.push(`Fulfillment postage ${key} must not contain duplicate EasyPost event IDs.`);
    }
    if (values.some((value) => !isConcreteEasyPostId(value, "evt_"))) {
      errors.push(`Fulfillment postage ${key} entries must be concrete EasyPost event IDs starting with evt_.`);
    }
  }
}

function validateEasyPostId(label, value, prefix, errors) {
  if (isNonEmptyString(value) && !isConcreteEasyPostId(value, prefix)) {
    errors.push(`${label} must be a concrete EasyPost identifier starting with ${prefix}.`);
  }
}

function isConcreteEasyPostId(value, prefix) {
  if (!isNonEmptyString(value)) {
    return false;
  }
  const normalized = value.trim();
  return (
    normalized.startsWith(prefix) &&
    normalized.length >= prefix.length + 6 &&
    /^[A-Za-z0-9_]+$/.test(normalized.slice(prefix.length)) &&
    !isPlaceholderIdentifier(normalized)
  );
}

function validateConcretePostageIdentifier(label, value, errors) {
  if (!isNonEmptyString(value)) {
    return;
  }
  if (value.trim().length < 6 || isPlaceholderIdentifier(value)) {
    errors.push(`${label} must be a concrete identifier, not a placeholder.`);
  }
}

function isPlaceholderIdentifier(value) {
  return /(?:placeholder|example|sample|test|todo|tbd|none|null|record|ticket)/i.test(value.trim());
}

function validateProductionPostageWebhookUrl(label, value, errors) {
  if (!isNonEmptyString(value)) {
    return;
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !PRODUCTION_POSTAGE_WEBHOOK_HOSTS.has(url.hostname) ||
      url.pathname !== PRODUCTION_POSTAGE_WEBHOOK_PATH
    ) {
      errors.push(`${label} must use ${PRODUCTION_POSTAGE_WEBHOOK_PATH} on a production Chase Sets host.`);
    }
  } catch {
    errors.push(`${label} must be an absolute HTTPS URL.`);
  }
}

function validateTransactionalEmail(gate, now, errors) {
  if (!isRecord(gate)) {
    return;
  }

  validateRequiredBooleans(
    "Transactional email",
    gate,
    [
      "sesDnsVerified",
      "controlledSendProven",
      "outboxDispatchProven",
      "bounceComplaintParsingProven",
      "deliveryMonitoringProven",
      "webhookDestinationConfigured",
      "snsSubscriptionConfirmed",
    ],
    errors,
  );
  validateRequiredStrings(
    "Transactional email",
    gate,
    [
      "sesIdentityReference",
      "controlledSendMessageReference",
      "outboxDispatchReference",
      "deliveryEventReference",
      "bounceEventReference",
      "complaintEventReference",
      "deliveryMonitoringReference",
      "snsSubscriptionConfirmationReference",
      "templateReviewReference",
      "proofReference",
      "proofCompletedAt",
      "environment",
      "releaseCommit",
      "sesConfigurationSetName",
      "webhookDestination",
      ...REQUIRED_TRANSACTIONAL_EMAIL_IDENTIFIERS,
    ],
    errors,
  );
  validateDetailedReferences(
    "Transactional email",
    gate,
    [
      "sesIdentityReference",
      "controlledSendMessageReference",
      "outboxDispatchReference",
      "deliveryEventReference",
      "bounceEventReference",
      "complaintEventReference",
      "deliveryMonitoringReference",
      "snsSubscriptionConfirmationReference",
      "templateReviewReference",
      "proofReference",
    ],
    errors,
  );
  validateProofCompletedAt("Transactional email", gate.proofCompletedAt, now, errors);

  if (isNonEmptyString(gate.environment) && gate.environment.trim().toLowerCase() !== "production") {
    errors.push("Transactional email environment must be production.");
  }

  if (
    isNonEmptyString(gate.sesConfigurationSetName) &&
    gate.sesConfigurationSetName.trim() !== REQUIRED_SES_CONFIGURATION_SET_NAME
  ) {
    errors.push(`Transactional email sesConfigurationSetName must be ${REQUIRED_SES_CONFIGURATION_SET_NAME}.`);
  }

  validateProductionEmailWebhookUrl("Transactional email webhookDestination", gate.webhookDestination, errors);

  if (!Number.isInteger(gate.providerEventRowCount) || gate.providerEventRowCount < 3) {
    errors.push("Transactional email must include providerEventRowCount of at least 3.");
  }
  validateTransactionalEmailIdentifiers(gate, errors);

  const templateAreas = Array.isArray(gate.criticalTemplateAreasCovered)
    ? gate.criticalTemplateAreasCovered
        .filter((entry) => typeof entry === "string")
        .map((entry) => entry.trim().toLowerCase())
    : [];
  for (const requiredArea of REQUIRED_TRANSACTIONAL_EMAIL_TEMPLATE_AREAS) {
    if (!templateAreas.includes(requiredArea)) {
      errors.push(`Transactional email criticalTemplateAreasCovered must include ${requiredArea}.`);
    }
  }
}

function validateTransactionalEmailIdentifiers(gate, errors) {
  validateConcreteEmailIdentifier(
    "Transactional email controlledSendProviderMessageId",
    gate.controlledSendProviderMessageId,
    errors,
  );
  if (isNonEmptyString(gate.outboxRowId) && !/^[1-9]\d*$/.test(gate.outboxRowId)) {
    errors.push("Transactional email outboxRowId must be a positive transactional_email_outbox row id.");
  }

  validateEmailProviderEventId(
    "Transactional email deliveryProviderEventId",
    gate.deliveryProviderEventId,
    "delivery",
    errors,
  );
  validateEmailProviderEventId(
    "Transactional email bounceProviderEventId",
    gate.bounceProviderEventId,
    "bounce",
    errors,
  );
  validateEmailProviderEventId(
    "Transactional email complaintProviderEventId",
    gate.complaintProviderEventId,
    "complaint",
    errors,
  );

  const providerEventIds = [gate.deliveryProviderEventId, gate.bounceProviderEventId, gate.complaintProviderEventId];
  if (providerEventIds.every(isNonEmptyString) && new Set(providerEventIds).size !== providerEventIds.length) {
    errors.push("Transactional email provider event ids must be distinct.");
  }
}

function validateEmailProviderEventId(label, value, expectedKind, errors) {
  if (!isNonEmptyString(value)) {
    return;
  }
  const match = /^amazon-ses:([^:]+):(delivery|bounce|complaint):(.+)$/.exec(value);
  if (!match) {
    errors.push(`${label} must use the amazon-ses:<message-id>:${expectedKind}:<occurred-at> format.`);
    return;
  }
  const [, providerMessageId, eventKind, occurredAt] = match;
  validateConcreteEmailIdentifier(`${label} provider message id`, providerMessageId, errors);
  if (eventKind !== expectedKind) {
    errors.push(`${label} must be a ${expectedKind} provider event.`);
  }
  if (!isIsoTimestamp(occurredAt)) {
    errors.push(`${label} occurred-at value must be an ISO timestamp.`);
  }
}

function validateConcreteEmailIdentifier(label, value, errors) {
  if (!isNonEmptyString(value)) {
    return;
  }
  const normalized = value.trim();
  if (/^(?:tbd|todo|none|null|n\/a|na|placeholder|example|sample|test|ticket|record)$/i.test(normalized)) {
    errors.push(`${label} must be a concrete identifier, not a placeholder.`);
  }
}

function validateProofCompletedAt(label, value, now, errors) {
  if (!isNonEmptyString(value)) {
    return;
  }

  if (!isIsoTimestamp(value)) {
    errors.push(`${label} proofCompletedAt must be an ISO timestamp.`);
    return;
  }

  const proofCompletedAt = new Date(value);
  if (proofCompletedAt.getTime() > now.getTime() + 60_000) {
    errors.push(`${label} proofCompletedAt cannot be in the future.`);
    return;
  }

  const ageDays = (now.getTime() - proofCompletedAt.getTime()) / 86_400_000;
  if (ageDays > MAX_EVIDENCE_AGE_DAYS) {
    errors.push(`${label} proofCompletedAt cannot be older than ${MAX_EVIDENCE_AGE_DAYS} days.`);
  }
}

function validateProductionEmailWebhookUrl(label, value, errors) {
  if (!isNonEmptyString(value)) {
    return;
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !PRODUCTION_EMAIL_WEBHOOK_HOSTS.has(url.hostname) ||
      url.pathname !== PRODUCTION_EMAIL_WEBHOOK_PATH
    ) {
      errors.push(`${label} must use ${PRODUCTION_EMAIL_WEBHOOK_PATH} on a production Chase Sets host.`);
    }
  } catch {
    errors.push(`${label} must be an absolute HTTPS URL.`);
  }
}

function validateTaxReadiness(gate, productionEnvironment, now, errors) {
  if (!isRecord(gate)) {
    return;
  }

  const posture = gate.posture;
  if (!Array.isArray(gate.collectionRequiredJurisdictions)) {
    errors.push("Tax readiness collectionRequiredJurisdictions must be an array.");
    return;
  }
  const collectionRequiredJurisdictions = gate.collectionRequiredJurisdictions;

  if (!["no_collection_required", "provider_backed_quotes_required"].includes(posture)) {
    errors.push("Tax readiness posture must be no_collection_required or provider_backed_quotes_required.");
    return;
  }

  validateRequiredStrings(
    "Tax readiness",
    gate,
    [
      "counselAccountingApprovalReference",
      "stateByStateNexusReference",
      "providerDecisionReference",
      "thresholdPolicyReference",
      "nexusMonitoringReference",
      "nexusReportAsOf",
      "sourceMeasurementReference",
      "sourceMeasurementEnvironment",
      "sourceMeasurementQueryVersion",
      "sourceMeasurementCheckedAt",
      "sourceMeasurementProjectionFreshnessReference",
    ],
    errors,
  );
  validateDetailedReferences(
    "Tax readiness",
    gate,
    [
      "counselAccountingApprovalReference",
      "stateByStateNexusReference",
      "providerDecisionReference",
      "thresholdPolicyReference",
      "nexusMonitoringReference",
      "sourceMeasurementReference",
      "sourceMeasurementProjectionFreshnessReference",
    ],
    errors,
  );
  if (gate.sourceMeasurementReference === REQUIRED_TAX_NEXUS_MEASUREMENT_QUERY_VERSION) {
    errors.push("Tax readiness sourceMeasurementReference must point to the production source measurement record.");
  }
  validateTaxNexusReportAsOf(gate.nexusReportAsOf, now, errors);
  validateTaxSourceMeasurementDetails(gate, errors);
  validateRequiredTaxJurisdictionArrays(gate, errors);

  if (gate.sourceMeasurementEnvironment !== "production") {
    errors.push("Tax readiness sourceMeasurementEnvironment must be production.");
  }

  if (gate.sourceMeasurementQueryVersion !== REQUIRED_TAX_NEXUS_MEASUREMENT_QUERY_VERSION) {
    errors.push(`Tax readiness sourceMeasurementQueryVersion must be ${REQUIRED_TAX_NEXUS_MEASUREMENT_QUERY_VERSION}.`);
  }

  if (typeof gate.providerBackedQuotesMissing !== "boolean") {
    errors.push("Tax readiness must include providerBackedQuotesMissing as a boolean.");
  }

  if (posture === "no_collection_required") {
    if (collectionRequiredJurisdictions.length > 0) {
      errors.push(
        "Tax readiness cannot use no_collection_required while collectionRequiredJurisdictions is non-empty.",
      );
    }
    if (gate.taxProviderBackedQuotesRequired !== false) {
      errors.push("Tax readiness no_collection_required posture requires taxProviderBackedQuotesRequired=false.");
    }
    if (isRecord(productionEnvironment)) {
      validateEnvironmentBoolean(
        "TAX_PROVIDER_BACKED_QUOTES_REQUIRED",
        productionEnvironment.TAX_PROVIDER_BACKED_QUOTES_REQUIRED,
        false,
        errors,
      );
    }
  }

  if (posture === "provider_backed_quotes_required") {
    if (collectionRequiredJurisdictions.length === 0) {
      errors.push("Tax provider_backed_quotes_required posture must list collectionRequiredJurisdictions.");
    }
    if (gate.taxProviderBackedQuotesRequired !== true) {
      errors.push("Tax provider_backed_quotes_required posture requires taxProviderBackedQuotesRequired=true.");
    }
    if (gate.providerBackedResolverComposed !== true) {
      errors.push("Tax provider_backed_quotes_required posture requires providerBackedResolverComposed=true.");
    }
    if (!isNonEmptyString(gate.providerBackedResolverReference)) {
      errors.push("Tax provider_backed_quotes_required posture requires providerBackedResolverReference.");
    } else {
      validateReference("Tax readiness providerBackedResolverReference", gate.providerBackedResolverReference, errors);
    }
    if (gate.providerBackedQuotesMissing !== false) {
      errors.push("Tax provider_backed_quotes_required posture requires providerBackedQuotesMissing=false.");
    }
    if (isRecord(productionEnvironment)) {
      validateEnvironmentBoolean(
        "TAX_PROVIDER_BACKED_QUOTES_REQUIRED",
        productionEnvironment.TAX_PROVIDER_BACKED_QUOTES_REQUIRED,
        true,
        errors,
      );
    }
  }
}

function validateTaxSourceMeasurementDetails(gate, errors) {
  if (!isIsoTimestamp(gate.sourceMeasurementCheckedAt)) {
    errors.push("Tax readiness sourceMeasurementCheckedAt must be an ISO timestamp.");
  } else if (isIsoTimestamp(gate.nexusReportAsOf)) {
    const checkedAt = new Date(gate.sourceMeasurementCheckedAt);
    const reportAsOf = new Date(gate.nexusReportAsOf);
    if (checkedAt.getTime() > reportAsOf.getTime() + 60_000) {
      errors.push("Tax readiness sourceMeasurementCheckedAt cannot be after nexusReportAsOf.");
    }
  }

  if (!isRecord(gate.sourceMeasurementQueryWindow)) {
    errors.push("Tax readiness sourceMeasurementQueryWindow must be an object.");
  } else {
    for (const field of ["previousYearStart", "currentYearStart", "nextYearStart"]) {
      if (!isIsoTimestamp(gate.sourceMeasurementQueryWindow[field])) {
        errors.push(`Tax readiness sourceMeasurementQueryWindow.${field} must be an ISO timestamp.`);
      }
    }
    const { previousYearStart, currentYearStart, nextYearStart } = gate.sourceMeasurementQueryWindow;
    if (isIsoTimestamp(previousYearStart) && isIsoTimestamp(currentYearStart)) {
      if (new Date(previousYearStart) >= new Date(currentYearStart)) {
        errors.push("Tax readiness sourceMeasurementQueryWindow.previousYearStart must be before currentYearStart.");
      }
    }
    if (isIsoTimestamp(currentYearStart) && isIsoTimestamp(nextYearStart)) {
      if (new Date(currentYearStart) >= new Date(nextYearStart)) {
        errors.push("Tax readiness sourceMeasurementQueryWindow.currentYearStart must be before nextYearStart.");
      }
    }
  }

  if (gate.sourceMeasurementJurisdictionCount !== REQUIRED_TAX_NEXUS_JURISDICTION_COUNT) {
    errors.push(`Tax readiness sourceMeasurementJurisdictionCount must be ${REQUIRED_TAX_NEXUS_JURISDICTION_COUNT}.`);
  }
  if (gate.sourceMeasurementMissingJurisdictionOrderCount !== 0) {
    errors.push("Tax readiness sourceMeasurementMissingJurisdictionOrderCount must be 0.");
  }
  if (gate.sourceMeasurementUnknownJurisdictionOrderCount !== 0) {
    errors.push("Tax readiness sourceMeasurementUnknownJurisdictionOrderCount must be 0.");
  }
  if (gate.sourceMeasurementRequiresManualReview !== false) {
    errors.push("Tax readiness sourceMeasurementRequiresManualReview must be false.");
  }
  if (gate.sourceMeasurementPasses !== true) {
    errors.push("Tax readiness sourceMeasurementPasses must be true.");
  }
  if (gate.stateByStateJurisdictionReviewCount < REQUIRED_TAX_NEXUS_JURISDICTION_COUNT) {
    errors.push(
      `Tax readiness stateByStateJurisdictionReviewCount must be at least ${REQUIRED_TAX_NEXUS_JURISDICTION_COUNT}.`,
    );
  }
}

function validateRequiredTaxJurisdictionArrays(gate, errors) {
  for (const field of ["registrationRequiredJurisdictions", "preparationJurisdictions", "manualReviewJurisdictions"]) {
    if (!Array.isArray(gate[field])) {
      errors.push(`Tax readiness ${field} must be an array.`);
      continue;
    }
    if (gate[field].some((entry) => !isNonEmptyString(entry))) {
      errors.push(`Tax readiness ${field} must contain only non-empty strings.`);
    }
  }
}

function validateTaxNexusReportAsOf(value, now, errors) {
  if (!isNonEmptyString(value)) {
    return;
  }

  if (!isIsoTimestamp(value)) {
    errors.push("Tax readiness nexusReportAsOf must be an ISO timestamp.");
    return;
  }

  const asOf = new Date(value);
  if (asOf.getTime() > now.getTime() + 60_000) {
    errors.push("Tax readiness nexusReportAsOf cannot be in the future.");
    return;
  }

  const ageDays = (now.getTime() - asOf.getTime()) / 86_400_000;
  if (ageDays > MAX_EVIDENCE_AGE_DAYS) {
    errors.push(`Tax readiness nexusReportAsOf cannot be older than ${MAX_EVIDENCE_AGE_DAYS} days.`);
  }
}

function validateUcpAp2Marketing(gate, errors, warnings) {
  if (!isRecord(gate)) {
    errors.push("UCP/AP2 marketing gate is required so public launch claims remain explicit.");
    return;
  }

  validateRequiredStrings("UCP/AP2 marketing", gate, ["owner", "claimsReviewReference"], errors);
  validateDetailedReferences("UCP/AP2 marketing", gate, ["claimsReviewReference"], errors);
  if (typeof gate.publicLaunchClaimsEnabled !== "boolean") {
    errors.push("UCP/AP2 marketing must include publicLaunchClaimsEnabled as a boolean.");
  }
  if (typeof gate.certificationApproved !== "boolean") {
    errors.push("UCP/AP2 marketing must include certificationApproved as a boolean.");
  }

  if (gate.publicLaunchClaimsEnabled === true) {
    if (gate.certificationApproved !== true) {
      errors.push("UCP/AP2 public launch claims require certificationApproved=true.");
    }
    validateReference("UCP/AP2 certification reference", gate.certificationReference, errors);
    return;
  }

  if (gate.certificationApproved === true && !isNonEmptyString(gate.certificationReference)) {
    errors.push("UCP/AP2 certification approval requires a certificationReference.");
  }
  if (gate.certificationApproved === true && isNonEmptyString(gate.certificationReference)) {
    validateReference("UCP/AP2 certification reference", gate.certificationReference, errors);
  }
  if (gate.certificationApproved !== true && isNonEmptyString(gate.certificationReference)) {
    validateReference("UCP/AP2 certification reference", gate.certificationReference, errors);
  }

  if (gate.publicLaunchClaimsEnabled === false && gate.uncertifiedClaimsAbsent !== true) {
    errors.push("UCP/AP2 launch restraint requires uncertifiedClaimsAbsent=true when public claims are disabled.");
  }
}

function validateReleaseCommitConsistency(gates, errors) {
  const expectedReleaseCommit = gates.marketplacePromotion?.releaseCommit;
  if (!isNonEmptyString(expectedReleaseCommit)) {
    return;
  }

  for (const [key, label] of [
    ["marketplaceCheckoutFee", "Marketplace Checkout Fee"],
    ["stripeMoneyOperations", "Stripe money operations"],
    ["supportOperations", "Support operations"],
    ["fulfillmentPostage", "Fulfillment postage"],
    ["transactionalEmail", "Transactional email"],
  ]) {
    const gate = gates[key];
    if (!isRecord(gate) || !isNonEmptyString(gate.releaseCommit)) {
      continue;
    }
    if (gate.releaseCommit.trim() !== expectedReleaseCommit.trim()) {
      errors.push(`${label} releaseCommit must match Marketplace promotion releaseCommit.`);
    }
  }
}

function validateReleaseCommitFormats(gates, errors) {
  for (const [key, label] of [
    ["marketplacePromotion", "Marketplace promotion"],
    ["marketplaceCheckoutFee", "Marketplace Checkout Fee"],
    ["stripeMoneyOperations", "Stripe money operations"],
    ["supportOperations", "Support operations"],
    ["fulfillmentPostage", "Fulfillment postage"],
    ["transactionalEmail", "Transactional email"],
  ]) {
    const gate = gates[key];
    if (!isRecord(gate) || !isNonEmptyString(gate.releaseCommit)) {
      continue;
    }
    validateReleaseCommit(label, gate.releaseCommit, errors);
  }
}

function validateProductionEnvironment(productionEnvironment, errors, warnings) {
  if (!isRecord(productionEnvironment)) {
    errors.push("productionEnvironment is required so packet gates can be compared to GitHub Environment values.");
    return;
  }

  const publicEnabled = productionEnvironment.PRODUCTION_MARKETPLACE_PUBLIC_ENABLED;
  if (!["true", "false", true, false].includes(publicEnabled)) {
    errors.push("PRODUCTION_MARKETPLACE_PUBLIC_ENABLED must be present as true or false in productionEnvironment.");
  }

  validateReference(
    "PRODUCTION_MARKETPLACE_LAUNCH_EVIDENCE_REFERENCE",
    productionEnvironment.PRODUCTION_MARKETPLACE_LAUNCH_EVIDENCE_REFERENCE,
    errors,
  );

  const proofEnabled = productionEnvironment.PRODUCTION_MARKETPLACE_PROOF_ENABLED;
  if (proofEnabled === undefined || proofEnabled === null || proofEnabled === "") {
    return;
  }

  const normalizedProofEnabled = normalizeEnvironmentBoolean(proofEnabled);
  if (normalizedProofEnabled === null) {
    errors.push("PRODUCTION_MARKETPLACE_PROOF_ENABLED must be true or false when present in productionEnvironment.");
    return;
  }

  if (normalizedProofEnabled) {
    if (normalizeEnvironmentBoolean(publicEnabled) === true) {
      errors.push(
        "PRODUCTION_MARKETPLACE_PROOF_ENABLED must be false when PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true.",
      );
    }
    validateReference(
      "PRODUCTION_MARKETPLACE_PROOF_REFERENCE",
      productionEnvironment.PRODUCTION_MARKETPLACE_PROOF_REFERENCE,
      errors,
    );
  }
}

function validateReference(label, value, errors) {
  if (!isNonEmptyString(value)) {
    errors.push(`${label} is required.`);
    return;
  }

  const normalized = value.trim();
  if (normalized.length < 6 || PLACEHOLDER_REFERENCE_PATTERN.test(normalized)) {
    errors.push(`${label} must point to a real external evidence record, not a placeholder.`);
  }
}

function validateRequiredBooleans(label, gate, fields, errors) {
  for (const field of fields) {
    if (gate[field] !== true) {
      errors.push(`${label} must have ${field}=true.`);
    }
  }
}

function validateRequiredStrings(label, gate, fields, errors) {
  for (const field of fields) {
    if (!isNonEmptyString(gate[field])) {
      errors.push(`${label} must include ${field}.`);
    }
  }
}

function validateDetailedReferences(label, gate, fields, errors) {
  for (const field of fields) {
    if (isNonEmptyString(gate[field])) {
      validateReference(`${label} ${field}`, gate[field], errors);
    }
  }
}

function validateConcreteIdentifiers(label, gate, fields, errors) {
  for (const field of fields) {
    if (isNonEmptyString(gate[field])) {
      const normalized = gate[field].trim();
      if (normalized.length < 6 || PLACEHOLDER_REFERENCE_PATTERN.test(normalized)) {
        errors.push(`${label} ${field} must be a concrete identifier, not a placeholder.`);
      }
    }
  }
}

function validateSampledListingIds(label, ids, activeCount, errors) {
  if (!Array.isArray(ids) || ids.length === 0) {
    errors.push(`${label} must include sampledActiveLaunchListingIds from production listings.`);
    return;
  }
  if (Number.isFinite(activeCount) && ids.length > activeCount) {
    errors.push(`${label} sampledActiveLaunchListingIds cannot exceed activeLaunchListingCount.`);
  }
  const normalizedIds = ids.map((id) => (typeof id === "string" ? id.trim() : ""));
  if (new Set(normalizedIds).size !== normalizedIds.length) {
    errors.push(`${label} sampledActiveLaunchListingIds must be distinct.`);
  }
  if (normalizedIds.some((id) => !id || id.length < 4 || PLACEHOLDER_REFERENCE_PATTERN.test(id))) {
    errors.push(`${label} sampledActiveLaunchListingIds must contain concrete listing IDs.`);
  }
}

function validateProductionStripeUrl(label, value, expectedPathname, errors) {
  if (!isNonEmptyString(value)) {
    return;
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !PRODUCTION_STRIPE_WEBHOOK_HOSTS.has(url.hostname) ||
      url.pathname !== expectedPathname
    ) {
      errors.push(`${label} must use ${expectedPathname} on a production Chase Sets host.`);
    }
  } catch {
    errors.push(`${label} must be an absolute HTTPS URL.`);
  }
}

function validateProductionMarketplaceUrl(label, value, expectedPathname, errors) {
  if (!isNonEmptyString(value)) {
    return;
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !PRODUCTION_MARKETPLACE_HOSTS.has(url.hostname) ||
      url.pathname !== expectedPathname
    ) {
      errors.push(`${label} must use ${expectedPathname} on a production Chase Sets host.`);
    }
  } catch {
    errors.push(`${label} must be an absolute HTTPS URL.`);
  }
}

function validatePublicPresenceCopyAuditBaseUrl(value, errors) {
  if (!isNonEmptyString(value)) {
    return;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "chasesets.com") {
      errors.push("Marketplace promotion publicPresenceCopyAuditBaseUrl must use https://chasesets.com.");
    }
  } catch {
    errors.push("Marketplace promotion publicPresenceCopyAuditBaseUrl must be an absolute HTTPS URL.");
  }
}

function validateCheckedAt(label, value, now, errors, warnings) {
  if (!isNonEmptyString(value)) {
    errors.push(`${label} gate must include checkedAt.`);
    return;
  }

  if (!isIsoTimestamp(value)) {
    errors.push(`${label} checkedAt must be an ISO timestamp.`);
    return;
  }

  const checkedAt = new Date(value);
  if (checkedAt.getTime() > now.getTime() + 60_000) {
    errors.push(`${label} checkedAt cannot be in the future.`);
    return;
  }

  const ageDays = (now.getTime() - checkedAt.getTime()) / 86_400_000;
  if (ageDays > MAX_EVIDENCE_AGE_DAYS) {
    errors.push(`${label} evidence cannot be older than ${MAX_EVIDENCE_AGE_DAYS} days.`);
  }
}

function validateEnvironmentBoolean(name, value, expected, errors) {
  const normalized = normalizeEnvironmentBoolean(value);
  if (normalized === null) {
    errors.push(`${name} must be present as true or false in productionEnvironment.`);
    return;
  }
  if (normalized !== expected) {
    errors.push(`${name} must be ${expected ? "true" : "false"} for this launch evidence packet.`);
  }
}

function validateEnvironmentReference(name, value, expected, errors) {
  if (!isNonEmptyString(value)) {
    errors.push(`${name} must be present in productionEnvironment.`);
    return;
  }
  if (value.trim() !== String(expected).trim()) {
    errors.push(`${name} must match the gate reference.`);
  }
}

function normalizeEnvironmentBoolean(value) {
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  return null;
}

function readFileArgument(argv) {
  const fileIndex = argv.indexOf("--file");
  if (fileIndex >= 0) {
    return argv[fileIndex + 1];
  }
  return argv[0] && !argv[0].startsWith("-") ? argv[0] : null;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
