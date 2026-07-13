import { describe, expect, it } from "vitest";
import {
  landingExperimentVariantForIntent,
  landingExperimentVariants,
  normalizeLandingExperimentVariant,
  resolveLandingIntent,
} from "./landing-experiment";

describe("landing experiment assignment", () => {
  it("keeps the seller-first default without an intent signal", () => {
    expect(resolveLandingIntent({})).toBe("both");
    expect(landingExperimentVariantForIntent("both")).toBe(landingExperimentVariants.sellerFirstV1);
    expect(landingExperimentVariantForIntent("sell")).toBe(landingExperimentVariants.sellerFirstV1);
  });

  it("honors explicit intent before UTM inference", () => {
    expect(resolveLandingIntent({ intent: "buy", utmCampaign: "seller-first" })).toBe("buy");
    expect(resolveLandingIntent({ intent: "sell", utmCampaign: "buyer-collectors" })).toBe("sell");
  });

  it("assigns buyer-oriented UTM campaigns to the buyer hero", () => {
    expect(resolveLandingIntent({ utmCampaign: "buyers-summer-wave" })).toBe("buy");
    expect(resolveLandingIntent({ utmContent: "collector-set-completion" })).toBe("buy");
    expect(landingExperimentVariantForIntent("buy")).toBe(landingExperimentVariants.sellerFirstV2);
  });

  it("falls back safely when a redirect carries an unknown variant", () => {
    expect(normalizeLandingExperimentVariant("unknown")).toBe(landingExperimentVariants.sellerFirstV1);
    expect(normalizeLandingExperimentVariant(landingExperimentVariants.sellerFirstV2)).toBe(
      landingExperimentVariants.sellerFirstV2,
    );
  });
});
