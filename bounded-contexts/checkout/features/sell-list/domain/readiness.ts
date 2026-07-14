import { parseReadinessDecisionInputBase } from "../../../support/request-support/readiness-decision-parser";
import type { SellListSellerConfirmationEvidence } from "./domain";

export type SellListReadinessLine = Readonly<{
  seller_account_id: string;
  line_id: string;
  line_type: "selected-offer" | "product";
  offer_id: string | null;
  listing_id: string | null;
  offer_price_amount: string | null;
  product_id: string;
  item_title: string;
  quantity: number;
  fallback_mode: "none" | "create-listing";
  minimum_listing_price_amount: string | null;
  updated_at: string;
}>;

export type SellListReadinessLineOutcome = "checkout" | "keep-in-list" | "removed";
export type SellListReadinessLineAction = "selected-offer" | "smart-match" | "fallback-listing";
export type SellListSellerReadinessDimension =
  | "ship-from"
  | "payout"
  | "label"
  | "condition-review"
  | "risk"
  | "provider"
  | "freshness";
export type SellListSellerReadinessReason =
  | "ready"
  | "missing-seller-evidence"
  | "ship-from-not-ready"
  | "payout-not-ready"
  | "label-not-ready"
  | "condition-review-not-accepted"
  | "risk-not-clear"
  | "provider-not-ready"
  | "seller-evidence-stale";

export type SellListReadinessDecisionInput = Readonly<{
  lineOutcomes?: readonly Readonly<{
    lineId: string;
    outcome: Exclude<SellListReadinessLineOutcome, "checkout">;
  }>[];
  lineActions?: readonly Readonly<{
    lineId: string;
    action: SellListReadinessLineAction;
  }>[];
}>;

export type SellListReadinessSnapshot = Readonly<{
  schemaVersion: "checkout.sell-list-readiness.v1";
  source: "sell-list";
  sourceRevision: string;
  snapshotId: string;
  status: "ready" | "needs-resolution" | "blocked";
  lineCount: number;
  includedLineIds: readonly string[];
  unresolvedLineIds: readonly string[];
  lineOutcomes: readonly Readonly<{
    lineId: string;
    outcome: SellListReadinessLineOutcome;
    reason: "ready" | "missing-selected-offer" | "missing-sale-action" | "missing-listing-price";
    action: SellListReadinessLineAction | null;
  }>[];
  sellerReadiness: Readonly<{
    status: "ready" | "blocked";
    evidenceRevision: string | null;
    payout: "ready" | "blocked";
    shipFrom: "ready" | "blocked";
    label: "ready" | "blocked";
    conditionReview: "ready" | "blocked";
    risk: "ready" | "blocked";
    provider: "ready" | "blocked";
    freshness: "ready" | "blocked";
    outcomes: readonly Readonly<{
      dimension: SellListSellerReadinessDimension;
      status: "ready" | "blocked";
      reason: SellListSellerReadinessReason;
    }>[];
  }>;
  customerSafeFacts: readonly string[];
}>;

