import type { OperatorEnvironment } from "../protocol";
import { collectSealedProducts, type SealedFetch, type SealedSelection, type SealedReceipt } from "./collector";
import { reduceSealedProducts } from "./reducer";
import type { SealedPost } from "./transport";
export async function runSealedProducts(input: {
  selection: SealedSelection;
  environment: OperatorEnvironment;
  request: SealedFetch;
  post: SealedPost;
  onReceipt?: (receipt: SealedReceipt) => void;
  now?: () => string;
}) {
  const { receipt, details } = await collectSealedProducts(input);
  const publish = () => input.onReceipt?.(structuredClone(receipt));
  if (receipt.verdict !== "complete") return { outcome: receipt.verdict, receipt };
  const posts = reduceSealedProducts(details, input.selection, (input.now ?? (() => new Date().toISOString()))());
  if (!posts) {
    receipt.verdict = "unqualified";
    publish();
    return { outcome: "unqualified", receipt };
  }
  receipt.sealedDetails = posts.reduce((count, post) => count + post.products.length, 0);
  publish();
  for (const post of posts) {
    try {
      const result = await input.post(input.environment, post);
      if (result.outcome !== "recorded") {
        publish();
        return { outcome: result.outcome, receipt };
      }
      receipt.posts++;
      for (const key of ["recorded", "changed", "unchanged", "candidateCount"] as const)
        receipt.catalog[key] += result[key];
      receipt.catalog.exclusions += result.exclusions.length;
      publish();
    } catch {
      return { outcome: "unavailable", receipt };
    }
  }
  return { outcome: "recorded", receipt };
}
