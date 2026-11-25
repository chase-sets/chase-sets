import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import {
  tcgplayerSealedProductObservationLimits,
  type TcgplayerSealedProductObservationPost,
} from "../domain/extension/sealed-products/contract";
import {
  parseSealedAnswer,
  sealedPartHeader,
  type SealedAnswer,
} from "../domain/extension/sealed-products/answer-contract";
import { operatorEnvironments, operatorOrigins, type OperatorEnvironment } from "../domain/extension/protocol";
import { setNameRequestHeader } from "../domain/extension/set-names/request";
import type { ProviderScopeMappingRow } from "../../provider-scope-mapping/read-model/queries";
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
    scopeMapping?: ProviderScopeMappingRow;
  }>,
  backend?: PgTransactionalPool,
  transaction?: PgQueryable,
) => Promise<TcgplayerSealedProductObservationResult>;

export type SealedAnswerReceipt =
  | Readonly<{ kind: "part"; partIndex: number }>
  | Readonly<
      { kind: "complete"; productCount: number; verifiedEmpty: boolean } & TcgplayerSealedProductObservationResult
    >
  | Readonly<{
      kind: "failure";
      code: Extract<SealedAnswer, { kind: "failure" }>["code"];
      endpointCode: string | null;
    }>;

export type TcgplayerSealedRequestAnswer = (input: {
  requestId: string;
  text: string;
  grant: ObservationGrant;
  environment: OperatorEnvironment;
  answer: SealedAnswer;
  backend?: PgTransactionalPool;
  record: (
    db: PgQueryable,
    post: TcgplayerSealedProductObservationPost,
    mapping: ProviderScopeMappingRow,
  ) => Promise<TcgplayerSealedProductObservationResult>;
}) => Promise<SealedAnswerReceipt | null>;

// Issue: https://github.com/chase-sets/chase-sets/issues/10040
export function createTcgplayerSealedProductObservationPost(
  deps: Readonly<{
    authorizeObservationGrant: (request: Request) => Promise<ObservationGrant>;
    record: TcgplayerSealedProductObservationRecorder | undefined;
    answer?: TcgplayerSealedRequestAnswer;
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
    const requestId = request.headers.get(setNameRequestHeader);
    if (!requestId || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(requestId))
      return refusal("invalid-observation-request", 400);
    const environment = operatorEnvironments.find(
      (key) => operatorOrigins[key] === resolvePublicRequestOrigin(request),
    );
    if (!environment) return refusal("environment-refused", 403);
    const { record, answer } = deps;
    if (!record || !answer) return refusal("source-observations-unavailable", 503);
    const part = request.headers.get(sealedPartHeader);
    let text: string;
    let parsed: SealedAnswer | null;
    try {
      text = await readBody(request, part === null ? 36_000 : tcgplayerSealedProductObservationLimits.maxPostBytes, {
        preserveByteOrderMark: true,
      });
      parsed = parseSealedAnswer(JSON.parse(text), part);
    } catch (error) {
      if (error instanceof OperatorSessionRequestError && error.code === "request-too-large")
        return refusal("body-too-large", 413);
      if (error instanceof OperatorSessionRequestError && error.code === "request-timeout")
        return refusal("request-timeout", 408);
      return refusal("invalid-body", 400);
    }
    if (!parsed) return refusal("invalid-body", 400);
    try {
      const result = await deps.serializeWrites((backend) =>
        answer({
          requestId,
          text,
          grant,
          environment,
          answer: parsed,
          backend,
          record: (db, post, scopeMapping) =>
            record(
              {
                post,
                unitKey: scopeMapping.unit_key,
                scopeMapping,
                provenance: grant,
                context: operatorExtensionContext(grant),
              },
              backend,
              db,
            ),
        }),
      );
      return result ? Response.json(result, { headers }) : refusal("observation-request-closed", 409);
    } catch (error) {
      return error instanceof OperatorSessionRequestError
        ? refusal(error.code, error.status)
        : refusal("source-observations-unavailable", 503);
    }
  };
}
