import { beforeAll, describe, expect, it } from "vitest";
import {
  PART_TEXT_MAX_BYTES,
  assembleAdmittedTcgplayerMarketObservationBatch,
  canonicalizeTcgplayerMarketObservationBatch,
  digestTcgplayerMarketObservationBatchText,
  maxBatchTextBytes,
  maxPartCount,
  parseAdmissionPayload,
  parsePartPayload,
  parseTcgplayerMarketObservationRequest,
  splitTcgplayerMarketObservationBatchText,
  TcgplayerMarketObservationContractError,
  type TcgplayerMarketObservationHistoryEvent,
} from "./index";
import { sourceMutant } from "./mutants";

const RID = "123e4567-e89b-12d3-a456-426614174000";
const BID = "123e4567-e89b-12d3-a456-426614174001";
const GID = "123e4567-e89b-12d3-a456-426614174002";
const OTHER_BID = "123e4567-e89b-12d3-a456-426614174009";
const T0 = "2026-10-17T00:00:00.000Z";
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const errorCode = (fn: () => unknown) => {
  try {
    fn();
    return "accepted";
  } catch (error) {
    return error instanceof TcgplayerMarketObservationContractError ? error.code : "unknown";
  }
};
const request = parseTcgplayerMarketObservationRequest({
  contractVersion: 1,
  requestId: RID,
  phase: "price-points",
  issuedAt: T0,
  products: [{ productId: 1, skuIds: [1], skuTargetCount: 1 }],
  posture: null,
});
const text = JSON.stringify({
  contractVersion: 1,
  requestId: request.requestId,
  phase: request.phase,
  posture: null,
  products: [
    {
      productId: 1,
      pricePoints: [
        { skuId: 1, marketPrice: null, lowestPrice: null, highestPrice: null, priceCount: null, calculatedAt: null },
      ],
    },
  ],
});
// A multi-part fixture: two products of 250 price points split into three parts.
const skuIds250 = Array.from({ length: 250 }, (_, i) => i + 1);
const multiRequest = parseTcgplayerMarketObservationRequest({
  contractVersion: 1,
  requestId: RID,
  phase: "price-points",
  issuedAt: T0,
  products: [1, 2].map((productId) => ({ productId, skuIds: skuIds250, skuTargetCount: 250 })),
  posture: null,
});
const multiText = JSON.stringify({
  contractVersion: 1,
  requestId: RID,
  phase: "price-points",
  posture: null,
  products: multiRequest.products.map((p) => ({
    productId: p.productId,
    pricePoints: p.skuIds.map((skuId) => ({
      skuId,
      marketPrice: "9999999.99",
      lowestPrice: "9999999.99",
      highestPrice: "9999999.99",
      priceCount: 123456,
      calculatedAt: T0,
    })),
  })),
});
const parts = splitTcgplayerMarketObservationBatchText(multiText);
const maxParts = maxPartCount(multiRequest);
const maxBytes = maxBatchTextBytes(multiRequest);
const admissionBase = {
  batchId: BID,
  requestId: RID,
  phase: "price-points",
  contractVersion: 1,
  partCount: parts.length,
  textBytes: bytes(multiText),
  digest: "0".repeat(64),
  grantId: GID,
  creatorMembershipId: "membership",
  creatorUserId: "user",
  admittedAt: T0,
};
const partPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  batchId: BID,
  requestId: RID,
  phase: "price-points",
  partIndex: 0,
  text: parts[0],
  ...overrides,
});
const admissionPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...admissionBase,
  ...overrides,
});
const withoutKey = (payload: Record<string, unknown>, key: string) => {
  const { [key]: _dropped, ...rest } = payload;
  return rest;
};
const a12Part: [name: string, payload: Record<string, unknown>, expected: string][] = [
  ["A12 part partIndex -1", partPayload({ partIndex: -1 }), "invalid_part_index"],
  ["A12 part partIndex 0", partPayload({ partIndex: 0 }), "accepted"],
  [`A12 part partIndex maxPartCount-1 (${maxParts - 1})`, partPayload({ partIndex: maxParts - 1 }), "accepted"],
  [`A12 part partIndex maxPartCount (${maxParts})`, partPayload({ partIndex: maxParts }), "invalid_part_index"],
  ["A12 part fractional partIndex", partPayload({ partIndex: 0.5 }), "invalid_part_index"],
  ["A12 part unknown key", partPayload({ extra: true }), "invalid_part"],
  ["A12 part missing key", withoutKey(partPayload(), "text"), "invalid_part"],
  ["A12 part empty text", partPayload({ text: "" }), "invalid_part_text"],
  ["A12 part 30,000-byte text", partPayload({ text: "x".repeat(PART_TEXT_MAX_BYTES) }), "accepted"],
  ["A12 part 30,001-byte text", partPayload({ text: "x".repeat(PART_TEXT_MAX_BYTES + 1) }), "invalid_part_text"],
  ["A12 part non-ASCII text", partPayload({ text: "abcé" }), "invalid_part_text"],
  ["A12 part non-UUID batchId", partPayload({ batchId: "not-a-uuid" }), "invalid_part_identity"],
  ["A12 part uppercase batchId", partPayload({ batchId: BID.toUpperCase() }), "invalid_part_identity"],
  ["A12 part foreign requestId", partPayload({ requestId: GID }), "invalid_part_identity"],
  ["A12 part foreign phase", partPayload({ phase: "secondary" }), "invalid_part_identity"],
];
const a12Admission: [name: string, payload: Record<string, unknown>, expected: string][] = [
  ["A12 admission partCount 0", admissionPayload({ partCount: 0, textBytes: 1 }), "invalid_admission"],
  ["A12 admission partCount 1 with textBytes 1", admissionPayload({ partCount: 1, textBytes: 1 }), "accepted"],
  [
    `A12 admission partCount maxPartCount (${maxParts}) with textBytes maxBatchTextBytes`,
    admissionPayload({ partCount: maxParts, textBytes: maxBytes }),
    "accepted",
  ],
  [
    `A12 admission partCount maxPartCount+1 (${maxParts + 1})`,
    admissionPayload({ partCount: maxParts + 1, textBytes: maxBytes }),
    "invalid_admission",
  ],
  ["A12 admission textBytes 0", admissionPayload({ partCount: 1, textBytes: 0 }), "invalid_admission"],
  [
    "A12 admission textBytes maxBatchTextBytes+1",
    admissionPayload({ partCount: maxParts, textBytes: maxBytes + 1 }),
    "invalid_admission",
  ],
  [
    "A12 admission textBytes inconsistent with partCount",
    admissionPayload({ partCount: 1, textBytes: PART_TEXT_MAX_BYTES + 1 }),
    "invalid_admission",
  ],
  ["A12 admission fractional partCount", admissionPayload({ partCount: 1.5 }), "invalid_admission"],
  ["A12 admission uppercase hex digest", admissionPayload({ digest: "A".repeat(64) }), "invalid_admission"],
  ["A12 admission 63-char hex digest", admissionPayload({ digest: "a".repeat(63) }), "invalid_admission"],
  ["A12 admission unknown key", admissionPayload({ extra: true }), "invalid_admission"],
  ["A12 admission missing key", withoutKey(admissionPayload(), "grantId"), "invalid_admission"],
  ["A12 admission creatorMembershipId empty", admissionPayload({ creatorMembershipId: "" }), "invalid_admission"],
  [
    "A12 admission creatorMembershipId 128 chars",
    admissionPayload({ creatorMembershipId: "m".repeat(128) }),
    "accepted",
  ],
  [
    "A12 admission creatorMembershipId 129 chars",
    admissionPayload({ creatorMembershipId: "m".repeat(129) }),
    "invalid_admission",
  ],
  ["A12 admission creatorUserId empty", admissionPayload({ creatorUserId: "" }), "invalid_admission"],
  ["A12 admission creatorUserId 129 chars", admissionPayload({ creatorUserId: "u".repeat(129) }), "invalid_admission"],
  ["A12 admission non-UUID batchId", admissionPayload({ batchId: "not-a-uuid" }), "invalid_admission"],
  ["A12 admission non-UUID grantId", admissionPayload({ grantId: "not-a-uuid" }), "invalid_admission"],
  ["A12 admission foreign requestId", admissionPayload({ requestId: GID }), "invalid_admission"],
  ["A12 admission foreign phase", admissionPayload({ phase: "secondary" }), "invalid_admission"],
  ["A12 admission contractVersion 2", admissionPayload({ contractVersion: 2 }), "invalid_admission"],
  ["A12 admission non-Instant admittedAt", admissionPayload({ admittedAt: "2026-10-17" }), "invalid_admission"],
];

