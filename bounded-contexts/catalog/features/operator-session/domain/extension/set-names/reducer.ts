import { closed } from "../protocol";
import {
  parseTcgplayerSetNameObservationPost,
  tcgplayerSetNameObservationLimits,
  type TcgplayerSetNameObservationPost,
} from "./contract";
import { createSetNamesReceipt, type SetNamesReceipt, type SetNamesRequestResult } from "./probe";

export type SetNamesReduction =
  | { outcome: "qualified"; post: TcgplayerSetNameObservationPost; receipt: SetNamesReceipt }
  | {
      outcome: "unqualified";
      code: "response-unqualified" | "invalid-body" | "product-line-unsupported" | "body-too-large";
      receipt: SetNamesReceipt;
    };

export function reduceTcgplayerSetNames(
  result: SetNamesRequestResult,
  productLineId: number,
  observedAt: string,
  onReceipt?: (receipt: SetNamesReceipt) => void,
): SetNamesReduction {
  const receipt = createSetNamesReceipt(result, String(productLineId));
  onReceipt?.(receipt);
  if (
    !result.ok ||
    result.status === null ||
    result.status < 200 ||
    result.status >= 300 ||
    result.contentClass !== "json"
  )
    return { outcome: "unqualified", code: "response-unqualified", receipt };
  const body = result.body;
  if (!closed(body, ["errors", "results"]) || !Array.isArray(body.errors) || body.errors.length !== 0)
    return { outcome: "unqualified", code: "invalid-body", receipt };
  const parsed = parseTcgplayerSetNameObservationPost({
    contractVersion: 1,
    productLineId,
    observedAt,
    sets: body.results,
  });
  if (!parsed.ok) return { outcome: "unqualified", code: parsed.code, receipt };
  if (new TextEncoder().encode(JSON.stringify(parsed.post)).byteLength > tcgplayerSetNameObservationLimits.maxPostBytes)
    return { outcome: "unqualified", code: "body-too-large", receipt };
  return { outcome: "qualified", post: parsed.post, receipt };
}
