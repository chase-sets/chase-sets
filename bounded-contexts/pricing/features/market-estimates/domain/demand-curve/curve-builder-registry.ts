export type CurveSale = Readonly<{
  price: number;
  soldAt: string;
  condition: string;
  variant: string;
  language: string;
  source: "platform-verified-trade" | "platform-trade" | "external-comp";
  coverage: string;
  participantId?: string;
}>;

export type CurveBuilderDefinition = Readonly<{
  id: string;
  version: string;
  weightSource: CurveSale["source"];
  load: (
    identity: Readonly<{
      catalogItemId: string;
      productId: string;
      condition: string;
      variant: string;
      language: string;
    }>,
    window: Readonly<{ since: string; asOf: string; freeShippingThreshold: number; salesLimit: number }>,
  ) => Promise<readonly CurveSale[]>;
}>;

/** Builders contribute evidence only; the merge and readers never switch on a builder id. */
export function createCurveBuilderRegistry(initial: readonly CurveBuilderDefinition[] = []) {
  const builders = new Map<string, CurveBuilderDefinition>();
  const registerCurveBuilder = (builder: CurveBuilderDefinition): void => {
    if (!builder.id || !builder.version || builders.has(builder.id))
      throw new Error("Curve builder id/version must be unique and nonempty.");
    builders.set(builder.id, builder);
  };
  initial.forEach(registerCurveBuilder);
  return {
    registerCurveBuilder,
    definitions: () => [...builders.values()].sort((a, b) => a.id.localeCompare(b.id)),
    load: async (
      identity: Parameters<CurveBuilderDefinition["load"]>[0],
      window: Parameters<CurveBuilderDefinition["load"]>[1],
    ) => (await Promise.all([...builders.values()].map((builder) => builder.load(identity, window)))).flat(),
  };
}

export type CurveBuilderRegistry = ReturnType<typeof createCurveBuilderRegistry>;

/** Explicit registration port for consumers composing a Pricing curve runtime. */
export function registerCurveBuilder(registry: CurveBuilderRegistry, definition: CurveBuilderDefinition): void {
  registry.registerCurveBuilder(definition);
}
