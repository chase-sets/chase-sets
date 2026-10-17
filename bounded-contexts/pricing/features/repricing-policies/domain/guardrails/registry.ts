export type RepricingGuardrail =
  | Readonly<{ kind: "market-evidence-floor"; percentOfEstimate: number }>
  | Readonly<{ kind: "hopeless-forecast-hold" }>;

type UnavailableEvidence = Readonly<{
  state: "stale" | "absent" | "currency-incomplete" | "currency-mismatch";
}>;

export type GuardrailCurveSummary =
  | UnavailableEvidence
  | Readonly<{
      state: "present";
      currencyCode: string;
      points: readonly Readonly<{ amountCents: bigint; medianSellDays: number | null; hopeless: boolean }>[];
    }>;

/** Resolved evidence captured by the engine; no guardrail reads a provider or derives freshness. */
export type GuardrailContext = Readonly<{
  currencyCode: string;
  sellerAccountId: string;
  currentCents: bigint;
  targetCents: bigint;
  resolvedAnchorSource: string;
  parameters: Readonly<Record<string, number>>;
  marketEstimate: UnavailableEvidence | Readonly<{ state: "present"; currencyCode: string; amountCents: bigint }>;
  otherSellerHardAsks: readonly Readonly<{
    sellerAccountId: string;
    pricingMode: "hard" | "derived";
    currencyCode: string | null;
    amountCents: bigint;
  }>[];
  hardAskOutlierPriceRatio: number;
  curve: GuardrailCurveSummary;
}>;

export type GuardrailOutcome =
  | Readonly<{ outcome: "hold"; reason: "hopeless-forecast-hold" }>
  | Readonly<{ outcome: "clamp"; amountCents: bigint }>
  | Readonly<{ outcome: "inert" }>;

export type GuardrailParameterValidation =
  | Readonly<{ kind: "valid"; parameters: Readonly<Record<string, number>> }>
  | Readonly<{ kind: "rejected"; reason: "guardrail-parameter-unknown" | "guardrail-parameter-out-of-bounds" }>;

export type GuardrailDefinition = Readonly<{
  kind: RepricingGuardrail["kind"];
  version: number;
  slot: "pre-offset" | "post-max-move";
  validateParameters(parameters: Readonly<Record<string, unknown>>): GuardrailParameterValidation;
  /** Parameters have passed validateParameters before the engine builds this context. */
  apply(context: GuardrailContext): GuardrailOutcome;
}>;

/** A kind has one registered definition; ordered authored entries are never reordered here. */
export function createGuardrailRegistry(initial: readonly GuardrailDefinition[] = []) {
  const definitions = new Map<string, GuardrailDefinition>();
  const registerGuardrail = (definition: GuardrailDefinition): void => {
    if (definitions.has(definition.kind)) throw new Error(`guardrail-duplicate-kind: ${definition.kind}`);
    if (!Number.isSafeInteger(definition.version) || definition.version < 1)
      throw new Error(`guardrail-version-invalid: ${definition.kind}`);
    definitions.set(definition.kind, definition);
  };
  initial.forEach(registerGuardrail);
  return {
    registerGuardrail,
    resolve: (kind: string): GuardrailDefinition | null => definitions.get(kind) ?? null,
  };
}
