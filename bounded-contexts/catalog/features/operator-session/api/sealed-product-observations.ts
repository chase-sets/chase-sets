import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  parseTcgplayerSealedProductObservationPost,
  tcgplayerSealedProductObservationLimits,
  type TcgplayerSealedProductObservationPost,
} from "../domain/extension/sealed-products/contract";
import { tcgplayerSealedProductUnitKeyForLine } from "../../source-observations/api/providers/tcgplayer/adapter";
import { OperatorSessionRequestError, readBody } from "./request";
import { operatorExtensionContext, type ObservationGrant } from "./set-name-observations";

export type TcgplayerSealedProductObservationResult = Readonly<{
  recorded: number;
  changed: number;
  unchanged: number;
  candidateCount: number;
  exclusions: readonly Readonly<{ productId: number; code: string }>[];
}>;
export type TcgplayerSealedProductObservationRecorder = (
  input: Readonly<{
    post: TcgplayerSealedProductObservationPost;
    unitKey: string;
    provenance: ObservationGrant;
    context: EventStoreContext;
  }>,
  backend?: PgTransactionalPool,
) => Promise<TcgplayerSealedProductObservationResult>;

// Issue: https://github.com/chase-sets/chase-sets/issues/10040
export function createTcgplayerSealedProductObservationPost(
  deps: Readonly<{
    authorizeObservationGrant: (request: Request) => Promise<ObservationGrant>;
    record: TcgplayerSealedProductObservationRecorder | undefined;
    serializeWrites: <T>(work: (backend?: PgTransactionalPool) => Promise<T>) => Promise<T>;
  }>,
) {
  const headers = { "Cache-Control": "no-store" };
  const refusal = (code: string, status: number) => Response.json({ code }, { status, headers });
  return async (request: Request): Promise<Response> => {
    let grant: ObservationGrant;
    try {
      grant = await deps.authorizeObservationGrant(request);
    } catch (error) {
      return error instanceof OperatorSessionRequestError
        ? refusal(error.code, error.status)
        : refusal("custody-unavailable", 503);
    }
    let value: unknown;
    try {
      value = JSON.parse(await readBody(request, tcgplayerSealedProductObservationLimits.maxPostBytes));
    } catch (error) {
      if (error instanceof OperatorSessionRequestError && error.code === "request-too-large")
        return refusal("body-too-large", 413);
      if (error instanceof OperatorSessionRequestError && error.code === "request-timeout")
        return refusal("request-timeout", 408);
      return refusal("invalid-body", 400);
    }
    const parsed = parseTcgplayerSealedProductObservationPost(value);
    if (!parsed.ok) return refusal(parsed.code, 400);
    const unitKey = tcgplayerSealedProductUnitKeyForLine(parsed.post.products[0]!.productLineName);
    if (!unitKey) return refusal("unit-unsupported", 422);
    const record = deps.record;
    if (!record) return refusal("source-observations-unavailable", 503);
    try {
      const result = await deps.serializeWrites((backend) =>
        record(
          {
            post: parsed.post,
            unitKey,
            provenance: grant,
            context: operatorExtensionContext(grant),
          },
          backend,
        ),
      );
      return Response.json(result, { headers });
    } catch (error) {
      return error instanceof OperatorSessionRequestError
        ? refusal(error.code, error.status)
        : refusal("source-observations-unavailable", 503);
    }
  };
}
