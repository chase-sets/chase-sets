import { closed, isEnvironment, safeInteger, type OperatorEnvironment } from "../protocol";
import {
  parseTcgplayerSealedProductObservationPost,
  tcgplayerSealedProductObservationLimits,
  type TcgplayerSealedProductObservationPost,
} from "./contract";
import { sealedProductLines } from "./collector";
export type SealedPostResult =
  | {
      outcome: "recorded";
      recorded: number;
      changed: number;
      unchanged: number;
      candidateCount: number;
      exclusions: { productId: number; code: string }[];
    }
  | { outcome: "grant-invalid" | "unavailable" | "refused" | "invalid-response" };
export type SealedPost = (
  environment: OperatorEnvironment,
  post: TcgplayerSealedProductObservationPost,
) => Promise<SealedPostResult>;
export type SealedPostMessage = {
  action: "post-sealed-products";
  environment: OperatorEnvironment;
  post: TcgplayerSealedProductObservationPost;
};
export function isSealedPostMessage(value: unknown): value is SealedPostMessage {
  if (
    !closed(value, ["action", "environment", "post"]) ||
    value.action !== "post-sealed-products" ||
    !isEnvironment(value.environment)
  )
    return false;
  const parsed = parseTcgplayerSealedProductObservationPost(value.post);
  return (
    parsed.ok &&
    parsed.post.products.every((product) =>
      sealedProductLines().some((line) => line.id === product.productLineId && line.name === product.productLineName),
    ) &&
    new TextEncoder().encode(JSON.stringify(value.post)).byteLength <=
      tcgplayerSealedProductObservationLimits.maxPostBytes
  );
}
export function isSealedPostResult(value: unknown): value is SealedPostResult {
  if (closed(value, ["outcome"]))
    return ["grant-invalid", "unavailable", "refused", "invalid-response"].includes(String(value.outcome));
  return (
    closed(value, ["outcome", "recorded", "changed", "unchanged", "candidateCount", "exclusions"]) &&
    value.outcome === "recorded" &&
    safeInteger(value.recorded) &&
    safeInteger(value.changed) &&
    safeInteger(value.unchanged) &&
    safeInteger(value.candidateCount) &&
    Array.isArray(value.exclusions) &&
    value.exclusions.every(
      (entry) => closed(entry, ["productId", "code"]) && safeInteger(entry.productId) && typeof entry.code === "string",
    )
  );
}
