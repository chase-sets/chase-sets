import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createTcgplayerSealedProductObservationPost,
  type TcgplayerSealedProductObservationRecorder,
} from "../api/sealed-product-observations";
import { OperatorSessionRequestError } from "../api/request";
import {
  parseTcgplayerSealedProductObservationPost,
  tcgplayerSealedProductObservationLimits,
} from "../domain/extension/sealed-products/contract";
import {
  buildTcgplayerAutomationSourceObservationPayload,
  tcgplayerSealedProductUnitKeyForLine,
} from "../../source-observations/api/providers/tcgplayer/adapter";
import { staticCatalogProviderIntegrationProfileVersions } from "../../source-observations/api/source-observation-runtime-contracts";
import { requireSourceObservationMappingContract } from "../../source-observations/api/source-observation-promotion-execution";
import { requireCatalogProviderSourceObservation } from "../../source-observations/api/promotion/provider-source-observation-normalizer";
import { provenance } from "./set-name-observation-fixture";
import {
  salvage,
  sealedDetail,
  sealedPost,
  sealedRequest,
  sealedPartHeaders,
} from "./sealed-product-observation-fixture";
import { operatorOrigins } from "../domain/extension/protocol";

afterEach(() => vi.useRealTimers());
function harness() {
  const record = vi
    .fn<TcgplayerSealedProductObservationRecorder>()
    .mockResolvedValue({ recorded: 1, changed: 0, unchanged: 0, candidateCount: 0, exclusions: [] });
  const authorize = vi.fn().mockResolvedValue(provenance);
  const answer = vi.fn(async () => ({ kind: "part" as const, partIndex: 0 }));
  const serializeWrites = vi.fn();
  const serialize = async <T>(work: () => Promise<T>): Promise<T> => {
    serializeWrites();
    return work();
  };
  return {
    record,
    authorize,
    answer,
    serializeWrites,
    post: createTcgplayerSealedProductObservationPost({
      authorizeObservationGrant: authorize,
      record,
      answer,
      serializeWrites: serialize,
    }),
  };
}

describe("sealed product salvage parity", () => {
  it.each(salvage.cases)(
    "retains $unitKey identity, hash, profile, fingerprint and normalized facts",
    async (entry) => {
      expect(salvage.commit).toBe("e88692696a1fab8a65870c25ba5d64ce6b47eb80");
      const parsed = parseTcgplayerSealedProductObservationPost({ ...sealedPost(), products: [entry.detail] });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error("fixture-invalid");
      expect(tcgplayerSealedProductUnitKeyForLine(entry.detail.productLineName)).toBe(entry.unitKey);
      const profile = (await staticCatalogProviderIntegrationProfileVersions.listProfileVersions("tcgplayer")).find(
        (version) =>
          version.profileVersion === entry.expected.sourceProfileVersion &&
          version.profileKey === entry.expected.sourceProfileKey,
      )!;
      const payload = buildTcgplayerAutomationSourceObservationPayload({
        detail: parsed.post.products[0]!,
        externalReferenceRules: profile.profile.externalReferenceExtractionRules.rules,
        selectedOptionMapping: profile.profile.selectedOptionMapping!,
      });
      const { sourceUrl, ...actual } = requireCatalogProviderSourceObservation({
        contract: requireSourceObservationMappingContract(profile),
        payload,
        observedAt: sealedPost().observedAt,
      });
      expect(
        JSON.parse(
          JSON.stringify({ ...actual, sourceUrlSha256: createHash("sha256").update(sourceUrl).digest("hex") }),
        ),
      ).toEqual(entry.expected);
    },
  );
});

