import { tcgplayerSetNameProductLineIds } from "./contract";
import type { TcgplayerSetNameEntry } from "./contract";
import type { OperatorEnvironment } from "../protocol";
import type { SetNamesReceipt, SetNamesRequest } from "./probe";
import { reduceTcgplayerSetNames, type SetNamesReduction } from "./reducer";
import type { SetNamesPost, SetNamesPostResult } from "./transport";

export type SetNamesRunResult = SetNamesPostResult | Exclude<SetNamesReduction, { outcome: "qualified" }>;

export async function runTcgplayerSetNames(input: {
  productLineId: number;
  environment: OperatorEnvironment;
  request: SetNamesRequest;
  post: SetNamesPost;
  now?: () => string;
  onReceipt?: (receipt: SetNamesReceipt) => void;
  onSets?: (productLineId: number, sets: readonly TcgplayerSetNameEntry[]) => void;
}): Promise<SetNamesRunResult> {
  if (!tcgplayerSetNameProductLineIds.includes(input.productLineId)) return { outcome: "refused" };
  try {
    const result = await input.request(String(input.productLineId));
    const observedAt = (input.now ?? (() => new Date().toISOString()))();
    const reduced = reduceTcgplayerSetNames(result, input.productLineId, observedAt, input.onReceipt);
    if (reduced.outcome === "unqualified") return reduced;
    input.onSets?.(input.productLineId, reduced.post.sets);
    return await input.post(input.environment, reduced.post);
  } catch {
    return { outcome: "unavailable" };
  }
}
