import { z } from "zod";
import { sealedProductLines, sealedRequestMaxProducts } from "./contract";
import { isSealedRequestResult, sealedRequestFailure, type SealedRequestResult } from "./request-result";

export { sealedProductLines } from "./contract";
export type SealedSelection = { productLineId: number; setId: number; setName: string };
export type SealedRequest =
  | { endpoint: "search"; productLineId: number; setName: string; from: number; includeProductLine: boolean }
  | { endpoint: "detail"; productId: number };
export type SealedFetch = (request: SealedRequest) => Promise<SealedRequestResult>;
export type SealedReceipt = {
  requests: {
    endpoint: "search" | "detail";
    status: number | null;
    contentClass: "json" | "non-json" | "unknown";
    bytes: number;
    code?: SealedRequestResult["code"];
  }[];
  totalResults: number | null;
  pages: number;
  summaries: number;
  sealedCandidates: number;
  sealedDetails: number;
  posts: number;
  catalog: { recorded: number; changed: number; unchanged: number; candidateCount: number; exclusions: number };
  verdict: "complete" | "incomplete" | "unqualified";
};
export const newSealedReceipt = (): SealedReceipt => ({
  requests: [],
  totalResults: null,
  pages: 0,
  summaries: 0,
  sealedCandidates: 0,
  sealedDetails: 0,
  posts: 0,
  catalog: { recorded: 0, changed: 0, unchanged: 0, candidateCount: 0, exclusions: 0 },
  verdict: "incomplete",
});
const id = z.number().int().min(1).max(2_147_483_647);
const summary = z.object({
  productId: id,
  productName: z.string(),
  productLineId: id,
  productLineName: z.string(),
  productTypeName: z.string().optional(),
  setId: id,
  setName: z.string(),
  setUrlName: z.string(),
  rarityName: z.string(),
  sealed: z.boolean(),
  productStatusId: id,
  customAttributes: z.object({
    number: z.string().optional(),
    releaseDate: z.string().optional(),
    cardType: z.array(z.string()).optional(),
  }),
});
const search = z.object({
  errors: z.array(z.unknown()).length(0),
  results: z
    .array(
      z.object({
        results: z.array(summary).max(24),
        totalResults: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        resultId: z.string(),
      }),
    )
    .length(1),
});
export const sealedCollectionLimits = {
  maxPages: 500,
  maxProducts: sealedRequestMaxProducts,
  maxDetailBytes: 16 * 1024 * 1024,
} as const;
export function validSealedSelection(selection: SealedSelection): boolean {
  return (
    sealedProductLines().some((line) => line.id === selection.productLineId) &&
    id.safeParse(selection.setId).success &&
    typeof selection.setName === "string" &&
    selection.setName.length > 0 &&
    selection.setName.length <= 512
  );
}
export async function collectSealedProducts(input: {
  selection: SealedSelection;
  request: SealedFetch;
  onReceipt?: (receipt: SealedReceipt) => void;
}) {
  const receipt = newSealedReceipt();
  const publish = () => input.onReceipt?.(structuredClone(receipt));
  const details: unknown[] = [];
  let detailBytes = 0;
  const line = sealedProductLines().find((line) => line.id === input.selection.productLineId);
  if (!validSealedSelection(input.selection) || !line) {
    receipt.verdict = "unqualified";
    publish();
    return { receipt, details };
  }
  async function request(request: SealedRequest) {
    let result: SealedRequestResult;
    try {
      const response = await input.request(request);
      result = isSealedRequestResult(response) ? response : sealedRequestFailure("invalid-response");
    } catch {
      result = sealedRequestFailure("unavailable");
    }
    const httpSuccess = result.status !== null && result.status >= 200 && result.status < 300;
    const success = result.ok && httpSuccess && result.contentClass === "json";
    const code = success
      ? undefined
      : (result.code ??
        (result.status === null
          ? "unavailable"
          : !httpSuccess
            ? "http-not-success"
            : result.contentClass === "non-json"
              ? "non-json"
              : "invalid-response"));
    receipt.requests.push({
      endpoint: request.endpoint,
      status: result.status,
      contentClass: result.contentClass,
      bytes: result.bytes,
      ...(code === undefined ? {} : { code }),
    });
    publish();
    return success ? result : null;
  }
  for (const includeProductLine of [true, false]) {
    const unique = new Set<number>();
    const candidates = new Set<number>();
    let total: number | null = null;
    for (let pageNumber = 0; ; pageNumber++) {
      if (receipt.pages >= sealedCollectionLimits.maxPages) {
        publish();
        return { receipt, details };
      }
      const result = await request({
        endpoint: "search",
        productLineId: line.id,
        setName: input.selection.setName,
        from: pageNumber * 24,
        includeProductLine,
      });
      if (!result) {
        receipt.verdict = "unqualified";
        publish();
        return { receipt, details };
      }
      const parsed = search.safeParse(result.body);
      if (!parsed.success) {
        receipt.requests.at(-1)!.code = "invalid-response";
        receipt.verdict = "unqualified";
        publish();
        return { receipt, details };
      }
      const page = parsed.data.results[0]!;
      receipt.pages++;
      if (total === null) {
        total = page.totalResults;
        receipt.totalResults = total;
      }
      if (page.totalResults !== total || total > sealedCollectionLimits.maxProducts) {
        publish();
        return { receipt, details };
      }
      const previous = unique.size;
      for (const product of page.results) {
        unique.add(product.productId);
        if (
          product.productLineId === line.id &&
          product.productLineName === line.name &&
          product.setId === input.selection.setId &&
          product.setName === input.selection.setName &&
          (product.sealed || /sealed|booster|bundle|deck/i.test(product.productTypeName ?? ""))
        )
          candidates.add(product.productId);
      }
      receipt.summaries = unique.size;
      publish();
      if (
        unique.size - previous !== page.results.length ||
        unique.size > total ||
        (unique.size < total && (page.results.length < 24 || previous === unique.size))
      )
        return { receipt, details };
      if (unique.size === total) break;
    }
    receipt.sealedCandidates = candidates.size;
    if (candidates.size === 0 && includeProductLine) continue;
    for (const productId of candidates) {
      const result = await request({ endpoint: "detail", productId });
      if (!result) {
        receipt.verdict = "unqualified";
        publish();
        return { receipt, details: [] };
      }
      detailBytes += result.bytes;
      if (detailBytes > sealedCollectionLimits.maxDetailBytes) {
        publish();
        return { receipt, details: [] };
      }
      // Identity and shape are checked by the reducer after the response receipt is emitted.
      details.push({ productId, body: result.body });
    }
    receipt.verdict = "complete";
    publish();
    return { receipt, details };
  }
  return { receipt, details };
}
