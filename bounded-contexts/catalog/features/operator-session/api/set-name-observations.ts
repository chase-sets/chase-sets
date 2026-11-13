import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
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
) => Promise<TcgplayerSetNameObservationResult>;

export type TcgplayerSetNameObservationPostDeps = Readonly<{
  authorizeObservationGrant: (request: Request) => Promise<ObservationGrant>;
  record: TcgplayerSetNameObservationRecorder | undefined;
  serializeWrites: <T>(work: () => Promise<T>) => Promise<T>;
}>;

const headers = { "Cache-Control": "no-store" } as const;

function refusal(code: string, status: number): Response {
  return Response.json({ code }, { status, headers });
}

// Grant-authorized Catalog writes are platform-wide, so they use the platform system tenant and
// account; the audit user is the live grant creator. The bearer never leaves authorization.
function operatorExtensionContext(grant: ObservationGrant): EventStoreContext {
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

    let text: string;
    try {
      text = await readBody(request, tcgplayerSetNameObservationLimits.maxPostBytes);
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
    const parsed = parseTcgplayerSetNameObservationPost(value);
    if (!parsed.ok) return refusal(parsed.code, parsed.code === "product-line-unsupported" ? 422 : 400);

    try {
      const result = await deps.serializeWrites(() =>
        record({
          unitKey: parsed.unitKey,
          productLineId: parsed.post.productLineId,
          sets: parsed.post.sets,
          provenance: grant,
          context: operatorExtensionContext(grant),
        }),
      );
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
