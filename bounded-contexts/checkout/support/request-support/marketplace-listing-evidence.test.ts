import { describe, expect, it } from "vitest";
import { evidenceCoverageCodeLocaleKey as marketplaceLocaleKey } from "@chase-sets/marketplace/server";
import { evidenceCoverageCodeLocaleKey, type EvidenceCoverageCode } from "./marketplace-listing-evidence";

const coverageCodes: Record<EvidenceCoverageCode, true> = {
  "min-photo-count-unmet": true,
  "slot-missing": true,
  "slot-view-mismatch": true,
  "slot-dimensions-too-small": true,
  "slot-expired": true,
  "duplicate-source": true,
};

describe("Checkout listing evidence locale keys", () => {
  for (const code of Object.keys(coverageCodes) as EvidenceCoverageCode[]) {
    it(`matches Marketplace for ${code}`, () => {
      expect(evidenceCoverageCodeLocaleKey(code)).toBe(marketplaceLocaleKey(code));
    });
  }
});
