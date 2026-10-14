import type { GuardrailDefinition } from "./registry";

export const hopelessForecastHold: GuardrailDefinition = {
  kind: "hopeless-forecast-hold",
  version: 1,
  slot: "pre-offset",
  validateParameters: (parameters) =>
    Object.keys(parameters).length === 0
      ? { kind: "valid", parameters: {} }
      : { kind: "rejected", reason: "guardrail-parameter-unknown" },
  apply(context) {
    const curve = context.curve;
    if (
      context.resolvedAnchorSource !== "curve-objective" ||
      curve.state !== "present" ||
      curve.currencyCode !== context.currencyCode
    )
      return { outcome: "inert" };
    let fastest: (typeof curve.points)[number] | null = null;
    for (const point of curve.points) {
      if (point.medianSellDays !== null && (fastest === null || point.medianSellDays < fastest.medianSellDays!))
        fastest = point;
    }
    return fastest?.hopeless ? { outcome: "hold", reason: "hopeless-forecast-hold" } : { outcome: "inert" };
  },
};
