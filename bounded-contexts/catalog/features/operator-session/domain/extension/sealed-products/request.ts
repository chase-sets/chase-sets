import type { OperatorObservationRequest } from "../protocol";
import { collectSealedProducts, type SealedFetch } from "./collector";
import { sealedAnswerLimits, type SealedAnswer } from "./answer-contract";
import { reduceSealedProducts } from "./reducer";
import { sealedRequestFailure } from "./request-result";

export type SealedAnswerUpload = (body: string, partIndex?: number) => Promise<boolean>;

async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createSealedObservationDispatcher(fetchSealed: SealedFetch) {
  return async (request: OperatorObservationRequest, upload: SealedAnswerUpload, current: () => boolean) => {
    if (request.kind !== "sealed-products") return;
    const selection = { productLineId: request.productLineId, setId: request.setNameId, setName: request.searchName };
    const stopAt = Math.min(Date.now() + 4 * 60_000, Date.parse(request.expiresAt) - 20_000);
    const { receipt, details } = await collectSealedProducts({
      selection,
      request: (input) =>
        current() && Date.now() < stopAt ? fetchSealed(input) : Promise.resolve(sealedRequestFailure("timeout")),
    });
    const posts =
      receipt.verdict === "complete" && Date.now() < stopAt
        ? reduceSealedProducts(details, selection, new Date().toISOString())
        : null;
    const endpointCode = receipt.requests.at(-1)?.code ?? null;
    const incomplete = !current() || Date.now() >= stopAt || receipt.verdict === "incomplete";
    const uploadFailure = (code: Extract<SealedAnswer, { kind: "failure" }>["code"]) =>
      upload(JSON.stringify({ kind: "failure", code, endpointCode }));
    if (!posts) {
      await uploadFailure(
        incomplete
          ? "provider-collection-incomplete"
          : endpointCode && endpointCode !== "invalid-response"
            ? "provider-request-failed"
            : "provider-response-unqualified",
      );
      return;
    }
    const bodies = posts.map((post) => JSON.stringify(post));
    const bytes = bodies.map((body) => new TextEncoder().encode(body));
    if (
      bodies.length > sealedAnswerLimits.maxParts ||
      bytes.reduce((sum, body) => sum + body.byteLength, 0) > sealedAnswerLimits.maxBytes
    ) {
      await uploadFailure("provider-collection-incomplete");
      return;
    }
    const partDigests = await Promise.all(bytes.map(sha256));
    for (const [index, body] of bodies.entries()) if (!(await upload(body, index))) return;
    await upload(
      JSON.stringify({
        kind: "complete",
        partDigests,
        productCount: posts.reduce((count, post) => count + post.products.length, 0),
        verifiedEmpty: posts.length === 0,
      }),
    );
  };
}
