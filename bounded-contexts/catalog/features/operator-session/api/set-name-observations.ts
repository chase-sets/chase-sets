import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import { closed, operatorEnvironments, operatorOrigins, type OperatorEnvironment } from "../domain/extension/protocol";
import {
  setNameAnswerFailures,
  setNameRequestHeader,
  type SetNameAnswerFailure,
} from "../domain/extension/set-names/request";
import {
  parseTcgplayerSetNameObservationPost,
  tcgplayerSetNameObservationLimits,
  type TcgplayerSetNameEntry,
} from "../domain/extension/set-names/contract";
import { OperatorSessionRequestError, readBody } from "./request";

export type ObservationGrant = Readonly<{ grantId: string; creatorUserId: string; creatorMembershipId: string }>;

export type TcgplayerSetNameObservationResult = Readonly<{
  observationCount: number;
  newObservationCount: number;
  mappingsProposed: number;
}>;

export type TcgplayerSetNameObservationRecorder = (
  input: Readonly<{
    unitKey: string;
    productLineId: number;
    sets: readonly TcgplayerSetNameEntry[];
    provenance: ObservationGrant;
    context: EventStoreContext;
  }>,
  backend?: PgTransactionalPool,
  transaction?: PgQueryable,
) => Promise<TcgplayerSetNameObservationResult>;

export type TcgplayerSetNameRequestAnswer = (
  input: Readonly<{
    requestId: string;
    text: string;
    grant: ObservationGrant;
    environment: OperatorEnvironment;
    backend: PgTransactionalPool | undefined;
  }> &
    (
      | Readonly<{
          kind: "observations";
          productLineId: number;
          record: (db: PgQueryable) => Promise<TcgplayerSetNameObservationResult>;
        }>
      | Readonly<{ kind: "failure"; failure: SetNameAnswerFailure }>
    ),
) => Promise<TcgplayerSetNameObservationResult | null>;

export type TcgplayerSetNameObservationPostDeps = Readonly<{
  authorizeObservationGrant: (request: Request) => Promise<ObservationGrant>;
  record: TcgplayerSetNameObservationRecorder | undefined;
  serializeWrites: <T>(work: (backend?: PgTransactionalPool) => Promise<T>) => Promise<T>;
  answer?: TcgplayerSetNameRequestAnswer;
}>;

const headers = { "Cache-Control": "no-store" } as const;

function refusal(code: string, status: number): Response {
  return Response.json({ code }, { status, headers });
}

// Grant-authorized Catalog writes are platform-wide, so they use the platform system tenant and
// account; the audit user is the live grant creator. The bearer never leaves authorization.
export function operatorExtensionContext(grant: ObservationGrant): EventStoreContext {
  return {
    tenantId: "tnt_identity" as TenantId,
    audit: { performedByUserId: grant.creatorUserId as UserId, forAccountId: "acc_identity_system" as AccountId },
  };
}

// Order is the guard: the grant is authorized before the body is read, and the body is
// bounded and parsed before any observation-store read or write. Every refusal is a fixed code.
export function createTcgplayerSetNameObservationPost(deps: TcgplayerSetNameObservationPostDeps) {
  return async function postTcgplayerSetNameObservations(request: Request): Promise<Response> {
    const record = deps.record;
    if (!record) return refusal("scope-observations-unavailable", 503);

    let grant: ObservationGrant;
    try {
      grant = await deps.authorizeObservationGrant(request);
    } catch (error) {
      return error instanceof OperatorSessionRequestError
        ? refusal(error.code, error.status)
        : refusal("custody-unavailable", 503);
    }

    const requestId = request.headers.get(setNameRequestHeader);
    const environment =
      requestId === null
        ? undefined
        : operatorEnvironments.find((candidate) => operatorOrigins[candidate] === resolvePublicRequestOrigin(request));
    if (requestId !== null) {
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(requestId))
        return refusal("invalid-observation-request", 400);
      if (!environment) return refusal("environment-refused", 403);
      if (!deps.answer) return refusal("scope-observations-unavailable", 503);
    }

    let text: string;
    try {
      // A correlated answer must not lose bytes before its receipt digest is computed.
      text = await readBody(request, tcgplayerSetNameObservationLimits.maxPostBytes, {
        preserveByteOrderMark: requestId !== null,
      });
    } catch (error) {
      if (error instanceof OperatorSessionRequestError && error.code === "request-too-large")
        return refusal("body-too-large", 413);
      if (error instanceof OperatorSessionRequestError && error.code === "request-timeout")
        return refusal("request-timeout", 408);
      return refusal("invalid-body", 400);
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return refusal("invalid-body", 400);
    }
    try {
      const failure = closed(value, ["failure"]) && setNameAnswerFailures.find((code) => code === value.failure);
      if (failure && requestId && environment && deps.answer) {
        const result = await deps.serializeWrites((backend) =>
          deps.answer!({
            kind: "failure",
            failure,
            requestId,
            text,
            grant,
            environment,
            backend,
          }),
        );
        return result ? Response.json(result, { headers }) : refusal("observation-request-closed", 409);
      }
      const parsed = parseTcgplayerSetNameObservationPost(value);
      if (!parsed.ok) return refusal(parsed.code, parsed.code === "product-line-unsupported" ? 422 : 400);
      const observation = {
        unitKey: parsed.unitKey,
        productLineId: parsed.post.productLineId,
        sets: parsed.post.sets,
        provenance: grant,
        context: operatorExtensionContext(grant),
      };
      const result = await deps.serializeWrites((backend) => {
        if (requestId && environment && deps.answer) {
          return deps.answer({
            kind: "observations",
            productLineId: observation.productLineId,
            requestId,
            text,
            grant,
            environment,
            backend,
            record: (db) => record(observation, backend, db),
          });
        }
        return record(observation, backend);
      });
      if (!result) return refusal("observation-request-closed", 409);
      return Response.json(
        {
          observationCount: result.observationCount,
          newObservationCount: result.newObservationCount,
          mappingsProposed: result.mappingsProposed,
        },
        { headers },
      );
    } catch (error) {
      return error instanceof OperatorSessionRequestError
        ? refusal(error.code, error.status)
        : refusal("scope-observations-unavailable", 503);
    }
  };
}
