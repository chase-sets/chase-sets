import { roundRational } from "@chase-sets/primitives/money";
import type { GuardrailContext, GuardrailDefinition } from "./registry";

export const marketEvidenceFloor: GuardrailDefinition = {
  kind: "market-evidence-floor",
  version: 1,
  slot: "post-max-move",
  validateParameters(parameters) {
    if (Object.keys(parameters).some((key) => key !== "percentOfEstimate"))
      return { kind: "rejected", reason: "guardrail-parameter-unknown" };
    const percent = parameters.percentOfEstimate;
    return typeof percent === "number" && Number.isFinite(percent) && percent >= 50 && percent <= 100
      ? { kind: "valid", parameters: { percentOfEstimate: percent } }
      : { kind: "rejected", reason: "guardrail-parameter-out-of-bounds" };
  },
  apply(context) {
    const estimate = context.marketEstimate;
    if (estimate.state !== "present" || estimate.currencyCode !== context.currencyCode) return { outcome: "inert" };
    const [whole, fraction = ""] = context.parameters.percentOfEstimate!.toString().split(".");
    let floor = roundRational(
      estimate.amountCents * BigInt(whole! + fraction),
      100n * 10n ** BigInt(fraction.length),
      "ceil",
    );
    const secondAsk = resolveSecondAsk(context, estimate.amountCents);
    if (secondAsk !== null && secondAsk < floor) floor = secondAsk;
    const curve = context.curve;
    if (curve.state === "present" && curve.currencyCode === context.currencyCode) {
      for (const point of curve.points) if (point.amountCents < floor) floor = point.amountCents;
    }
    return context.targetCents < floor ? { outcome: "clamp", amountCents: floor } : { outcome: "inert" };
  },
};

function resolveSecondAsk(context: GuardrailContext, estimateCents: bigint): bigint | null {
  const ratio = BigInt(Math.round(context.hardAskOutlierPriceRatio * 100));
  const lower = roundRational(estimateCents * 100n, ratio, "nearest");
  const upper = roundRational(estimateCents * ratio, 100n, "nearest");
  const eligible = context.otherSellerHardAsks
    .filter(
      (ask) =>
        ask.sellerAccountId !== context.sellerAccountId &&
        ask.pricingMode === "hard" &&
        ask.currencyCode === context.currencyCode &&
        ask.amountCents >= lower &&
        ask.amountCents <= upper,
    )
    .map((ask) => ask.amountCents)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return eligible[1] ?? null;
}
