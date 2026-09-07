import { describe, expect, it } from "vitest";
import { sanitizeTcgplayerMarketCaptureReceipt } from "../integrations/tcgplayer/capture-sanitizer";
import { generateSyntheticProviderObservationFixture } from "./fixtures/provider-observations/generate-fixture";

describe("tcgplayer-market-capture-v1 response-receipt shape", () => {
  it("retains only field/type/count/coverage facts after privacy reduction", () => {
    const receipt = sanitizeTcgplayerMarketCaptureReceipt(generateSyntheticProviderObservationFixture().capture);
    expect(receipt.kind).toBe("tcgplayer-market-capture-v1");
    expect(receipt.responseSummary).toMatchObject({
      salesReturned: 90,
      captureLocalJointRows: 4,
      maximumTupleMultiplicity: 1,
    });
    expect(JSON.stringify(receipt)).not.toMatch(
      /seller(?:Id|Name|Key|Reference|Identity)|listingId|customData|cookie|authorization|responseBody|exception/i,
    );
  });
});
