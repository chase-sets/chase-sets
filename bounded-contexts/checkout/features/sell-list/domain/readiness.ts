export type SellListReadinessLine = Readonly<{
  seller_account_id: string;
  line_id: string;
  line_type: "selected-offer" | "product";
  offer_id: string | null;
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
    payout: "not-evaluated" | "ready" | "blocked";
    shipFrom: "not-evaluated" | "ready" | "blocked";
    label: "not-evaluated" | "ready" | "blocked";
  }>;
  customerSafeFacts: readonly string[];
}>;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function parseSellListReadinessDecisionInput(value: unknown): SellListReadinessDecisionInput {
  const source = objectValue(value) ?? {};
  const rawLineOutcomes = source.lineOutcomes ?? source.line_outcomes;
  const lineOutcomes = Array.isArray(rawLineOutcomes)
    ? rawLineOutcomes
        .map(objectValue)
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .map((entry) => {
          const outcome = stringValue(entry.outcome);
          return outcome === "removed" || outcome === "keep-in-list"
            ? {
                lineId: stringValue(entry.lineId ?? entry.line_id),
                outcome,
              }
            : null;
        })
        .filter(
          (entry): entry is Readonly<{ lineId: string; outcome: Exclude<SellListReadinessLineOutcome, "checkout"> }> =>
            Boolean(entry?.lineId),
        )
    : [];
  const rawLineActions = source.lineActions ?? source.line_actions;
  const lineActions = Array.isArray(rawLineActions)
    ? rawLineActions
        .map(objectValue)
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .map((entry) => {
          const action = stringValue(entry.action);
          return action === "selected-offer" || action === "smart-match" || action === "fallback-listing"
            ? {
                lineId: stringValue(entry.lineId ?? entry.line_id),
                action,
              }
            : null;
        })
        .filter((entry): entry is Readonly<{ lineId: string; action: SellListReadinessLineAction }> =>
          Boolean(entry?.lineId),
        )
    : [];

  return { lineOutcomes, lineActions };
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
  if (line.line_type === "selected-offer" && line.offer_id && moneyValue(line.offer_price_amount) !== null) {
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
  const snapshotSeed = {
    sourceRevision,
    includedLineIds,
    lineOutcomes,
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
    sellerReadiness: {
      payout: "not-evaluated",
      shipFrom: "not-evaluated",
      label: "not-evaluated",
    },
    customerSafeFacts: [
      status === "ready"
        ? "Ready for seller checkout."
        : status === "blocked"
          ? "No Sell List items are ready for seller checkout."
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
  },
) {
  const current = createSellListReadinessSnapshot(lines, provided.decisions);
  return {
    current,
    valid: current.snapshotId === provided.snapshotId && current.sourceRevision === provided.sourceRevision,
  };
}
