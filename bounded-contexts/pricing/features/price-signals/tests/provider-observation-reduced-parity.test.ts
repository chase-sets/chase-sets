import { describe, expect, it } from "vitest";
import {
  canonicalizeTcgplayerMarketObservationBatch,
  parseTcgplayerMarketObservationBatch,
  type TcgplayerMarketObservationRequest,
} from "@chase-sets/tcgplayer-market-observations";
import { mapProviderObservationCapture } from "../domain/provider-observation-mapper";
import { reducedObservationInput, reducedParityFixture } from "./reduced-observation-test-support";
import { expectSourceMutantRed } from "./source-mutant-test-support";

type MapperModule = typeof import("../domain/provider-observation-mapper");

describe("reduced provider observation mapping", () => {
  it("uses a fixture admitted by the unchanged C0 parser without salvage-only fields", () => {
    const input = reducedObservationInput();
    const request: TcgplayerMarketObservationRequest = {
      contractVersion: 1,
      requestId: "99220000-0000-4000-8000-000000000001",
      phase: "secondary",
      issuedAt: input.captureStartedAt,
      products: [{ productId: 7001, skuIds: [9001], skuTargetCount: 1 }],
      posture: input.executedPosture,
    };
    const batch = {
      contractVersion: 1 as const,
      requestId: request.requestId,
      phase: request.phase,
      posture: request.posture,
      products: [input.observation],
    };
    expect(
      parseTcgplayerMarketObservationBatch(canonicalizeTcgplayerMarketObservationBatch(batch), request).products,
    ).toEqual([input.observation]);
  });

  it("matches salvage sales, weekly, snapshot and joint ask rows on the same reduced synthetic data", () => {
    assertSalvageParity(mapProviderObservationCapture);
  });

  it("rejects restoring the identity-required seam, with all other mapping unchanged", async () => {
    await expectSourceMutantRed<MapperModule>(
      {
        id: "reduced-listing-requires-identity",
        defect: "requires seller identity on the ordinal-only C0 rows",
        mutations: [
          {
            file: "domain/provider-observation-mapper.ts",
            find: "    const ordinal = listing.sellerOrdinal;",
            replace:
              '    if (!("sellerKey" in listing) && !("sellerId" in listing) && !("sellerName" in listing)) continue;\n    const ordinal = listing.sellerOrdinal;',
          },
        ],
      },
      "domain/provider-observation-mapper.ts",
      ["AC1"],
      async (module) => assertSalvageParity(module.mapProviderObservationCapture),
    );
  });

  it("preserves sparse extension ordinals and cent equality before dedupe across printings", () => {
    const input = reducedObservationInput();
    const capture = mapProviderObservationCapture({
      ...input,
      observation: {
        ...input.observation,
        listings: {
          ...input.observation.listings,
          rows: [
            listing(7, "Near Mint", "0.10", "0.20", "Normal"),
            listing(7, "Near Mint", "0.30", "0.00", "Normal"),
            listing(9, "Near Mint", "0.11", "0.20", "Normal"),
            listing(9, "Near Mint", "0.10", "0.21", "Foil"),
            listing(7, "Moderately Played", "0.10", "0.10", "Normal"),
          ],
        },
      },
    });
    expect(
      capture.askDepth.map(({ anonymousCaptureSellerOrdinal, deliveredAmount }) => [
        anonymousCaptureSellerOrdinal,
        deliveredAmount,
      ]),
    ).toEqual([
      [7, "0.20"],
      [7, "0.30"],
      [9, "0.31"],
    ]);
    expect(capture.snapshots).toEqual([
      expect.objectContaining({
        providerVariant: "Normal",
        providerCondition: "Near Mint",
        distinctSellerCount: 2,
        cheapestDeliveredAmount: "0.30",
        secondCheapestDeliveredAmount: "0.31",
      }),
      expect.objectContaining({ providerVariant: "Foil", distinctSellerCount: 1, cheapestDeliveredAmount: "0.31" }),
      expect.objectContaining({ providerCondition: "Moderately Played", cheapestDeliveredAmount: "0.20" }),
    ]);
  });
});

function assertSalvageParity(map: MapperModule["mapProviderObservationCapture"]) {
  expect(reducedParityFixture.sourceCommit).toBe("0a0f3f081d618ce346ac1efa1a322aea9c2d42cb");
  expect(reducedParityFixture.status).toBe("synthetic-not-live-salvage-parity");
  const { sales, weekly, snapshots, askDepth } = map(reducedObservationInput());
  expect(sales, "AC1:sales-fingerprints-and-occurrences").toEqual(reducedParityFixture.expected.sales);
  expect(weekly, "AC1:history-buckets-as-given").toEqual(reducedParityFixture.expected.weekly);
  expect(snapshots, "AC1:snapshot-grain-counts-and-cheapest-pair").toEqual(reducedParityFixture.expected.snapshots);
  expect(askDepth, "AC1:ordinal-condition-and-delivered-depth").toEqual(reducedParityFixture.expected.askDepth);
}

function listing(sellerOrdinal: number, condition: string, price: string, shipping: string, printing: string) {
  return { sellerOrdinal, condition, printing, language: "English", price, sellerShippingPrice: shipping };
}
