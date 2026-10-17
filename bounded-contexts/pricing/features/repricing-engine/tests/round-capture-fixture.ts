import type { EconomicsServices } from "../../economics/api/services";
import { REPRICING_ENGINE_LAUNCH_POLICY_VALUE } from "../domain/policy";
import type { RepricingRoundCapture } from "../read-model/queries";

/** Economics for rounds whose rules hold no goal requiring it: any resolve is a defect. */
export const economicsNeverResolved: Pick<EconomicsServices, "resolve"> = {
  resolve: async () => {
    throw new Error("This round must not resolve Economics.");
  },
};

export const roundCapture = (capturedAt = new Date().toISOString()): RepricingRoundCapture => ({
  capturedAt,
  policy: REPRICING_ENGINE_LAUNCH_POLICY_VALUE,
  economics: economicsNeverResolved,
});