export function parseSellListReadinessDecisionInput(value: unknown): SellListReadinessDecisionInput {
  const parsed = parseReadinessDecisionInputBase(value, {
    lineOutcomeValues: ["removed", "keep-in-list"] as const,
    lineActionValues: ["selected-offer", "smart-match", "fallback-listing"] as const,
  });

  return { lineOutcomes: parsed.lineOutcomes, lineActions: parsed.lineActions };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function stableHash(value: unknown) {
  const text = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `slr_${(hash >>> 0).toString(36)}`;
}

function sellerEvidenceRevisionFor(evidence: SellListSellerConfirmationEvidence) {
  return stableHash({
    shipFrom: evidence.shipFrom,
    payout: evidence.payout,
    label: evidence.label,
    conditionReview: evidence.conditionReview,
    risk: evidence.risk,
    provider: evidence.provider,
    freshness: evidence.freshness,
  });
}

function sellerOutcome(
  dimension: SellListSellerReadinessDimension,
  ready: boolean,
  blockedReason: SellListSellerReadinessReason,
) {
  return {
    dimension,
    status: ready ? "ready" : "blocked",
    reason: ready ? "ready" : blockedReason,
  } as const;
}

function createMissingSellerReadiness() {
  const dimensions: readonly SellListSellerReadinessDimension[] = [
    "ship-from",
    "payout",
    "label",
    "condition-review",
    "risk",
    "provider",
    "freshness",
  ];
  const outcomes = dimensions.map((dimension) => ({
    dimension,
    status: "blocked" as const,
    reason: "missing-seller-evidence" as const,
  }));

  return {
    status: "blocked" as const,
    evidenceRevision: null,
    payout: "blocked" as const,
    shipFrom: "blocked" as const,
    label: "blocked" as const,
    conditionReview: "blocked" as const,
    risk: "blocked" as const,
    provider: "blocked" as const,
    freshness: "blocked" as const,
    outcomes,
  };
}

function createSellerReadiness(evidence: SellListSellerConfirmationEvidence | null | undefined) {
  if (!evidence) {
    return createMissingSellerReadiness();
  }

  const shipFromReady =
    evidence.shipFrom.status === "ready" &&
    Boolean(evidence.shipFrom.country) &&
    Boolean(evidence.shipFrom.region) &&
    Boolean(evidence.shipFrom.postalCode);
  const payoutReady =
    evidence.payout.status === "ready" &&
    evidence.payout.method === "saved-payout" &&
    evidence.payout.readinessStatus === "ready";
  const labelReady =
    evidence.label.status === "ready" &&
    (evidence.label.preference === "prepaid-label" || evidence.label.preference === "seller-label-later");
  const conditionReviewReady =
    evidence.conditionReview.status === "accepted" && Boolean(evidence.conditionReview.acceptedAt);
  const riskReady = evidence.risk.status === "clear";
  const providerReady = evidence.provider.status === "ready";
  const freshnessReady = evidence.freshness.status === "current";
  const outcomes = [
    sellerOutcome("ship-from", shipFromReady, "ship-from-not-ready"),
    sellerOutcome("payout", payoutReady, "payout-not-ready"),
    sellerOutcome("label", labelReady, "label-not-ready"),
    sellerOutcome("condition-review", conditionReviewReady, "condition-review-not-accepted"),
    sellerOutcome("risk", riskReady, "risk-not-clear"),
    sellerOutcome("provider", providerReady, "provider-not-ready"),
    sellerOutcome("freshness", freshnessReady, "seller-evidence-stale"),
  ];
  const ready = outcomes.every((outcome) => outcome.status === "ready");

  return {
    status: ready ? ("ready" as const) : ("blocked" as const),
    evidenceRevision: sellerEvidenceRevisionFor(evidence),
    payout: payoutReady ? ("ready" as const) : ("blocked" as const),
    shipFrom: shipFromReady ? ("ready" as const) : ("blocked" as const),
    label: labelReady ? ("ready" as const) : ("blocked" as const),
    conditionReview: conditionReviewReady ? ("ready" as const) : ("blocked" as const),
    risk: riskReady ? ("ready" as const) : ("blocked" as const),
    provider: providerReady ? ("ready" as const) : ("blocked" as const),
    freshness: freshnessReady ? ("ready" as const) : ("blocked" as const),
    outcomes,
  };
}

function moneyValue(amount: string | null | undefined) {
  const value = Number(amount);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeDecisions(decisions: SellListReadinessDecisionInput | null | undefined) {
  const lineOutcomes = new Map<string, Exclude<SellListReadinessLineOutcome, "checkout">>();
  for (const decision of decisions?.lineOutcomes ?? []) {
    if (decision.outcome === "removed" || decision.outcome === "keep-in-list") {
      lineOutcomes.set(decision.lineId, decision.outcome);
    }
  }

  const lineActions = new Map<string, SellListReadinessLineAction>();
  for (const decision of decisions?.lineActions ?? []) {
    if (
      decision.action === "selected-offer" ||
      decision.action === "smart-match" ||
      decision.action === "fallback-listing"
    ) {
      lineActions.set(decision.lineId, decision.action);
    }
  }

  return { lineOutcomes, lineActions };
}

function defaultLineAction(line: SellListReadinessLine): SellListReadinessLineAction | null {
  if (
    line.line_type === "selected-offer" &&
    line.offer_id &&
    line.listing_id &&
    moneyValue(line.offer_price_amount) !== null
  ) {
    return "selected-offer";
  }

  if (
    line.line_type === "product" &&
    line.fallback_mode === "create-listing" &&
    moneyValue(line.minimum_listing_price_amount) !== null
  ) {
    return "fallback-listing";
  }

  return null;
}

function lineReason(
  line: SellListReadinessLine,
  action: SellListReadinessLineAction | null,
): SellListReadinessSnapshot["lineOutcomes"][number]["reason"] {
  if (action) {
    return "ready";
  }

  if (line.line_type === "selected-offer") {
    return "missing-selected-offer";
  }

  if (line.fallback_mode === "create-listing" && moneyValue(line.minimum_listing_price_amount) === null) {
    return "missing-listing-price";
  }

  return "missing-sale-action";
}

function sourceRevisionFor(lines: readonly SellListReadinessLine[]) {
  return stableHash(
    lines.map((line) => ({
      lineId: line.line_id,
      lineType: line.line_type,
      offerId: line.offer_id,
      listingId: line.listing_id,
      offerPriceAmount: line.offer_price_amount,
      productId: line.product_id,
      quantity: line.quantity,
      fallbackMode: line.fallback_mode,
      minimumListingPriceAmount: line.minimum_listing_price_amount,
      updatedAt: line.updated_at,
    })),
  );
}

export function createSellListReadinessSnapshot(
  lines: readonly SellListReadinessLine[],
  decisions?: SellListReadinessDecisionInput | null,
  sellerEvidence?: SellListSellerConfirmationEvidence | null,
): SellListReadinessSnapshot {
  const sortedLines = [...lines].sort((left, right) => left.line_id.localeCompare(right.line_id));
  const normalized = normalizeDecisions(decisions);
  const lineOutcomes = sortedLines.map((line) => {
    const explicitAction = normalized.lineActions.get(line.line_id) ?? null;
    const action = explicitAction ?? defaultLineAction(line);
    const reason = lineReason(line, action);
    const explicitOutcome = normalized.lineOutcomes.get(line.line_id);
    const outcome: SellListReadinessLineOutcome = explicitOutcome ?? "checkout";
    return {
      lineId: line.line_id,
      outcome,
      reason,
      action,
    };
  });
  const includedLineIds = lineOutcomes
    .filter((outcome) => outcome.outcome === "checkout" && outcome.reason === "ready")
    .map((outcome) => outcome.lineId)
    .sort();
  const unresolvedLineIds = lineOutcomes
    .filter((outcome) => outcome.outcome === "checkout" && outcome.reason !== "ready")
    .map((outcome) => outcome.lineId)
    .sort();
  const status =
    includedLineIds.length === 0 ? "blocked" : unresolvedLineIds.length > 0 ? "needs-resolution" : ("ready" as const);
  const sourceRevision = sourceRevisionFor(sortedLines);
  const sellerReadiness = createSellerReadiness(sellerEvidence);
  const snapshotSeed = {
    sourceRevision,
    includedLineIds,
    lineOutcomes,
    sellerEvidenceRevision: sellerReadiness.evidenceRevision,
  };

  return {
    schemaVersion: "checkout.sell-list-readiness.v1",
    source: "sell-list",
    sourceRevision,
    snapshotId: stableHash(snapshotSeed),
    status,
    lineCount: sortedLines.reduce((sum, line) => sum + line.quantity, 0),
    includedLineIds,
    unresolvedLineIds,
    lineOutcomes,
    sellerReadiness,
    customerSafeFacts: [
      status === "ready" && sellerReadiness.status === "ready"
        ? "Ready for seller checkout."
        : status === "blocked"
          ? "No Sell List items are ready for seller checkout."
          : sellerReadiness.status === "blocked"
            ? "Seller evidence must be ready before seller checkout can confirm."
            : "Some Sell List items need attention before seller checkout.",
    ],
  };
}

export function applySellListReadinessToLines<TLine extends SellListReadinessLine>(
  lines: readonly TLine[],
  snapshot: SellListReadinessSnapshot,
): TLine[] {
  const included = new Set(snapshot.includedLineIds);
  return lines.filter((line) => included.has(line.line_id));
}

export function validateSellListReadinessSnapshot(
  lines: readonly SellListReadinessLine[],
  provided: Pick<SellListReadinessSnapshot, "snapshotId" | "sourceRevision"> & {
    decisions?: SellListReadinessDecisionInput | null;
    sellerEvidence?: SellListSellerConfirmationEvidence | null;
  },
) {
  const current = createSellListReadinessSnapshot(lines, provided.decisions, provided.sellerEvidence);
  return {
    current,
    valid: current.snapshotId === provided.snapshotId && current.sourceRevision === provided.sourceRevision,
  };
}
