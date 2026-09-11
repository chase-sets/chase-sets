import {
  validateMarketplaceLabelPostageActivation,
  type MarketplaceLabelPostageActivation,
} from "@chase-sets/settlement/server";

type StartupLogger = Readonly<{
  info?: (message: string, fields?: Record<string, unknown>) => void;
  error?: (message: string, fields?: Record<string, unknown>) => void;
}>;

export async function initializeMarketplaceLabelPostageWorkerRuntime<T>(
  input: Readonly<{
    bootstrapSettlementDatabase: () => Promise<void>;
    activateMarketplaceLabelPostage: () => Promise<unknown>;
    constructRuntime: (activation: MarketplaceLabelPostageActivation) => T;
    logger?: StartupLogger;
  }>,
): Promise<T> {
  await input.bootstrapSettlementDatabase();

  let activation: MarketplaceLabelPostageActivation;
  try {
    activation = validateMarketplaceLabelPostageActivation(await input.activateMarketplaceLabelPostage());
  } catch (error) {
    input.logger?.error?.("Marketplace label postage runner activation refused.", {
      type: "settlement.marketplace_label_postage.activation_refused",
      error,
    });
    throw error;
  }

  input.logger?.info?.("Marketplace label postage runner activation loaded.", {
    type: "settlement.marketplace_label_postage.activation_loaded",
    policyVersion: activation.policyVersion,
    activatedAt: activation.activatedAt,
  });
  return input.constructRuntime(activation);
}
