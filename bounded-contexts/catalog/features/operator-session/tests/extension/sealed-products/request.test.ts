import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createSealedObservationDispatcher } from "../../../domain/extension/sealed-products/request";
import { parseSealedAnswer } from "../../../domain/extension/sealed-products/answer-contract";
import { detail, page, response, selection } from "./fixture";

const coordinates = selection();
const offer = () => ({
  kind: "sealed-products" as const,
  requestId: "synthetic",
  productLineId: coordinates.productLineId,
  setNameId: coordinates.setId,
  searchName: coordinates.setName,
  expiresAt: new Date(Date.now() + 240_000).toISOString(),
});

it("indexes and digests reduced bytes before sealing exactly one complete set", async () => {
  const dispatch = createSealedObservationDispatcher(async (request) =>
    response(
      request.endpoint === "search" ? page(0, 1) : { ...detail(), productId: request.productId, marketPrice: 10 },
    ),
  );
  const upload = vi.fn<(body: string, index?: number) => Promise<boolean>>().mockResolvedValue(true);
  await dispatch(offer(), upload, () => true);
  expect(upload).toHaveBeenCalledTimes(2);
  const [part, index] = upload.mock.calls[0]!;
  const [manifest, noIndex] = upload.mock.calls[1]!;
  expect(index).toBe(0);
  expect(noIndex).toBeUndefined();
  expect(part).not.toMatch(/price/i);
  expect(parseSealedAnswer(JSON.parse(part), String(index))).toMatchObject({ kind: "part", partIndex: 0 });
  expect(parseSealedAnswer(JSON.parse(manifest), null)).toEqual({
    kind: "complete",
    verifiedEmpty: false,
    productCount: 1,
    partDigests: [createHash("sha256").update(part).digest("hex")],
  });
  upload.mockClear().mockResolvedValue(false);
  await dispatch(offer(), upload, () => true);
  expect(upload).toHaveBeenCalledTimes(1);
});

it("distinguishes verified empty from an incomplete or cross-set answer", async () => {
  const upload = vi.fn<(body: string, index?: number) => Promise<boolean>>().mockResolvedValue(true);
  await createSealedObservationDispatcher(async () => response(page(0, 0)))(offer(), upload, () => true);
  expect(upload).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({
      kind: "complete",
      partDigests: [],
      productCount: 0,
      verifiedEmpty: true,
    }),
  );
  upload.mockClear();
  await createSealedObservationDispatcher(async (request) =>
    response(request.endpoint === "search" ? page(0, 1) : { ...detail(), productId: request.productId, setId: 999 }),
  )(offer(), upload, () => true);
  expect(upload).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({
      kind: "failure",
      code: "provider-response-unqualified",
      endpointCode: null,
    }),
  );
  upload.mockClear();
  await createSealedObservationDispatcher(async () => response(page(0, 12_001)))(offer(), upload, () => true);
  expect(upload).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({
      kind: "failure",
      code: "provider-collection-incomplete",
      endpointCode: null,
    }),
  );
});
