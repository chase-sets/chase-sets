import type { OperatorObservationRequest } from "../protocol";
import { tcgplayerSetNameUnitKeyForProductLineId } from "./contract";
import type { SetNamesRequest } from "./probe";
import { reduceTcgplayerSetNames } from "./reducer";

export const setNameRequestHeader = "X-Catalog-Observation-Request-V2";
export const setNameAnswerFailures = ["provider-request-failed", "provider-response-unqualified"] as const;
export type SetNameAnswerFailure = (typeof setNameAnswerFailures)[number];

export function createSetNamesObservationDispatcher(fetchSetNames: SetNamesRequest) {
  return async (request: OperatorObservationRequest, post: (body: string) => Promise<void>) => {
    if (request.kind !== "set-names" || !tcgplayerSetNameUnitKeyForProductLineId(request.productLineId)) return;
    const result = await fetchSetNames(String(request.productLineId)).catch(() => null);
    const reduction = result && reduceTcgplayerSetNames(result, request.productLineId, new Date().toISOString());
    const answer =
      reduction?.outcome === "qualified"
        ? reduction.post
        : {
            failure: !result?.ok ? "provider-request-failed" : "provider-response-unqualified",
          };
    await post(JSON.stringify(answer));
  };
}