describe("admitted batch assembly (AC4)", () => {
  let digest = "";
  beforeAll(async () => {
    digest = await digestTcgplayerMarketObservationBatchText(multiText);
  });
  const partEvent = (index: number, streamVersion = index + 1, overrides: Record<string, unknown> = {}) => ({
    streamVersion,
    data: partPayload({ partIndex: index, text: parts[index], ...overrides }),
  });
  const admissionEvent = (streamVersion = parts.length + 1, overrides: Record<string, unknown> = {}) => ({
    streamVersion,
    data: admissionPayload({ digest, ...overrides }),
  });
  const complete = () => [...parts.map((_, index) => partEvent(index)), admissionEvent()];
  const rejects = (history: readonly TcgplayerMarketObservationHistoryEvent[], code: string) =>
    expect(assembleAdmittedTcgplayerMarketObservationBatch(history, multiRequest)).rejects.toMatchObject({ code });

  it("A01/A10/A03 requires all parts and the admission on the single-part fixture", async () => {
    const singleParts = splitTcgplayerMarketObservationBatchText(text);
    const singleDigest = await digestTcgplayerMarketObservationBatchText(text);
    const history = [
      {
        streamVersion: 1,
        data: { batchId: BID, requestId: request.requestId, phase: request.phase, partIndex: 0, text: singleParts[0] },
      },
      {
        streamVersion: 2,
        data: {
          batchId: BID,
          requestId: request.requestId,
          phase: request.phase,
          contractVersion: 1,
          partCount: 1,
          textBytes: text.length,
          digest: singleDigest,
          grantId: GID,
          creatorMembershipId: "membership",
          creatorUserId: "user",
          admittedAt: T0,
        },
      },
    ];
    await expect(assembleAdmittedTcgplayerMarketObservationBatch(history, request)).resolves.toMatchObject({
      requestId: request.requestId,
    });
    await expect(
      assembleAdmittedTcgplayerMarketObservationBatch([{ ...history[1]!, streamVersion: 1 }], request),
    ).rejects.toMatchObject({ code: "invalid_history_parts" });
    await expect(
      assembleAdmittedTcgplayerMarketObservationBatch(
        [{ ...history[0]!, data: { ...history[0]!.data, batchId: OTHER_BID } }, history[1]!],
        request,
      ),
    ).rejects.toMatchObject({ code: "foreign_part" });
    await expect(
      assembleAdmittedTcgplayerMarketObservationBatch([history[1]!, history[0]!], request),
    ).rejects.toMatchObject({ code: "misordered_history" });
  });
  it("A01 accepts the complete three-part history and returns the identical batch", async () => {
    expect(parts).toHaveLength(3);
    const assembled = await assembleAdmittedTcgplayerMarketObservationBatch(complete(), multiRequest);
    expect(canonicalizeTcgplayerMarketObservationBatch(assembled)).toBe(multiText);
  });
  it("A02 rejects a missing part", () =>
    rejects([partEvent(0), partEvent(1), admissionEvent(3)], "invalid_history_parts"));
  it("A03 rejects a foreign part", () =>
    rejects([partEvent(0), partEvent(1, 2, { batchId: OTHER_BID }), partEvent(2), admissionEvent()], "foreign_part"));
  it("A04 rejects a duplicate part", () =>
    rejects([partEvent(0), partEvent(0, 2), partEvent(2, 3), admissionEvent(4)], "duplicate_part"));
  it("A05 rejects a misordered part", () =>
    rejects([partEvent(1, 1), partEvent(0, 2), partEvent(2, 3), admissionEvent(4)], "misordered_part"));
  it("A06 rejects a short non-final part", () =>
    rejects(
      [partEvent(0, 1, { text: parts[0]!.slice(0, -1) }), partEvent(1), partEvent(2), admissionEvent()],
      "short_part",
    ));
  it("A07 rejects a digest mismatch", () =>
    rejects(
      [...parts.map((_, index) => partEvent(index)), admissionEvent(4, { digest: "0".repeat(64) })],
      "invalid_history_digest",
    ));
  it("A08 rejects a byte-count mismatch", () =>
    rejects(
      [...parts.map((_, index) => partEvent(index)), admissionEvent(4, { textBytes: bytes(multiText) - 1 })],
      "invalid_history_digest",
    ));
  it("A09 rejects an event after the admission", () =>
    rejects([...complete(), partEvent(0, parts.length + 2)], "event_after_admission"));
  it("A10 rejects an admission-only history", () => rejects([admissionEvent(1)], "invalid_history_parts"));
  it("A11 rejects parts without an admission", () =>
    rejects([partEvent(0), partEvent(1), partEvent(2)], "missing_admission"));
  it.each(a12Part)("%s", (_name, payload, expected) =>
    expect(errorCode(() => parsePartPayload(payload, multiRequest))).toBe(expected),
  );
  it.each(a12Admission)("%s", (_name, payload, expected) =>
    expect(errorCode(() => parseAdmissionPayload(payload, multiRequest))).toBe(expected),
  );
  it("A13 digest-skip mutant accepts a wrong-digest history that the real assembler rejects", async () => {
    const wrongDigest = [...parts.map((_, index) => partEvent(index)), admissionEvent(4, { digest: "0".repeat(64) })];
    const mutant = sourceMutant<typeof assembleAdmittedTcgplayerMarketObservationBatch>(
      [
        [
          `if (textBytes !== admitted.textBytes || digest !== admitted.digest) bad("invalid_history_digest");`,
          `if (false) bad("invalid_history_digest");`,
        ],
      ],
      "assembleAdmittedTcgplayerMarketObservationBatch",
    );
    await expect(mutant(wrongDigest, multiRequest)).resolves.toMatchObject({ requestId: RID });
    await rejects(wrongDigest, "invalid_history_digest");
  });
  it("A03 foreign-part bypass mutant is caught by the fixed code", async () => {
    const foreign = [partEvent(0, 1, { batchId: OTHER_BID }), partEvent(1), partEvent(2), admissionEvent()];
    const mutant = sourceMutant<typeof assembleAdmittedTcgplayerMarketObservationBatch>(
      [
        [
          `if (partEvents.some((event) => event.payload.batchId !== admitted.batchId)) bad("foreign_part");`,
          'if (false) bad("foreign_part");',
        ],
      ],
      "assembleAdmittedTcgplayerMarketObservationBatch",
    );
    await expect(mutant(foreign, multiRequest)).resolves.toMatchObject({ requestId: RID });
    await rejects(foreign, "foreign_part");
  });
});