type Mutant = (body: ReturnType<typeof sealedPost>) => unknown;
const mutants: readonly [string, Mutant][] = [
  ["unknown post key", (p) => ({ ...p, extra: true })],
  ["wrong version", (p) => ({ ...p, contractVersion: 2 })],
  [
    "missing field",
    (p) => {
      delete (p as Partial<typeof p>).observedAt;
      return p;
    },
  ],
  ["unknown product key", (p) => ({ ...p, products: [{ ...p.products[0], extra: true }] })],
  ["price", (p) => ({ ...p, products: [{ ...p.products[0], marketPrice: 1 }] })],
  ["nested price", (p) => ({ ...p, products: [{ ...p.products[0], customAttributes: { marketPrice: 1 } }] })],
  [
    "unknown SKU key",
    (p) => {
      Object.assign(p.products[0]!.skus[0]!, { extra: true });
      return p;
    },
  ],
  [
    "unknown formatted key",
    (p) => {
      p.products[0]!.formattedAttributes = { extra: true } as never;
      return p;
    },
  ],
  [
    "single",
    (p) => {
      p.products[0]!.sealed = false as never;
      return p;
    },
  ],
  [
    "mixed set names",
    (p) => {
      p.products.push({ ...sealedDetail(), productId: 2, setName: "Other" });
      return p;
    },
  ],
  [
    "mixed line",
    (p) => {
      p.products.push({ ...sealedDetail(), productId: 2, productLineName: "Pokemon" });
      return p;
    },
  ],
  ["zero products", (p) => ({ ...p, products: [] })],
  [
    "25 products",
    (p) => ({ ...p, products: Array.from({ length: 25 }, (_, i) => ({ ...sealedDetail(), productId: i + 1 })) }),
  ],
  [
    "zero SKUs",
    (p) => {
      p.products[0]!.skus = [];
      return p;
    },
  ],
  [
    "251 SKUs",
    (p) => {
      p.products[0]!.skus = Array.from({ length: 251 }, (_, i) => ({ ...sealedDetail().skus[0]!, sku: i + 1 }));
      return p;
    },
  ],
  [
    "duplicate products",
    (p) => {
      p.products.push(sealedDetail());
      return p;
    },
  ],
  [
    "duplicate SKUs",
    (p) => {
      p.products[0]!.skus.push({ ...p.products[0]!.skus[0]! });
      return p;
    },
  ],
  [
    "zero id",
    (p) => {
      p.products[0]!.productId = 0;
      return p;
    },
  ],
  [
    "large set id",
    (p) => {
      p.products[0]!.setId = 2_147_483_648;
      return p;
    },
  ],
  [
    "fractional id",
    (p) => {
      p.products[0]!.productLineId = 1.5;
      return p;
    },
  ],
  [
    "long label",
    (p) => {
      p.products[0]!.productName = "x".repeat(257);
      return p;
    },
  ],
  [
    "empty label",
    (p) => {
      p.products[0]!.setName = "";
      return p;
    },
  ],
  [
    "control label",
    (p) => {
      p.products[0]!.productName = "x\u0000";
      return p;
    },
  ],
  [
    "non-digit barcode",
    (p) => {
      p.products[0]!.barcode = "12x";
      return p;
    },
  ],
  [
    "nested barcode",
    (p) => {
      p.products[0]!.customAttributes.gtin = "12x";
      return p;
    },
  ],
  [
    "negative pack count",
    (p) => {
      p.products[0]!.customAttributes.packCount = -1;
      return p;
    },
  ],
  ["bad time", (p) => ({ ...p, observedAt: "2026-02-30T00:00:00.000Z" })],
  ["non-ms time", (p) => ({ ...p, observedAt: "2026-01-01T00:00:00Z" })],
];
describe("sealed product post fail-closed guards", () => {
  it.each(mutants)("refuses %s alone without entering the writer", async (_name, mutate) => {
    const h = harness();
    const response = await h.post(sealedRequest(mutate(sealedPost())));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "invalid-body" });
    expect(h.record).not.toHaveBeenCalled();
    expect(h.serializeWrites).not.toHaveBeenCalled();
  });
  it("authorizes before reading even when recording is unavailable", async () => {
    const request = sealedRequest(sealedPost());
    const read = vi.spyOn(request.body!, "getReader");
    const h = harness();
    h.authorize.mockRejectedValue(new OperatorSessionRequestError("grant-invalid", 401));
    expect((await h.post(request)).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    const unavailable = createTcgplayerSealedProductObservationPost({
      authorizeObservationGrant: h.authorize,
      record: undefined,
      serializeWrites: (work) => work(),
    });
    expect((await unavailable(sealedRequest(sealedPost()))).status).toBe(401);
  });
  it("admits a correlated part and refuses uncorrelated writes without reading the body", async () => {
    const h = harness();
    const accepted = await h.post(sealedRequest(sealedPost()));
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    const refused = harness();
    const request = new Request(operatorOrigins.staging, { method: "POST", body: JSON.stringify(sealedPost()) });
    const read = vi.spyOn(request.body!, "getReader");
    const response = await refused.post(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "invalid-observation-request" });
    expect(read).not.toHaveBeenCalled();
    expect(refused.answer).not.toHaveBeenCalled();
    expect(refused.record).not.toHaveBeenCalled();
  });
  it("enforces cap+1 and a schema-valid maximum-shape post above 2 MiB", async () => {
    const cap = tcgplayerSealedProductObservationLimits.maxPostBytes;
    const text = JSON.stringify(sealedPost());
    const atCap = text + " ".repeat(cap - Buffer.byteLength(text));
    expect((await harness().post(sealedRequest(atCap))).status).toBe(200);
    const wide = sealedPost();
    wide.products = Array.from({ length: 24 }, (_, i) => ({
      ...sealedDetail(),
      productId: i + 1,
      skus: Array.from({ length: 250 }, (_, j) => ({
        sku: j + 1,
        condition: "x".repeat(256),
        variant: "x".repeat(256),
        language: "x".repeat(256),
      })),
    }));
    expect(parseTcgplayerSealedProductObservationPost(wide).ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(wide))).toBeGreaterThan(cap);
    for (const body of [atCap + " ", JSON.stringify(wide)]) {
      const h = harness();
      const response = await h.post(sealedRequest(body));
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ code: "body-too-large" });
      expect(h.record).not.toHaveBeenCalled();
    }
  });
  it("ends an endless body at the unchanged read deadline", async () => {
    vi.useFakeTimers();
    const h = harness();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("{"));
      },
      cancel() {
        return new Promise(() => {});
      },
    });
    const request = new Request(operatorOrigins.staging, {
      method: "POST",
      headers: sealedPartHeaders,
      body,
      duplex: "half",
    } as RequestInit);
    const pending = h.post(request);
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await pending;
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ code: "request-timeout" });
    expect(h.record).not.toHaveBeenCalled();
  });
});
