function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function parseLineValues<TValue extends string, TKey extends "action" | "outcome">(
  value: unknown,
  key: TKey,
  allowedValues: readonly TValue[],
) {
  return Array.isArray(value)
    ? value
        .map(objectValue)
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .map((entry) => {
          const parsedValue = stringValue(entry[key]);
          return allowedValues.includes(parsedValue as TValue)
            ? ({ lineId: stringValue(entry.lineId ?? entry.line_id), [key]: parsedValue } as Readonly<
                { lineId: string } & Record<TKey, TValue>
              >)
            : null;
        })
        .filter((entry): entry is Readonly<{ lineId: string } & Record<TKey, TValue>> => Boolean(entry?.lineId))
    : [];
}

export function parseReadinessDecisionInputBase<
  TOutcome extends string,
  TAction extends string = never,
  TOptimizationDecision extends string = never,
>(
  value: unknown,
  options: Readonly<{
    lineOutcomeValues: readonly TOutcome[];
    lineActionValues?: readonly TAction[];
    optimizationDecisionValues?: readonly TOptimizationDecision[];
  }>,
) {
  const source = objectValue(value) ?? {};
  const lineOutcomes = parseLineValues(
    source.lineOutcomes ?? source.line_outcomes,
    "outcome",
    options.lineOutcomeValues,
  );
  const lineActions = options.lineActionValues
    ? parseLineValues(source.lineActions ?? source.line_actions, "action", options.lineActionValues)
    : [];
  const optimizationSource = objectValue(source.optimization);
  const optimizationDecision = stringValue(optimizationSource?.decision);
  const optimization =
    options.optimizationDecisionValues?.includes(optimizationDecision as TOptimizationDecision) === true
      ? {
          decision: optimizationDecision as TOptimizationDecision,
          lineId: stringValue(optimizationSource?.lineId ?? optimizationSource?.line_id),
          listingId: stringValue(optimizationSource?.listingId ?? optimizationSource?.listing_id),
        }
      : null;

  return {
    lineOutcomes,
    lineActions,
    optimization: optimization?.lineId && optimization.listingId ? optimization : null,
  };
}
